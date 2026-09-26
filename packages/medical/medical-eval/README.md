---
description: "Golden-case evaluation harness for the medical intake agent: a versioned case contract, deterministic replay through the real agent loop, and a structured report."
kind: "package-reference"
---

# @deepseek-ai/dsh-medical-eval

English | [中文](README.zh.md)

## Summary

Golden-case evaluation for the medical intake agent: versioned statements of what a consultation must do, replayed through the real agent loop against a scripted or a live model. An outcome is judged against the authoritative case state the runtime derived, never against the assistant's prose. A pure evaluator turns each turn into evaluated assertions and a report counts every dimension on its own rather than collapsing a run into a score. It is test infrastructure: it registers no tool and publishes no service, so the medical agent's model-facing surface stays at three tools.

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

This package runs in a test or an offline harness, not in an agent's runtime. Mount nothing: it publishes no plugin, no service, and no tool.

### The pipeline

```
GoldenCase
  → runGoldenCases
  → observeTurn
  → evaluateCase
  → buildReport
```

`runGoldenCases` replays through real agent loops with one isolated harness per case; `observeTurn` reduces a turn to plain data; `evaluateCase` compares purely; `buildReport` counts.

### Replaying the shipped roster

```ts
import { loadGoldenCases, runGoldenCases } from '@deepseek-ai/dsh-medical-eval'

const runs = await runGoldenCases(loadGoldenCases(goldenDirectory), async golden => ({
  // One harness per case, disposed by the runner when the case ends.
  ctx: await bootTheCompositionUnderTest(golden),
  agent,
}))

const report = buildReport({ runId, startedAt, finishedAt, runtime, runs })
```

`setup` is the only thing the runner does not decide. It hands back one harness per case and never learns whether the model behind it is a script or a live route, which is what lets the same roster and the same evaluator serve both.

### Running the live smoke

```sh
pnpm medharness:eval                                    # the three-case smoke
pnpm medharness:eval --case get-reads-without-changing   # one named case
pnpm medharness:eval --all                               # the whole roster
```

`runLiveEval` boots the shipped `medharness` profile through the app-boot loader — the real profile directory, the real bundle layers, the real healed module fallback the `dsh` launcher uses — and mounts nothing of its own, so a benchmark measures the composition that ships rather than a re-mounting of it. Two subtractions are deliberate and named in the source: the `@deepseek-ai/dsh-headless` one-shot CLI rows are excluded, because they would drive a task of their own, and the profile's user layers are skipped, so a machine-local patch cannot redefine what "the shipped profile" means. Skipping the patch layer is not enough on its own: `app-boot` normalizes a profile manifest only while its `dsh.profile.bundles` still equals the shipped template, and treats any other list as user-owned, so a hand-edited `package.json` would otherwise be booted and still be reported as shipped. The run therefore asserts that the loaded profile composes exactly the shipped bundles and refuses to measure one that does not — it refuses rather than repairs, leaving a rejected profile exactly as it found it. The report states the route the booted composition resolved, every case in a run must resolve that same route or no report is written at all, and the run refuses a composition that published anything but the three medical tools.

A live failure is a result. Nothing here repairs a case, loosens an expectation, or retries until it passes; the failure taxonomy, the expected and actual values, and the log sequences all land in the report like any other run. Reports are written to `.medharness/eval-runs/`, beside the session logs rather than in history.

### Reading a failure

Every failure carries `goldenCaseId`, `turnIndex`, `sessionId`, `failureType`, both values, and the session sequences to look up in the durable log.

```
expected-multi-turn turn 1: WRONG_TOOL — position 0 must call "medical_case_get",
  but the model called "medical_case_update"; expected ["medical_case_get"],
  actual ["medical_case_update"]
```

### Running the offline suite

```sh
pnpm vitest run packages/medical/medical-eval
```

Every one of those tests runs offline: no API key, no network, no remote model.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | The contract: golden case, observation, failure taxonomy, report |
| [`src/runtime.ts`](src/runtime.ts) | Contract versions, the reader's error class, the JSON narrowing |
| [`src/golden.ts`](src/golden.ts) | Strict reader for the golden-case contract |
| [`src/observe.ts`](src/observe.ts) | Session events plus the authoritative case, as one stable snapshot |
| [`src/evaluate.ts`](src/evaluate.ts) | The pure evaluator: expectations in, evaluated assertions out |
| [`src/report.ts`](src/report.ts) | Aggregation, the report contract, and the one filesystem seam |
| [`src/runner.ts`](src/runner.ts) | Replay orchestration: isolation, turn boundaries, the ceiling |
| `golden/*.json` | The shipped roster, one document per case |
| — | No runtime invariant companion is published: this package registers no service and no tool, so there is no cross-plugin relationship for a runtime check to observe, and its own contract is pinned by its specs and the per-file coverage gate instead. |

### Why a case is data

A golden case is reviewed, versioned, and replayed against a real model, so it cannot be an `if` inside a spec: a reader has to be able to see what the suite claims without reading code, and a claim has to be diffable. `schemaVersion` travels with every document and the reader refuses a version it does not know, so widening the contract is a visible act rather than a silent one.

The reader also **rejects members it does not define**. Without that rule a mistyped `caseStete` would read as "no state expectation" — the one failure mode that silently weakens a suite while every test still passes.

### Self-contained cases

Every case replays into a fresh session and states its own history. A case that needs a record already on file records it in its own earlier turns; no runner may seed state. The roster is checked for this: the first turn of every case must open a case at revision one, which is only reachable from a fresh session.

### What a case may pin

| Member | Meaning |
|---|---|
| `toolRouting.calls[].name` | The tool the model must call at that position |
| `toolRouting.calls[].arguments` | Values that call must carry — **optional**, subset match |
| `caseState.symptoms` / `duration` / `age` / `additionalNotes` | The authoritative record |
| `caseState.revision` | The durable revision |
| `caseState.missingFields` | The derived gap report |
| `mutation.changed` / `eventCountDelta` / `operations` | What the turn did to the log |

Two policies keep the roster honest rather than brittle:

- **Arguments are pinned only where extraction is the point.** They are absent wherever two spellings of the same correct call produce the same record, so a case never fails for a reason other than the one it names.
- **A free-text value is pinned only where it is unambiguous** — the roster never pins a `duration` literal. Once the user has supplied a duration, its wording has several equivalent spellings, so such a case pins `missingFields: []` instead: that is the proof the duration was recorded. The literal `duration: null` appears only where the user supplied none, and there it is the proof that nothing was invented. What the model writes into a free-text field is a data point about its phrasing, not a contract.

### The failure taxonomy

Failure Taxonomy **v1**, in [`src/types.ts`](src/types.ts). It is the clustering key a future bad-case collector groups by, so a new member is a contract change: raise the schema versions with it rather than reusing a name for a new meaning. It is not frozen — versioned.

`TOOL_NOT_CALLED` · `WRONG_TOOL` · `EXTRA_TOOL_CALL` · `TOOL_ERROR` · `ARGUMENT_EXTRACTION_ERROR` · `CASE_STATE_MISMATCH` · `MISSING_FIELDS_MISMATCH` · `REVISION_MISMATCH` · `UNEXPECTED_CASE_MUTATION` · `EXPECTED_MUTATION_MISSING` · `CASE_ID_CHANGED` · `SESSION_TIMEOUT` · `RUNTIME_ERROR`

Two rules keep the classification meaningful:

- An argument fault is reported **only** for a value an expectation pinned. Without one there is no ground truth about what the model extracted, so a case-state difference stays a `CASE_STATE_MISMATCH` rather than a guess.
- `caseId`, `createdAt`, and `updatedAt` have no deterministic value, so what is asserted is their **continuity**: a later revision keeping an earlier one's identity, and the mutation clock never stepping backwards. A violation of either is a case-state mismatch, because that is the state a reader should look at.

### The evaluator is pure

`evaluateTurn` and `evaluateCase` read no session, touch no file, call no model, and read no clock. The runner observes; the evaluator decides. That is what lets a report be recomputed from stored observations, and what a future evolution planner can reuse without standing up a runtime.

### The report is not a score

```ts
summary: {
  casesPassed, casesTotal,
  toolRoutingPassed, toolRoutingTotal,          // per turn
  stateAssertionsPassed, stateAssertionsTotal,  // per assertion
  missingFieldAssertionsPassed, missingFieldAssertionsTotal,
  toolErrors, unexpectedMutations, timeouts, runtimeErrors,
  passRate,
  usage: { inputTokens, outputTokens, observedTurns, totalTurns, complete },
  latencyMs: { totalMs, perCaseMs },
}
```

A single weighted number would have to be agreed before there is data to agree it against, and its dimensions are not interchangeable. Two rules follow:

- Routing is counted **per turn**, so the denominator is the turn count however the model behaved. A turn that faulted produced no routing assertion to pass, so it counts against the ratio rather than for it.
- Usage carries its own coverage. Sums over the turns that reported usage travel with the count, so a partially measured run reads as incomplete rather than as cheap. Nothing here estimates tokens: `length / 4` is not usage.

### Turn boundaries

The runner reads the durable sequence before admitting a turn's message and takes only the events above it, so a turn's observation cannot inherit the previous turn's calls or its case record. The ceiling is enforced by **cancelling** the agent rather than by abandoning the wait: the turn then converges to idle and closes itself in the log, so a hung turn still produces the `turn/end` its observation is read from and the harness can be disposed.

### Why the composition is the caller's

The runner builds no services, registers no tools, and knows no model. A composition re-mounted inside the harness would be a second thing to keep in step with the one that ships, so the caller supplies the runtime and the harness supplies only the replay. This is also what makes the live runner possible without a second code path.

### Integration seams (Phase 3B)

Neither is wired up, by decision: this phase adds offline infrastructure only.

- **Bad-case collection.** `ctx.messageFeedback.list({ sessionId })` reads persisted per-message ratings offline, so negative feedback can become a real source of production cases. Feedback is stored as **non-surface** events, so it never enters model history — a property the tools' own specs pin.
- **Case discovery.** `ctx.sessionQuery` reads, filters, and traces persisted sessions in the host plane. The `session_search`-style tools that expose it to a model stay out of the medical agent: the collector is an offline consumer, not a capability, and the surface stays at three tools.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Medical case subsystem](../../../docs/subsystems/medical-case.md) — the domain whose state every case is judged against.
- [Medical group map](../README.md) — the sibling packages this harness serves.
- [MedHarness runtime](../../../medharness/README.md) — the composition a live run replays against.
- [Session projection](../../session/session-projection/README.md) — the registry that serves the authoritative value the observer reads.
- [Agent loop](../../core/agent-loop/README.md) — the loop the runner drives.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no model-visible content: it is evaluation infrastructure that never mounts into an agent, so it contributes no tool, no prompt text, and no request header of its own.

#### KV Cache effect

None; the evaluator walks plain data and the runner drives an existing loop.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The live path is not exercised by CI** — every test here supplies a scripted route, because a suite must not spend a real model request. The route-absent path, which takes the composition's own configured model, therefore runs only when someone invokes `pnpm medharness:eval` by hand, and nothing in the suite would notice if that path broke. The two paths differ only in where the selection comes from: everything after it — the boot, the surface guard, the replay, the report — is the same code.
- **One routing kind** — `kind: 'exact'` only. A turn whose intent genuinely has several equivalent routings is left out of the roster rather than expressed as alternatives, because an expectation with more than one right answer cannot fail for a definite reason.
- **One expected case per session** — a case asserts the case its own turns build. Multi-visit history would need the domain to grow first.
- **Free text is compared literally** — `symptoms` and `duration` are free text in the domain, so a case that pins one is pinning the model's phrasing. The roster avoids pinning `duration` text for exactly that reason; a live run that reports a phrasing difference is reporting a fact about the model, not a harness fault.
- **No weighted score, and no promotion gate** — the report states dimensions and a raw pass rate. Turning those into a merge gate is a decision for a phase that has data to base it on.
- **Observations are not persisted** — a run writes its report, not the snapshots it was computed from, so a report cannot be re-evaluated without replaying the case. Persisting observations is what would let a case be re-judged after the evaluator changes.
- **Nothing is clustered yet** — the taxonomy is defined and carried on every failure, but nothing groups failures across runs into bad-case families. That is the collector's job.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package is deliberately not mounted by `packages/bundle/medharness`. The harness is an offline consumer of the runtime, and mounting it would put evaluation infrastructure inside the thing being evaluated. The bundle's own test asserts that its declared rows and its declared dependencies match in both directions, so adding a row for this package would fail that test before it could reach an agent's surface.

`src/index.ts` is a pure re-export module, which v8 reports as having no measurable statements. That is why it shows as 0% in a scoped coverage run and why the per-file gate does not flag it.

`observeTurn` is public and takes an event slice directly, so its own spec covers log shapes the runner does not produce — an incomplete boundary pair, an empty slice. Those are contract tests for the seam rather than defensive code with no test.

</details>
