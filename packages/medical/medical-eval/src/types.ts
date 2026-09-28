/**
 * Pure vocabulary of the medical evaluation harness: the versioned golden-case
 * contract, the stable snapshot an observation produces, the failure taxonomy
 * the evaluator classifies with, and the report shape. Deliberately free of
 * host-side runtime imports so the contract can be read by a collector, a
 * report reader, or a future evolution planner without pulling in an
 * agent-loop.
 *
 * @module @deepseek-ai/dsh-medical-eval/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CaseOperation, CaseView, MissingField } from '@deepseek-ai/dsh-medical-case'
import type { ImageObservationOperation, ImageQualityIssue } from '@deepseek-ai/dsh-medical-image'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * How one evaluation failed.
 *
 * Failure Taxonomy **v2**. The set is the clustering key a future bad-case
 * collector and evolution planner group by, so a new member is a contract
 * change: raise {@link GoldenCase} `schemaVersion` and the report's
 * `schemaVersion` with it rather than reusing an existing name for a new
 * meaning.
 *
 * The image members are deliberately four and not more. A missing or wrong
 * image tool call is already `TOOL_NOT_CALLED` / `WRONG_TOOL`, and a bad pinned
 * argument is already `ARGUMENT_EXTRACTION_ERROR`; only the image domain's own
 * subjects — the authoritative observation, its revision, and the durable
 * records — need names of their own.
 */
export type FailureType =
  /** The turn produced no tool call at all where the expectation required one. */
  | 'TOOL_NOT_CALLED'
  /** A tool call named something other than the expected tool at that position. */
  | 'WRONG_TOOL'
  /** More tool calls than the expectation describes. */
  | 'EXTRA_TOOL_CALL'
  /** A tool reported an error result. */
  | 'TOOL_ERROR'
  /** An argument the expectation pinned was absent, unparseable, or different. */
  | 'ARGUMENT_EXTRACTION_ERROR'
  /** The authoritative case state differs from what the expectation describes. */
  | 'CASE_STATE_MISMATCH'
  /** The derived missing-field report differs from the expectation. */
  | 'MISSING_FIELDS_MISMATCH'
  /** The durable revision is not the one the expectation describes. */
  | 'REVISION_MISMATCH'
  /** The turn produced a durable case change where none was expected. */
  | 'UNEXPECTED_CASE_MUTATION'
  /** The turn produced no durable case change where one was expected. */
  | 'EXPECTED_MUTATION_MISSING'
  /** A later revision carries a different case identity than an earlier one. */
  | 'CASE_ID_CHANGED'
  /** An authoritative image observation differs from what the expectation describes. */
  | 'IMAGE_OBSERVATION_MISMATCH'
  /** An image observation's durable revision is not the one the expectation describes. */
  | 'IMAGE_REVISION_MISMATCH'
  /** The turn appended an image record where none was expected. */
  | 'UNEXPECTED_IMAGE_MUTATION'
  /** The turn appended no image record where one was expected. */
  | 'EXPECTED_IMAGE_MUTATION_MISSING'
  /** The turn did not reach quiescence inside the runner's ceiling. */
  | 'SESSION_TIMEOUT'
  /** The runtime raised while the turn was being driven. */
  | 'RUNTIME_ERROR'

/**
 * Which expectation group an evaluated assertion belongs to. This is the
 * dimension the report aggregates by; see {@link EvalSummary}.
 *
 * Patient-reported state and model-observed evidence stay separate dimensions
 * here for the same reason they are separate domains: a run whose case is
 * perfect and whose image observations are wrong must not average into one
 * number that hides which half failed.
 */
export type AssertionKind =
  /** Tool call sequence and the arguments the expectation pinned. */
  | 'toolRouting'
  /** A tool result reported an error. */
  | 'toolError'
  /** A field of the authoritative case state. */
  | 'caseState'
  /** The derived missing-field report. */
  | 'missingFields'
  /** Whether the turn produced a durable case change. */
  | 'mutation'
  /** Case identity and timestamp continuity across the case's revisions. */
  | 'caseIntegrity'
  /** A field of the authoritative image observation. */
  | 'imageState'
  /** Whether the turn produced a durable image-observation record. */
  | 'imageMutation'
  /** Turn completion, timeout, and agent runtime faults. */
  | 'runtime'

/**
 * One golden case: a self-contained replay script whose every turn is
 * measured against the authoritative case state the runtime derived from it.
 *
 * Self-contained is a contract, not a convention: a case that needs a case
 * already on record records it in its own earlier turns, so replaying the
 * case needs nothing but the case itself and no runner may seed state.
 */
export interface GoldenCase {
  /** Contract version of this document. */
  readonly schemaVersion: 2
  /** Stable identity, unique across the shipped roster. */
  readonly id: string
  /** What this case exists to pin, in one sentence. */
  readonly description: string
  /** The turns, replayed in order into one fresh session. */
  readonly turns: readonly GoldenTurn[]
}

/**
 * One synthetic image a turn attaches, named the way a golden case can name it.
 *
 * A case never holds bytes, a path, or an attachment id. `fixture` is an id the
 * package's fixture registry resolves to a file it owns, so benchmark data
 * cannot become a filesystem-read contract and a fixture directory can move
 * without rewriting every case. `key` is the case-local identity an expectation
 * refers to; the runner resolves it to whichever canonical attachment id
 * admission minted, so no expectation ever pins a digest.
 */
export interface GoldenImageInput {
  /** Case-local identity, unique within the case, e.g. `image-1`. */
  readonly key: string
  /** Registry id of the synthetic image to attach, e.g. `synthetic-visible-patch`. */
  readonly fixture: string
}

/** One user utterance and everything expected of the runtime's response to it. */
export interface GoldenTurn {
  /** The fictional user text sent as this turn's only message. */
  readonly user: string
  /**
   * Synthetic images attached to the SAME user message as {@link GoldenTurn.user},
   * in this order. Absent means the turn carries text only.
   */
  readonly images?: readonly GoldenImageInput[]
  /** What must hold once the turn reaches quiescence. */
  readonly expect: TurnExpectation
}

/** What one turn is measured against. */
export interface TurnExpectation {
  /** The tool calls this turn must produce, in order. Always required. */
  readonly toolRouting: ToolRoutingExpectation
  /** Fields of the authoritative case state, when the turn must produce or preserve a specific record. */
  readonly caseState?: CaseStateExpectation
  /** Whether this turn must produce a durable case change, when that is the point of the turn. */
  readonly mutation?: MutationExpectation
  /** Authoritative image observations this turn must produce, one entry per image it is about. */
  readonly imageObservations?: readonly ImageObservationExpectation[]
  /** Whether this turn must produce durable image-observation records, when that is the point of the turn. */
  readonly imageMutation?: ImageMutationExpectation
}

/**
 * Fields of one authoritative image observation an expectation pins.
 *
 * Every field is optional, on the same principle as
 * {@link CaseStateExpectation}: a turn pins what it is about. That matters more
 * here than it does for the case, because a live observer's phrasing is not
 * reproducible — a deterministic case can pin `findings` exactly, while a live
 * smoke pins the structure it can actually rely on.
 *
 * `findings` and `minimumFindings` are mutually exclusive. The first states the
 * exact normalized list; the second only requires that the observer found
 * something, which is what a live smoke can honestly assert without freezing a
 * sentence.
 */
export interface ImageObservationExpectation {
  /** Case-local identity of the image this expectation is about. */
  readonly imageKey: string
  /** The exact body region, or an explicit null for "none can be stated". */
  readonly bodyRegion?: string | null
  /** The exact normalized finding list, in recorded order. */
  readonly findings?: readonly string[]
  /** The minimum number of findings, for an expectation that must not fix the wording. */
  readonly minimumFindings?: number
  /** Whether any part of the image could be described. */
  readonly usable?: boolean
  /** The exact normalized quality-issue list, in canonical order. */
  readonly qualityIssues?: readonly string[]
  /** The exact normalized uncertainty list, in recorded order. */
  readonly uncertainty?: readonly string[]
  /** The exact durable revision. */
  readonly revision?: number
}

/**
 * What the turn must do to the durable image-observation records. Separate from
 * {@link MutationExpectation} because that one describes `medical/case-change`
 * and this one describes `medical/image-observation`: a turn can observe an
 * image without touching the case at all, which is the separation this
 * dimension exists to measure.
 */
export interface ImageMutationExpectation {
  /** Whether the turn appended a durable image record. Equivalent to `eventCountDelta` > 0. */
  readonly changed?: boolean
  /** How many `medical/image-observation` records the turn must append. */
  readonly eventCountDelta?: number
  /** The records those events must carry, in order. */
  readonly events?: readonly ImageMutationEventExpectation[]
}

/** One durable image-observation record an expectation pins. */
export interface ImageMutationEventExpectation {
  /** Case-local identity of the image the record must be about. */
  readonly imageKey: string
  /** Whether the record first observed the attachment or advanced an existing observation. */
  readonly operation: 'observe' | 'update'
  /** The revision the record must carry, when the turn's point is that it advanced. */
  readonly revision?: number
}

/**
 * The exact tool-call sequence a turn must produce.
 *
 * Only the `exact` variant exists in v1. A turn whose intent has genuinely
 * equivalent routings does not belong in the roster rather than being
 * expressed as an alternative list, because an expectation with more than one
 * right answer cannot fail for a definite reason.
 */
export interface ToolRoutingExpectation {
  /** Discriminant reserving room for a future non-exact variant. */
  readonly kind: 'exact'
  /** The calls, positionally compared. An empty list asserts the turn calls nothing. */
  readonly calls: readonly ExpectedToolCall[]
}

/** One tool call an expectation pins. */
export interface ExpectedToolCall {
  /** The tool the model must call at this position. */
  readonly name: string
  /**
   * Argument values this call must carry, when the turn's point is that the
   * model extracted them. Omit when only the routing matters: the evaluator
   * classifies a mismatch as an argument fault **only** for keys an
   * expectation pins, and never infers one from a case-state difference.
   *
   * Comparison is a subset match — extra arguments the model supplies are
   * ignored, because a tool may legitimately carry detail the case does not
   * need to record.
   */
  readonly arguments?: Readonly<Record<string, JsonValue>>
}

/**
 * Fields of the authoritative case state an expectation pins. Every field is
 * optional: a turn pins what it is about.
 *
 * Identity and timestamps are deliberately absent. `caseId`, `createdAt`, and
 * `updatedAt` have no deterministic value at evaluation time, so their
 * *continuity* is asserted instead; see {@link EvaluationResult} and
 * `evaluateCase`.
 */
export interface CaseStateExpectation {
  /** The exact symptom list, in recorded order. */
  readonly symptoms?: readonly string[]
  /** The recorded duration, or null while unrecorded. */
  readonly duration?: string | null
  /** The recorded age in whole years, or null while unrecorded. */
  readonly age?: number | null
  /** The recorded optional notes, or null while unrecorded. */
  readonly additionalNotes?: string | null
  /** The exact durable revision. */
  readonly revision?: number
  /** The exact derived missing-field report, in intake order. */
  readonly missingFields?: readonly MissingField[]
}

/**
 * What the turn must do to the durable record. Separate from
 * {@link CaseStateExpectation} because a turn can assert either without the
 * other: a read-only turn pins the state it must leave untouched, and a
 * no-op turn pins that nothing was written even though the state is unchanged
 * either way.
 */
export interface MutationExpectation {
  /** Whether the turn appended a durable case record. Equivalent to `eventCountDelta` > 0. */
  readonly changed?: boolean
  /** How many `medical/case-change` records the turn must append. */
  readonly eventCountDelta?: number
  /** The operations those records must carry, in order. */
  readonly operations?: readonly CaseOperation[]
}

/** One model-requested tool call, as the session log recorded it. */
export interface ObservedToolCall {
  /** The tool the model named. */
  readonly name: string
  /** The arguments exactly as the model produced them: raw, unparsed JSON text. */
  readonly rawArguments: string
  /**
   * The parsed arguments, when the raw text was valid JSON. Present only in
   * that case, so a caller must treat absence as "unparsed" and read
   * {@link ObservedToolCall.argumentParseError} for why.
   */
  readonly parsedArguments?: JsonValue
  /** Why parsing failed, when it did. A malformed argument never aborts a run. */
  readonly argumentParseError?: string
  /** Session sequence of the `tool/call` event. */
  readonly eventSeq: number
  /** The call identity shared with the matching result. */
  readonly callId: string
}

/** One tool result, as the session log recorded it. */
export interface ObservedToolResult {
  /** The call this result answers. */
  readonly callId: string
  /** Whether the tool reported a failure. */
  readonly isError: boolean
  /** The stable failure code, when the runtime published one. */
  readonly errorCode?: string
  /** Session sequence of the `tool/result` event. */
  readonly eventSeq: number
}

/** One durable case record appended during a turn. */
export interface ObservedCaseEvent {
  /** Whether the record created the case or advanced it. */
  readonly operation: CaseOperation
  /** The revision the record carries. */
  readonly revision: number
  /** Session sequence of the `medical/case-change` event. */
  readonly eventSeq: number
}

/**
 * One authoritative image observation, projected into the evaluator's
 * vocabulary.
 *
 * The projection is deliberate: the domain value carries the full
 * `ImageAttachmentRef`, and a report has no business carrying a display name or
 * intrinsic dimensions that came from the user's file. What survives is what an
 * assertion can be written about.
 */
export interface ObservedImageObservation {
  /**
   * Case-local identity the runner resolved this attachment to, or null when
   * the attachment is not one this case admitted. The domain authorizes every
   * id against its own session, so null cannot arise from a well-formed run and
   * is reported rather than hidden.
   */
  readonly imageKey: string | null
  /** Durable attachment id, carried so a failure can be located in the log. */
  readonly attachmentId: string
  /** The durable revision. */
  readonly revision: number
  /** The recorded body region, or null. */
  readonly bodyRegion: string | null
  /** The normalized findings, in recorded order. */
  readonly findings: readonly string[]
  /** Whether any part of the image could be described. */
  readonly usable: boolean
  /** The normalized quality limitations, in canonical order. */
  readonly qualityIssues: readonly ImageQualityIssue[]
  /** The normalized uncertainty list, in recorded order. */
  readonly uncertainty: readonly string[]
}

/** One durable image-observation record appended during a turn. */
export interface ObservedImageEvent {
  /**
   * Case-local identity of the image the record is about, or null when the
   * record names an attachment this case never admitted. That cannot happen in
   * a well-formed run — the domain authorizes every id against the session —
   * so a null here is itself a fault the evaluator reports rather than hides.
   */
  readonly imageKey: string | null
  /** Durable attachment id the record carries. */
  readonly attachmentId: string
  /** Whether the record first observed the attachment or advanced it. */
  readonly operation: ImageObservationOperation
  /** The revision the record carries. */
  readonly revision: number
  /** Session sequence of the `medical/image-observation` event. */
  readonly eventSeq: number
}

/** Wall-clock span of one turn, read from its own `turn/start` and `turn/end`. */
export interface ObservedTiming {
  /** Epoch milliseconds of `turn/start`. */
  readonly startMs: number
  /** Epoch milliseconds of `turn/end`. */
  readonly endMs: number
  /** `endMs - startMs`. */
  readonly wallClockMs: number
}

/** An agent runtime fault raised while the turn was driven. */
export interface ObservedRuntimeError {
  /** Error class name. */
  readonly name: string
  /** Error message. */
  readonly message: string
}

/**
 * One turn as the runner observed it: a stable, harness-free snapshot of the
 * events this turn produced plus the authoritative state read from the domains
 * after it settled.
 *
 * Nothing here is recomputed from tool arguments. `caseState` and
 * `imageObservations` are the values the domains derived from the durable log,
 * so the evaluator can never disagree with the runtime about what is recorded.
 */
export interface ObservedTurn {
  /** Zero-based position of this turn within its golden case. */
  readonly turnIndex: number
  /** The user text this turn carried. */
  readonly user: string
  /** Tool calls the model requested, in logged order. */
  readonly toolCalls: readonly ObservedToolCall[]
  /** Tool results the runtime produced, in logged order. */
  readonly toolResults: readonly ObservedToolResult[]
  /** The authoritative case after the turn, or null when none is recorded. */
  readonly caseState: CaseView | null
  /** Durable case records this turn appended, in logged order. */
  readonly caseEvents: readonly ObservedCaseEvent[]
  /**
   * The authoritative image observations after the turn, in first-observation
   * order. Empty when the case has no images or none were observed.
   */
  readonly imageObservations: readonly ObservedImageObservation[]
  /** Durable image-observation records this turn appended, in logged order. */
  readonly imageEvents: readonly ObservedImageEvent[]
  /** Summed token usage of this turn's model calls, or null when the runtime reported none. */
  readonly usage: TokenUsage | null
  /** Wall-clock span, or null when the turn has no complete boundary pair. */
  readonly timing: ObservedTiming | null
  /** Whether the turn exceeded the runner's ceiling and was cancelled. */
  readonly timedOut: boolean
  /** The runtime fault that ended the turn early, when there was one. */
  readonly runtimeError: ObservedRuntimeError | null
}

/** Session sequences an assertion is evidenced by, so a failure can be looked up in the log. */
export interface EvaluationEvidence {
  /** `tool/call` sequences considered. */
  readonly toolCallSeqs: readonly number[]
  /** `tool/result` sequences considered. */
  readonly toolResultSeqs: readonly number[]
  /** `medical/case-change` sequences considered. */
  readonly caseEventSeqs: readonly number[]
  /** `medical/image-observation` sequences considered. */
  readonly imageEventSeqs: readonly number[]
}

/**
 * One evaluated assertion. A result with `failureType: null` passed, so a
 * turn's results describe every assertion the expectation called for rather
 * than only the failures.
 */
export interface EvaluationResult {
  /** The report dimension this assertion aggregates under. */
  readonly kind: AssertionKind
  /** Short label naming what was asserted, for a failure line. */
  readonly assertion: string
  /** How the assertion failed, or null when it passed. */
  readonly failureType: FailureType | null
  /** Human-readable explanation, carrying the values on a failure. */
  readonly detail: string
  /** What the expectation required. */
  readonly expected: JsonValue
  /** What the runtime produced. */
  readonly actual: JsonValue
  /** Where in the log this assertion was decided. */
  readonly evidence: EvaluationEvidence
}

/** One turn's evaluated assertions. */
export interface TurnEvaluation {
  /** Zero-based position of this turn within its golden case. */
  readonly turnIndex: number
  /** Whether every assertion this turn evaluated passed. */
  readonly passed: boolean
  /** Every assertion the turn evaluated, passing ones included. */
  readonly results: readonly EvaluationResult[]
  /** The tool names the turn called, for the report's readable summary. */
  readonly toolCalls: readonly string[]
  /** The authoritative case after the turn. */
  readonly caseState: CaseView | null
  /** The authoritative image observations after the turn. */
  readonly imageObservations: readonly ObservedImageObservation[]
  /** Token usage this turn reported, carried so the report can state how much of it was measured. */
  readonly usage: TokenUsage | null
}

/**
 * One failure, carrying everything needed to locate it without re-reading the
 * whole conversation: the case and turn, the classification, both values, the
 * session, and the sequences to look up in the durable log.
 */
export interface EvalFailure {
  /** Golden case this failure belongs to. */
  readonly goldenCaseId: string
  /** Turn within that case, zero-based. */
  readonly turnIndex: number
  /** Session the turn was replayed in. */
  readonly sessionId: string
  /** How it failed. */
  readonly failureType: FailureType
  /** Short label naming the assertion. */
  readonly assertion: string
  /** Human-readable explanation. */
  readonly detail: string
  /** What the expectation required. */
  readonly expected: JsonValue
  /** What the runtime produced. */
  readonly actual: JsonValue
  /** Where in the log it was decided. */
  readonly evidence: EvaluationEvidence
}

/** One golden case's outcome. */
export interface CaseEvaluation {
  /** The golden case's id. */
  readonly id: string
  /** Whether the case produced no failure at all. */
  readonly passed: boolean
  /** Every turn, in replay order. */
  readonly turns: readonly TurnEvaluation[]
  /** Every failure, in turn order. Empty when `passed`. */
  readonly failures: readonly EvalFailure[]
}

/**
 * Token usage across a run, with its own completeness.
 *
 * A run whose runtime reported usage on some turns only must not present the
 * partial sum as a run total, so the count travels with the sum.
 */
export interface EvalUsageAggregate {
  /** Summed input tokens over the turns that reported usage. */
  readonly inputTokens: number
  /** Summed output tokens over the turns that reported usage. */
  readonly outputTokens: number
  /** Turns that reported usage. */
  readonly observedTurns: number
  /** Turns the run evaluated. */
  readonly totalTurns: number
  /** Whether every turn reported usage. */
  readonly complete: boolean
}

/** Wall-clock latency across a run, as the runner measured it. */
export interface EvalLatencyAggregate {
  /** Summed per-case wall clock. */
  readonly totalMs: number
  /** Per-case wall clock, in case order. */
  readonly perCaseMs: readonly number[]
}

/**
 * Counts and ratios over a run.
 *
 * Deliberately not a weighted score. Every dimension is reported on its own so
 * a promotion gate can be defined later against the dimension that matters
 * rather than against an arbitrary weighting agreed on before the data
 * existed.
 */
export interface EvalSummary {
  /** Cases with no failure. */
  readonly casesPassed: number
  /** Cases evaluated. */
  readonly casesTotal: number
  /**
   * Turns whose tool routing (call sequence and pinned arguments) held.
   * Counted per turn, so the denominator is the turn count regardless of how
   * the model behaved.
   */
  readonly toolRoutingPassed: number
  /** Turns with a routing expectation. */
  readonly toolRoutingTotal: number
  /** Case-state assertions that held. */
  readonly stateAssertionsPassed: number
  /** Case-state assertions evaluated. */
  readonly stateAssertionsTotal: number
  /** Missing-field assertions that held. */
  readonly missingFieldAssertionsPassed: number
  /** Missing-field assertions evaluated. */
  readonly missingFieldAssertionsTotal: number
  /** Image-observation assertions that held. */
  readonly imageAssertionsPassed: number
  /** Image-observation assertions evaluated. */
  readonly imageAssertionsTotal: number
  /** Image-mutation assertions that held. */
  readonly imageMutationAssertionsPassed: number
  /** Image-mutation assertions evaluated. */
  readonly imageMutationAssertionsTotal: number
  /** Turns that appended an image record where the expectation forbade it. */
  readonly unexpectedImageMutations: number
  /** Tool results that reported an error. */
  readonly toolErrors: number
  /** Turns that mutated the case where the expectation forbade it. */
  readonly unexpectedMutations: number
  /** Turns that never reached quiescence. */
  readonly timeouts: number
  /** Turns that raised a runtime fault. */
  readonly runtimeErrors: number
  /** `casesPassed / casesTotal`, and 0 for an empty run. */
  readonly passRate: number
  /** Token usage over the run, with its completeness. */
  readonly usage: EvalUsageAggregate
  /** Wall-clock latency over the run. */
  readonly latencyMs: EvalLatencyAggregate
}

/** The model route and runner a report came from. */
export interface EvalRuntime {
  /** Profile the run booted. */
  readonly profile: string
  /** Provider route the golden cases were replayed against. */
  readonly provider: string
  /** Model id the golden cases were replayed against. */
  readonly model: string
  /** Which runner produced this report. */
  readonly runner: 'deterministic' | 'live'
}

/** One case as the report presents it. */
export interface CaseReport {
  /** The golden case's id. */
  readonly id: string
  /** Whether the case produced no failure. */
  readonly passed: boolean
  /** Every failure this case produced. */
  readonly failures: readonly EvalFailure[]
  /** Per-turn tool calls and resulting case, for reading a run back. */
  readonly turns: readonly CaseReportTurn[]
}

/** One turn as the report presents it. */
export interface CaseReportTurn {
  /** Zero-based position of this turn within its golden case. */
  readonly turnIndex: number
  /** Tool names the turn called. */
  readonly toolCalls: readonly string[]
  /** The authoritative case after the turn. */
  readonly caseState: CaseView | null
  /**
   * The authoritative image observations after the turn.
   *
   * Deliberately the projected observation and not the domain value: a report
   * quotes what an assertion can be written about, never image bytes, a fixture
   * path, or an attachment storage location.
   */
  readonly imageObservations: readonly ObservedImageObservation[]
}

/**
 * One evaluation run.
 *
 * `schemaVersion` versions this document and the failure taxonomy it carries,
 * so a consumer can refuse a report it does not understand rather than
 * mis-grouping an unfamiliar classification.
 */
export interface EvalReport {
  /** Contract version of this document. */
  readonly schemaVersion: 2
  /** Identity of this run, unique within the directory it is written to. */
  readonly runId: string
  /** ISO 8601 start instant. */
  readonly startedAt: string
  /** ISO 8601 finish instant. */
  readonly finishedAt: string
  /** The route and runner that produced it. */
  readonly runtime: EvalRuntime
  /** Counts and ratios over every case. */
  readonly summary: EvalSummary
  /** Every case, in replay order. */
  readonly cases: readonly CaseReport[]
}

/** One golden case's replay plan: the case and the model route it runs against. */
export interface GoldenCaseRun {
  /** The case to replay. */
  readonly golden: GoldenCase
  /** The golden case's evaluation. */
  readonly evaluation: CaseEvaluation
  /** Wall-clock milliseconds the case took. */
  readonly latencyMs: number
}
