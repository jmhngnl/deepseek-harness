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
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * How one evaluation failed.
 *
 * Failure Taxonomy **v1**. The set is the clustering key a future bad-case
 * collector and evolution planner group by, so a new member is a contract
 * change: raise {@link GoldenCase} `schemaVersion` and the report's
 * `schemaVersion` with it rather than reusing an existing name for a new
 * meaning.
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
  /** The turn did not reach quiescence inside the runner's ceiling. */
  | 'SESSION_TIMEOUT'
  /** The runtime raised while the turn was being driven. */
  | 'RUNTIME_ERROR'

/**
 * Which expectation group an evaluated assertion belongs to. This is the
 * dimension the report aggregates by; see {@link EvalSummary}.
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
  readonly schemaVersion: 1
  /** Stable identity, unique across the shipped roster. */
  readonly id: string
  /** What this case exists to pin, in one sentence. */
  readonly description: string
  /** The turns, replayed in order into one fresh session. */
  readonly turns: readonly GoldenTurn[]
}

/** One user utterance and everything expected of the runtime's response to it. */
export interface GoldenTurn {
  /** The fictional user text sent as this turn's only message. */
  readonly user: string
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
 * events this turn produced plus the authoritative case state read from the
 * domain after it settled.
 *
 * Nothing here is recomputed from tool arguments. `caseState` is the value the
 * domain derived from the durable log, so the evaluator can never disagree
 * with the runtime about what the case holds.
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
  readonly schemaVersion: 1
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
