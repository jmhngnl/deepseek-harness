---
description: "Five engineering problems MedHarness had to solve, each written as problem, solution, implementation, and payoff — domain modeling, event sourcing, multimodal attachment grounding, uncontrolled-generation risk, and trajectory-level evaluation."
---

# MedHarness engineering design

English | [中文](medharness-engineering-design.zh.md)

## Summary

This page records five problems that a medical intake agent on a general-purpose agent runtime actually runs into, and what the code does about each. Every claim here is backed by a package in `packages/medical`; nothing is aspirational. Read [the architecture page](medharness-architecture.md) first for the runtime seam.

## Table of Contents

- [1. Medical domain modeling](#1-medical-domain-modeling)
- [2. Event sourcing](#2-event-sourcing)
- [3. Multimodal attachment grounding](#3-multimodal-attachment-grounding)
- [4. Reducing uncontrolled generation risk](#4-reducing-uncontrolled-generation-risk)
- [5. Agent reliability evaluation](#5-agent-reliability-evaluation)
- [Dev Note](#dev-note)

-----

<a id="1-medical-domain-modeling"></a>
## 1. Medical domain modeling

### Problem

The obvious place to keep a patient's case is the conversation. The model already sees it, the user already typed it, and no extra machinery is needed. That is also the worst place to keep it.

An LLM message is prose. It has no schema, so nothing can be validated. It is re-derived from a growing transcript on every request, so a compaction or a truncation silently drops facts. It is one flat sequence, so "what is the patient's age" is a search problem rather than a lookup. And it is model-authored text as often as it is user-authored text, so the record and the model's summary of the record can drift apart with nothing to arbitrate.

For a medical intake specifically, that drift is the whole risk: the agent's job is to *not* invent facts, and a prose transcript gives it no way to prove it did not.

### Solution

Two durable domains, separated by who is speaking.

| Domain | Records | Service | Event |
|---|---|---|---|
| `medical-case` | What the **patient** stated | `ctx.medicalCase` | `medical/case-change` |
| `medical-image` | What the **model** observed | `ctx.medicalImage` | `medical/image-observation` |

The separation is the point, not an implementation detail. A visible finding and a reported symptom are different kinds of evidence with different reliability and different provenance, and a system that stores them in one place will eventually let one become the other. Here the two domains own different events, are folded by different projections, and are served by different services. Nothing in the image path can write a case field.

### Implementation

The case is a value with a monotonic revision:

```ts
import type { CaseOperation, CaseState } from '@deepseek-ai/dsh-medical-case'

export interface MedicalCaseSnapshotChange {
  readonly kind: 'medical/case-change'
  readonly version: 1
  readonly operation: CaseOperation
  readonly case: CaseState
}
```

Every event carries the **complete post-mutation state**, never a delta. A projection that reads only the latest record already holds the authoritative case, so last-wins replay and strict replay agree by construction.

The read model adds one derived field:

```ts
import type { CaseState, MissingField } from '@deepseek-ai/dsh-medical-case'

export interface CaseView extends CaseState {
  readonly missingFields: MissingField[]
}
```

`missingFields` is computed from the current state on every read and is never persisted, so the record and its gap report cannot disagree. That is what lets the agent ask for what is missing instead of guessing it.

Writes are shaped by the tool contract rather than by the caller: `medical_case_update` has no parameter that clears a field, so an omitted value keeps its previous one and a follow-up answer can never erase what is already recorded. Re-submitting an identical snapshot is a no-op that produces no new revision.

### Payoff

The case is queryable, diffable, and provable. "The patient never mentioned a duration" is a field that is absent, not a sentence the model failed to notice. Every fact has a revision number and an event sequence, so a wrong record can be traced to the turn that wrote it.

<a id="2-event-sourcing"></a>
## 2. Event sourcing

### Problem

Storing only the current state is simpler until something needs to explain it. A medical intake is exactly that case: a reviewer may need to know what the record looked like before a correction, a restart needs the state to come back without the process that built it, and a second interface needs the same facts without a second database.

### Solution

The session log is the only durable store. Domain mutations are appended as events; read models are folds over those events. Nothing is written to a side table, and there is no hidden JSON file.

### Implementation

The observation event carries everything a replay needs, including the canonical attachment reference and the revision:

```ts
import type { ImageObservationOperation, MedicalImageObservation } from '@deepseek-ai/dsh-medical-image'

export interface MedicalImageObservationChange {
  readonly kind: 'medical/image-observation'
  readonly version: 1
  readonly operation: ImageObservationOperation
  readonly observation: MedicalImageObservation
}
```

An observation carries `attachmentId`, `revision`, `bodyRegion`, `findings`, `quality` (a `usable` verdict plus its issues), and `uncertainty`. Because each mutation event holds the complete post-mutation value, computing the current observation never requires merging a delta with an earlier payload, and the durable stream answers what was observed, at which revision, for which image. A strict fold still consumes the events in sequence: the invariants a single snapshot cannot carry — the operation that produced it, the case identity, revision continuity, and `createdAt` ordering — are checked against what came before it.

Each domain registers a projection:

```ts
import { applyMedicalImageProjection, medicalImageProjectionStateSchema } from '@deepseek-ai/dsh-medical-image'
import type { MedicalImageProjectionState } from '@deepseek-ai/dsh-medical-image'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export const medicalImageProjectionDefinition = {
  key: 'medicalImage',
  stateSchema: medicalImageProjectionStateSchema,
  init: (): MedicalImageProjectionState => ({ observations: [], failure: null }),
  apply: applyMedicalImageProjection,
  stateVersion: 1,
} satisfies ProjectionDefinition<'medicalImage', MedicalImageProjectionState>
```

The registry folds committed events into that state and checkpoints it periodically (`writeEveryEvents: 200`, `writeIntervalMs: 5000` in the shipped profile). `stateVersion` is the escape hatch: a change to the folded shape or its semantics bumps it, and persisted checkpoints from an older unit are discarded rather than forward-applied.

### What this buys

- **Multi-turn modification.** Revision 1 and revision 2 are two events, so the edit history exists whether or not anyone asked for it.
- **History.** The log is append-only, so the past is not overwritten by the present.
- **Cold-start recovery.** A new process replays the log and reconstructs the same state, with no migration and no snapshot format to keep in sync.
- **State replay.** The projection is a pure function of the events, so state can be recomputed at any time and compared against what was served.

The recovery claim is not theoretical. `packages/medical/medical-image/tests/persistence.spec.ts` writes an observation through the production writer into a real JSONL log, disposes the context, and has a second context open the same log, replay the projection, and resume an agent on it — asserting the attachment id, revision, body region, findings, quality verdict, and uncertainty all survive.

<a id="3-multimodal-attachment-grounding"></a>
## 3. Multimodal attachment grounding

### Problem

This is the hardest problem in the project, and it only appears once a model can see images.

An image reaches the model as bytes plus a handle that names its attachment. When the model wants to record an observation, it has to send that identifier back. In practice it does not. A live run against a real vision model produced four different answers in a single turn:

| What the model sent | What it actually was |
|---|---|
| `synthetic-visible-patch.png` | the display name |
| `e9f65bf6…d1f2` | the digest with its `sha256:` prefix stripped |
| `synthetic-visible-patch` | the fixture id, with the extension removed |
| `C:\Users\…\attachments\v1\objects\e9\e9f65bf6…` | the normalized-copy filesystem path |

Every one of them was refused with `IMAGE_ATTACHMENT_NOT_IN_SESSION`, and the turn recorded nothing. The refusal was correct — but the model had no reliable way to be right, because the handle it was reading from presented the display name first and the identifier second, unlabelled, in parentheses.

This is not a prompt-wording nuisance. It is an **authorization boundary**: an agent that can cite an attachment it never received can fabricate evidence, and an agent that can cite another session's attachment can read across a tenant boundary.

### Solution

Three layers, in order of importance.

**1. The store mints the identity.** `AttachmentStore.admitPromptContent()` is the only thing that produces an `ImageAttachmentRef`. The id is content-addressed — a digest of the bytes — so the same image admitted twice yields the same id, and no caller can assert a media type, a byte length, or dimensions the harness never admitted. Be precise about what that buys: content addressing gives **identity**, not **authorization**. A digest makes the id stable and hard to invent for an image you do not hold, but it is not a signature and it grants nothing about whether *this* session is entitled to use that image. Whether a claimed id may be used here is the next layer question, answered against the session rather than against the string.

**2. The domain authorizes against the session.** `canonicalImageAttachment()` scans the session's own derived messages for the claimed id and returns the reference the message carried — never the caller's. The lookup is deliberately narrow: an id this session never carried, an id belonging to another session, and an id that exists only in the model's output all get the **same** answer. Distinguishing them would tell a caller which ids exist elsewhere.

**3. The request states the identity as a field.** The handle the model reads was rewritten so the identifier leads, is quoted, keeps its prefix, and is labelled:

```text
Image: attachmentId="sha256:e9f65bf6…d1f2"; displayName="image-1.png" (display only); request preview 64x64px. …
```

The display name is explicitly marked as display-only, and the tool description enumerates what the identifier is *not*: not the display name, not the file name, not a digest with the prefix removed, not a file path, not the image position.

Two supporting decisions follow from the same reasoning. Fixture display names in the evaluation harness are positional (`image-1.png`) rather than descriptive, so a case cannot be decided on what the file is called. And the authorization layer has tests for six near-miss identities — display name, name without extension, bare digest, wrong-prefix digest, truncated digest, filesystem path — each of which must be refused while the canonical id still succeeds.

### Payoff

The model cannot invent an image, cannot reach another session's image, and cannot get a wrong id silently normalized into a right one. When it does send a wrong identifier the failure is a typed, countable error rather than a corrupt record — which is what makes it fixable.

<a id="4-reducing-uncontrolled-generation-risk"></a>
## 4. Reducing uncontrolled generation risk

### Problem

An LLM asked about a skin photograph will diagnose it. That is the model doing what it was trained to do, and it is precisely what a medical intake agent must not ship: a confident-sounding clinical conclusion with no clinician behind it, recorded as if it were evidence.

The goal here is not to eliminate hallucination — that is not achievable by a schema, and claiming it would be dishonest. The goal is narrower and testable: **the model records observations, and the system gives it no field in which to write a conclusion.**

### Solution

Every mechanism below is structural. None of them relies on the model choosing to behave.

| Mechanism | What it removes |
|---|---|
| Tool schema shape | There is no `diagnosis`, `disease`, `condition`, `treatment`, `medication`, `risk`, `urgency`, `triage`, or `confidence` parameter, and a test asserts none is ever added |
| Observation-only fields | `findings` is described as directly visible properties — colour, shape, size, distribution, surface appearance — with explicit examples and explicit prohibitions |
| `usable` | A boolean that lets the model say "this image cannot be assessed" instead of guessing at one that can |
| `qualityIssues` | A closed enum (`blur`, `poor_lighting`, `occlusion`, `too_distant`, `unable_to_assess`) so a limitation is a value rather than a caveat buried in prose |
| `uncertainty` | A required array of what could not be determined, so "I do not know" is a recorded outcome rather than an omission |
| `missingFields` | The case read model reports which required facts are absent, so the agent asks instead of inferring |
| Domain separation | A visible finding cannot be written into a case field, so the model's observation never becomes patient-reported fact |

The prohibitions live in the descriptions the model reads immediately before calling, not only in the system prompt:

```text
Record only what is DIRECTLY VISIBLE … Do NOT state a diagnosis, name a disease or
condition, suggest treatment or medication, or give a risk, urgency, or triage
judgement. Do NOT restate these findings as patient-reported symptoms.
```

And the persona in the shipped profile repeats the boundary for the text-only path.

### Payoff

The failure mode changes shape. Instead of "the agent told a patient they probably have eczema", the worst available outcome is "the agent described a red circular patch and marked the image as blurred" — which is a true statement about an image, not a medical claim. When the model does overreach in prose, the tool calls it made are still auditable and still contain no clinical field, so the overreach is visible rather than encoded.

The honest limit: this bounds what the system **stores and acts on**. It does not stop the model from writing a diagnosis in a chat sentence, and the project does not claim otherwise. Detecting that would need a semantic judgement, which is exactly why the evaluation framework refuses to pretend a keyword scan could make it.

<a id="5-agent-reliability-evaluation"></a>
## 5. Agent reliability evaluation

### Problem

A chatbot can be tested by reading its replies. An agent cannot.

An agent's answer is not the deliverable — its actions are. "I have recorded your symptoms and your age" is a sentence that costs nothing to produce and proves nothing. The failure that matters is silent: the model said it recorded something, the case revision did not change, and the transcript looks fine. Nothing in a conversation-level test catches that, because the reply is fluent and the user cannot see the event log.

### Solution

Evaluate the trajectory against authoritative state the runtime derived, never against prose.

`packages/medical/medical-eval` replays versioned golden cases through the **real** agent loop with one isolated harness per case. Only the model is scripted; the session, the tool registry, the projection, and the domain services are the production ones. A turn is then reduced to plain data and compared purely.

| Dimension | What it asserts |
|---|---|
| Routing | The exact tool call sequence, position by position |
| Case state | Symptoms, duration, age, notes, revision, and the derived `missingFields` |
| Image state | The authoritative observation: attachment id, revision, body region, findings, `usable`, quality issues, uncertainty |
| Mutation | Whether the turn appended a case record, an image record, or nothing at all |
| Tool errors | Every errored tool result, classified |

Assertions come in two strengths on purpose. A scripted case pins exact values, because its model is a script. A live case pins structure — the observation exists for the right image, is usable, is at revision one, and records at least one finding — because a real model's phrasing is not reproducible and pretending otherwise would make the suite lie.

A single run reports dimensions side by side rather than collapsing into a score:

```text
cases=1/1 passed routing=1/1 state=3/3 missingFields=1/1
image=6/6 imageMutation=3/3 unexpectedImageMutations=0
toolErrors=0 unexpectedMutations=0 timeouts=0 runtimeErrors=0
```

The same harness runs live against the shipped composition, booting the real profile through the app-boot loader and asserting that what it measured is what ships: the loaded profile must compose exactly the shipped bundles, and the booted runtime must publish exactly the five medical tools. A run that finds anything else refuses rather than reporting numbers about a composition nobody chose.

### Payoff

Reliability becomes a number that can move and a failure that can be named. A regression shows up as `WRONG_TOOL` on turn 2 or `UNEXPECTED_CASE_MUTATION` with the session sequences to look up in the durable log, not as a vague sense that the agent felt worse this week. Because the evaluator is pure — no clock, no filesystem, no model — a report can be recomputed from stored observations, which is what makes a run comparable across revisions.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The image domain's authorization code is the one place in this project where the failure mode is a security boundary rather than a correctness bug, and it is written accordingly: one error code for every way an id can be wrong, a test per near-miss shape, and no normalization path that could turn a wrong identifier into a right one.

The evaluation framework deliberately has no assistant-prose classification. A keyword scan for disease names would be fragile, wrong in both directions, and would dress a heuristic up as a safety measurement — so the persona boundary is enforced where it belongs and prose-level safety evaluation is left to a future design that can make a semantic judgement honestly.

</details>
