# Medical intake case

English | [中文](medical-case.zh.md)

Types shared by the event-sourced case service and its consumers. This page records the exact fields and variants in [`packages/medical/medical-case/src/types.ts`](../../packages/medical/medical-case/src/types.ts).

## Identity and lifecycle

`CaseId` is a [branded id](core.md#branded-ids). Callers address one exact revision through `CaseRef`; every admitted durable mutation increments the revision.

```ts type-equiv
/** Compare-and-set identity for one exact case revision. */
interface CaseRef {
  /** Stable case identity. */
  readonly caseId: CaseId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}
```

A session holds at most one current case, and that case keeps its identity for its whole life. Only `create` mints an identity and starts at revision one; every later mutation must keep that identity and advance the revision by exactly one.

```ts type-equiv
/** Durable state-changing verbs recorded in the case log. */
type CaseOperation = 'create' | 'update'
```

## Durable state

Every mutation writes the whole durable state, never a delta. A reader holding only the latest record already has the authoritative value, so neither projection nor strict replay needs earlier history.

```ts type-equiv
/** The complete durable case state. */
interface CaseState extends CaseRef {
  /** Symptoms exactly as recorded, in first-seen order. */
  readonly symptoms: string[]
  /** Free-text duration, or null while unrecorded. */
  readonly duration: string | null
  /** Whole years of age, or null while unrecorded. */
  readonly age: number | null
  /** Optional context, or null while unrecorded. */
  readonly additionalNotes: string | null
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation; never decreases. */
  readonly updatedAt: number
}
```

Symptoms are normalized on write: each entry is trimmed, entries that are blank once trimmed are dropped, exact duplicates collapse, and first-seen order is preserved. `duration` and `additionalNotes` are free text; a blank means "not said yet" only on the create path and is rejected on the mutation path, so no caller clears a recorded fact by accident.

`age` is a whole number of years, so `0` is valid and means an infant under one year.

## Read model and derived values

The missing-field report is **derived**, not persisted. `deriveMissingFields` computes it from the current state, so a recorded field and its gap report cannot disagree structurally.

```ts type-equiv
/** The read model: durable state plus values derived from it. */
interface CaseView extends CaseState {
  /** Required facts absent from this revision. */
  readonly missingFields: MissingField[]
}
```

```ts type-equiv
/** A fact the agent still has to obtain before the intake is complete. */
type MissingField = 'symptoms' | 'duration' | 'age'
```

`additionalNotes` is optional context: its absence never appears in `missingFields`.

## Change requests

Every field of a first-contact request may be omitted: recording that the user has not said something yet is a successful, useful outcome rather than a parameter error.

```ts type-equiv
/** First-contact input. Every field may be omitted. */
interface CaseIntakeRequest {
  /** Symptoms the user named; omit when none were named. */
  readonly symptoms?: string[]
  /** How long the symptoms have lasted, as the user phrased it. */
  readonly duration?: string
  /** Patient age in whole years. */
  readonly age?: number
  /** Any other case context the user volunteered. */
  readonly additionalNotes?: string
}
```

An incremental change applies to a case that already exists. An omitted field keeps its value; no parameter silently clears one.

```ts type-equiv
/** Incremental change against an existing case. */
interface CasePatch {
  /** Replace the whole symptom list. Mutually exclusive with the two deltas. */
  readonly symptoms?: string[]
  /** Append these symptoms, preserving the ones already recorded. */
  readonly symptomsAdd?: string[]
  /** Drop these symptoms; a value that is not recorded is a no-op. */
  readonly symptomsRemove?: string[]
  /** Replacement duration text. */
  readonly duration?: string
  /** Replacement age in whole years. */
  readonly age?: number
  /** Replacement optional notes. */
  readonly additionalNotes?: string
}
```

`symptoms` is mutually exclusive with the two deltas; `symptomsAdd` and `symptomsRemove` may appear together, but one normalized symptom cannot appear on both sides. An empty symptom list and a blank string are both rejected: erasing a recorded case is never what a follow-up sentence means.

```ts type-equiv
/** Outcome of one accepted patch attempt. */
interface CaseUpdateResult {
  /** The authoritative case after the attempt. */
  readonly view: CaseView
  /** Whether the attempt produced a durable new revision. */
  readonly changed: boolean
}
```

A change that alters no recorded fact appends no event and does not advance the revision, so when `changed` is `false` both the revision and `updatedAt` stay where they were.

## Service behavior

[`MedicalCaseService`](../../packages/medical/medical-case/src/index.ts) accepts only the exact live `Agent` object registered under its id, reads the strict replay result from the `medicalCase` projection on `ctx.sessionProjections`, and appends complete `medical/case-change` session events. It owns no store: persistence, resume, and fork inheritance all belong to the session log.

Failures are loud from two directions. Strict decoding rejects any malformed or inconsistent record and latches the failure into the projection state, so later reads report the same durable fault instead of silently skipping it. The domain boundary rejects invalid requests with stable error codes. The package [README](../../packages/medical/medical-case/README.md) defines the callable API and the model-facing conventions.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmedicalcase--medicalcaseservice"></a>

### `ctx.medicalCase` — `MedicalCaseService`

The medical intake case service (`ctx.medicalCase`), backed exclusively by the owning session log. Every mutation appends a full-state `medical/case-change` event and returns the resulting authoritative view; a mutation that would change nothing appends no event and keeps the revision.

```ts cordis-catalog
/**
 * Read the current case for one exact live agent.
 * @param agent - owning live agent.
 * @returns a fresh view, or `undefined` when no case has been recorded.
 * @throws {@link MedicalCaseError} when the agent is not the registry's live instance.
 */
get(agent: Agent): CaseView | undefined

/**
 * Read the current case, failing when this session has none.
 * @param agent - owning live agent.
 * @returns a fresh view.
 * @throws {@link MedicalCaseError} when no case exists or the agent is not live.
 */
require(agent: Agent): CaseView

/**
 * Record the first-contact case for one exact live agent.
 * @param agent - owning live agent.
 * @param request - the facts the user has volunteered so far; any may be omitted.
 * @returns the created view at revision one.
 * @throws {@link MedicalCaseError} when a case already exists.
 */
create(agent: Agent, request: CaseIntakeRequest): CaseUpdateResult

/**
 * Record what the user just described. Creates the case when the session has
 * none, and otherwise treats the request as a restatement of the record.
 * @param agent - owning live agent.
 * @param request - the facts the user volunteered in this message.
 * @returns the authoritative view and whether it changed.
 */
intake(agent: Agent, request: CaseIntakeRequest): CaseUpdateResult

/**
 * Apply one incremental patch to the current case.
 * @param agent - owning live agent.
 * @param patch - the change; an omitted field keeps its recorded value.
 * @returns the authoritative view and whether it changed.
 * @throws {@link MedicalCaseError} when no case exists or the patch is invalid.
 */
applyPatch(agent: Agent, patch: CasePatch): CaseUpdateResult
```

Types: [Agent](core.md)

Source: [`packages/medical/medical-case/src/index.ts`](../../packages/medical/medical-case/src/index.ts)
<!-- END GENERATED cordis-surface -->
