---
description: "The session-backed medical intake case domain: durable case state, strict replay, a monotonic revision, and the derived missing-field report."
kind: "package-reference"
---

# @deepseek-ai/dsh-medical-case

English | [中文](README.zh.md)

## Summary

`ctx.medicalCase` owns the medical intake case for one session: the facts an intake records — symptoms, duration, age, and optional notes — plus a revision that advances on every accepted change. The domain stores nothing of its own. Every mutation appends a complete `medical/case-change` event to the owning session log and reads the current value back from a registry-driven projection, so persistence, resume, and fork inheritance come from the harness, not a second store. The missing-field report is derived on read and never persisted, so a recorded fact and its gap report cannot disagree.

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

Mount this plugin wherever an agent should keep a structured intake case across turns. It needs `ctx.agents` and `ctx.sessionProjections`, both of which the shipped bundles already provide, and registers `ctx.medicalCase`.

### The domain is a service, not a store

The case lives in the session log. That choice is what makes a case survive a restart, a resume, and a fork without a migration, and it is why this package ships no database, no JSON file, and no in-memory map keyed by session. A session's case is derived from that session's own events, so two sessions can never share one.

### Reading

| Call | Result |
|---|---|
| `get(agent)` | the current view, or `undefined` when no case exists |
| `require(agent)` | the current view, or a `CASE_NOT_FOUND` error |

Both return a fresh `CaseView`: the durable state plus `missingFields`, derived from that state on this read.

### Writing

| Call | Behavior |
|---|---|
| `create(agent, request)` | records revision one; fails with `CASE_ALREADY_EXISTS` when a case exists |
| `intake(agent, request)` | creates when the session has no case, otherwise restates the record |
| `applyPatch(agent, patch)` | applies an incremental change; fails with `CASE_NOT_FOUND` when no case exists |

Every accepted mutation returns `{ view, changed }`. When `changed` is `false` the call appended no event, the revision did not move, and `updatedAt` did not move either.

```ts
const { view } = ctx.medicalCase.intake(agent, { symptoms: ['headache', 'fever'] })
// view.missingFields === ['duration', 'age']

const completed = ctx.medicalCase.applyPatch(agent, { duration: '2 days', age: 25 })
// completed.view.missingFields === []
```

### The blank rule

A blank field means "not said yet" only while there is nothing to lose. On the create path a blank duration records `null` and is reported missing, which is how an intake can record a case the user has barely described. Once a case exists, the same blank could only erase a recorded fact, so it is rejected with the field named in the error. Nothing clears a recorded fact except a deliberate replacement with a real value.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains how the parts produce it.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Pure values and the `medicalCase` projection-key declaration, free of host-side imports |
| [`src/domain.ts`](src/domain.ts) | The `medical/case-change` session-event declaration, fold shapes, and stable error codes |
| [`src/runtime.ts`](src/runtime.ts) | Payload version, the age ceiling, the id brand, and the domain error class |
| [`src/fold.ts`](src/fold.ts) | Strict decoders and the pure replay fold |
| [`src/patch.ts`](src/patch.ts) | Pure state arithmetic: normalization, the patch contract, and the missing-field derivation |
| [`src/index.ts`](src/index.ts) | The service, the projection unit, and the read model |
| — | No runtime invariant companion is published: the fold that validates the durable stream is the same fold the projection registry drives, so there is no second observation of the same relationship that could diverge. |

### Why the event carries the whole state

`session-projection` requires that a state-bearing log event carry the complete post-mutation value rather than a delta. That rule is what lets `missingFields` stay derived: a reader never has to replay earlier records to know what the case currently holds, so nothing needs to store the gap report to keep it consistent.

### Strict replay

The fold rejects a record whose shape is wrong, whose revision does not advance by exactly one, whose identity changed, whose creation time moved, whose mutation time went backwards, or which restates facts that did not change. A rejection latches into the projection state, so every later read reports the same durable fault instead of quietly skipping the record. The service reads the projection after appending, which surfaces a producer/fold disagreement at the mutation that caused it.

### Where the clock is read

Only the service reads a clock, and it clamps the result to at least the previous `updatedAt`. A wall clock that steps backwards therefore cannot publish a stale record, which strict replay would reject. `src/patch.ts` takes the timestamp as an argument, so the merge contract is a total function of its inputs and needs no clock control to test.

### Registration

`ctx.sessionProjections.register(...)` is an effect on the service's own fiber, so disposing the service removes the projection key and its cached cells. Bump `stateVersion` in `medicalCaseProjectionDefinition` whenever the serialized fields or the fold semantics change.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Medical case subsystem](../../../docs/subsystems/medical-case.md) — the exact fields, variants, and service behavior.
- [Session projection](../../session/session-projection/README.md) — the registry that drives the fold and serves the per-session cell.
- [Persistence subsystem](../../../docs/subsystems/persistence.md) — the session log this domain stores its records in.
- [Same-session goal domain](../../goal/goal/README.md) — the sibling pattern this package follows: event-sourced per-session state whose monotonic revision is guarded by strict replay.
- [Medical group map](../README.md) — the sibling packages this domain serves.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no model-visible content: the case reaches the model only through the `medical_case_*` tools that consume it.

#### KV Cache effect

None; the domain never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One case per session** — there is no case history, no multi-visit graph, and no cross-session case store. A second `create` is rejected; later visits would need a successor domain.
- **No compare-and-set parameter on the public API** — mutations always act on the current revision, and reuse of an identity or a skipped revision is caught by the fold rather than offered to callers as an optimistic-concurrency argument. Goal's `GoalRef` is the template if concurrent writers appear.
- **`symptoms` are free text** — they are trimmed, deduplicated, and order-preserving, but they are not mapped to a controlled vocabulary, so `"Fever"` and `"fever"` stay distinct.
- **`duration` stays free text** — it is trimmed but never parsed into a normalized interval, so `"2 days"` and `"48 hours"` are not comparable.
- **`age` accepts whole years only** — infants are expressed as `0`, and there is no date-of-birth or months-granularity input.
- **No clear operation** — a recorded case cannot be erased, reduced to no symptoms, or reset to an earlier revision. Deliberate erasure would need its own verb and a tombstone record.
- **No process-local change notification** — consumers read the returned view or call the service; there is no `medical/case-changed` event for a UI or an audit listener to subscribe to.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The domain deliberately does not import `dsh-agent-loop`. Adding case state to the default loop was rejected for the goal domain for the same reason it is rejected here: state and policy compose from plugins, `Agent` verbs, and events without giving the default loop implementation a privileged copy of them.

</details>
