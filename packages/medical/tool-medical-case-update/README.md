---
description: "The model-facing medical_case_update tool, which applies one incremental change to the session's recorded case and reports the authoritative result."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-case-update

English | [中文](README.zh.md)

## Summary

`medical_case_update` changes the case this session already recorded. It exists because a follow-up sentence — "and I feel nauseous", "25 years old, two days" — must add to what is recorded rather than replace it. Every field is optional and an omitted field keeps its value, so the tool can never erase a recorded fact by omission. Symptoms are changed through explicit `symptomsAdd` and `symptomsRemove` deltas, and a full replacement is available only when the user restates the whole list. A call that changes nothing is reported as such, spends no revision, and appends no event.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this plugin wherever the model should be able to extend an intake instead of restating it. It needs `ctx.agents`, `ctx.medicalCase`, and `ctx.tools`, and registers one model-facing tool. The case must already exist; otherwise the call fails with a clear error and the agent should record it with `medical_case_intake` first.

### The contract the model receives

| Parameter | Meaning |
|---|---|
| `symptoms` | Replace the whole list. Mutually exclusive with the two deltas. |
| `symptomsAdd` | Append, keeping what is recorded. For "also …". |
| `symptomsRemove` | Drop a recorded symptom, for correcting an earlier record. |
| `duration` | Replacement text; omit to keep. |
| `age` | Replacement whole years; omit to keep. |
| `additionalNotes` | Replacement notes; omit to keep. |

### What it refuses

| Call | Why it is refused |
|---|---|
| `symptoms` with `symptomsAdd` or `symptomsRemove` | the call has no single meaning |
| one symptom in both add and remove | contradiction, after trimming |
| `symptoms: []` | an empty list could only mean erasing the recorded symptoms |
| `duration: ""` or `additionalNotes: "   "` | a blank could only mean erasing a recorded fact |

Refusals are ordinary tool errors: the turn continues, the model sees the reason, and the case is untouched.

### Symptoms are never silently lost

Adding is the model's natural move for a follow-up, and adding cannot lose data — the recorded symptoms keep their order and only new ones append. Replacement stays available for a genuine restatement, but it is never what an omission or a delta produces.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains how the single tool definition produces it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin identity, the parameter and output schemas, and the rendering |
| — | No runtime invariant companion is published: the tool owns no lifecycle stream and appends no session event of its own, so there is no independent observation to reconcile. |

### Consumer role

The plugin injects `['agents', 'medicalCase', 'tools']` and registers exactly one `defineTool` entry. It resolves the calling agent from the execution, delegates every merge, revision, and validation decision to `ctx.medicalCase.applyPatch`, and renders the returned authoritative view. The only durable trace of a call is the `tool/call` + `tool/result` pair the agent loop records, plus the `medical/case-change` event the domain appends when the change is accepted.

### Where each rejection happens

Argument types are checked by `defineTool` before the body runs. The domain rejects ambiguous or lossy patches with stable error codes, which the registry reports as an error result the model sees; neither path aborts the turn.

### Rendering

`output.render` lists the four fields, `missingFields`, and `revision`, and says plainly when nothing changed. The canonical value stays structured and is what a PTC program receives.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Medical case domain](../medical-case/README.md) — the merge, revision, and validation contract this tool consumes.
- [Intake tool](../tool-medical-case-intake/README.md) — the tool that records the first-contact case.
- [Read tool](../tool-medical-case-get/README.md) — the explicit read path.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-case-update) — the generated schema.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`medical_case_update` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-case-update): six optional parameters, each documenting itself, and no `required` list. The description states the no-clear rule, the mutual exclusion, and the preference for the deltas.

#### Token effect

Fixed schema cost on every request where the tool is visible. The six parameter descriptions are the bulk of it.

#### KV Cache effect

Prefix-stable while the definition and its visibility are unchanged. Registering, disposing, or restricting the tool may invalidate reuse from this schema onward.

### Tool-call history and result

#### What the model sees

The model's own arguments remain in the assistant tool-call block. The result is either the rendered record listing all four fields, `missingFields`, and `revision`, or, for a refused call, the exact `Error: <message>` line. The canonical structured value is not shown; only the rendered text is.

#### Token effect

One result per call, retained until compaction. A record with empty fields renders roughly seven short lines.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate existing entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No clear operation** — there is no parameter that erases a recorded fact or empties the symptom list, by design. A deliberate erasure verb with its own durable tombstone is deferred.
- **No compare-and-set revision parameter** — concurrent writers are not offered an expected revision; the domain still rejects a folded record that skips or repeats one.
- **Individual symptoms stay verbatim apart from normalization** — trimmed, blank-free, and deduplicated, but never mapped to a controlled vocabulary.
- **`duration` stays free text** — trimmed but never parsed into an interval.
- **The record is not durable case state across sessions** — it belongs to one session and does not follow a user to a new one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The mutual-exclusion rule is deliberately a single check rather than a richer operation union. A `replace`/`add`/`remove` operation field would move the same decision into a second place the model has to fill correctly, and the one-rule version is easier to state in a description and cheaper to test.

</details>
