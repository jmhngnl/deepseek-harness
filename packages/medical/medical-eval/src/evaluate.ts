/**
 * The pure evaluator: expected turn in, evaluated assertions out.
 *
 * Nothing here reads a session, touches a file, calls a model, or reads a
 * clock. The runner observes, this decides — which is what lets a report be
 * recomputed from stored observations, and what a future evolution planner can
 * reuse without standing up a runtime.
 *
 * Everything the model produced is judged against the authoritative case state
 * the runtime derived, never against the assistant's prose: the whole point of
 * the case domain is that a conversation saying "recorded" and a case holding
 * `age: null` can disagree, and only one of them is evidence.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import type { CaseView } from '@deepseek-ai/dsh-medical-case'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {
  CaseEvaluation,
  CaseStateExpectation,
  EvalFailure,
  EvaluationEvidence,
  EvaluationResult,
  FailureType,
  GoldenCase,
  GoldenTurn,
  ImageMutationEventExpectation,
  ImageMutationExpectation,
  ImageObservationExpectation,
  MutationExpectation,
  ObservedToolCall,
  ObservedTurn,
  ToolRoutingExpectation,
  TurnEvaluation,
  TurnExpectation,
} from './types.ts'

/** What one case is evaluated from. */
export interface CaseEvaluationInput {
  /** The case that was replayed. */
  readonly golden: GoldenCase
  /** One observation per turn, each carrying the turn index it observed. */
  readonly observed: readonly ObservedTurn[]
  /** Session the case was replayed in, carried onto every failure. */
  readonly sessionId: string
}

/**
 * Evaluate one turn against its expectation.
 *
 * A turn that timed out or failed has nothing else worth judging: its tool
 * calls and its case state describe a partial turn, so the fault is reported
 * alone rather than alongside a cascade of assertions derived from it.
 * @param expected - what the turn must produce.
 * @param observed - what it produced.
 * @returns every assertion the expectation called for, passing ones included.
 */
export function evaluateTurn(expected: TurnExpectation, observed: ObservedTurn): EvaluationResult[] {
  if (observed.timedOut) {
    return [fault(
      'SESSION_TIMEOUT',
      'turn completion',
      observed,
      'the turn did not reach quiescence inside the runner ceiling',
    )]
  }
  if (observed.runtimeError !== null) {
    return [fault(
      'RUNTIME_ERROR',
      'agent runtime',
      observed,
      `the turn was closed as failed: ${observed.runtimeError.name}: ${observed.runtimeError.message}`,
    )]
  }
  return [
    ...evaluateRouting(expected.toolRouting, observed),
    ...evaluateToolErrors(observed),
    ...evaluateCaseState(expected.caseState, observed),
    ...evaluateMutation(expected.mutation, observed),
    ...evaluateImageObservations(expected.imageObservations, observed),
    ...evaluateImageMutation(expected.imageMutation, observed),
  ]
}

/**
 * Evaluate one whole golden case, including the invariants no single turn can
 * assert: that every revision kept the same case identity, and that the
 * mutation clock never moved backwards.
 * @param input - the case, its observations, and the session they came from.
 * @returns the case's per-turn assertions and every failure, in turn order.
 */
export function evaluateCase(input: CaseEvaluationInput): CaseEvaluation {
  const observations = new Map(input.observed.map((turn, index): [number, ObservedTurn] => [index, turn]))
  const evaluated = input.golden.turns.map((turn, index) => evaluateGoldenTurn(turn, index, observations.get(index)))
  const integrity = caseIntegrity(input.observed)
  const turns = evaluated.map(turn => withIntegrity(turn, integrity.get(turn.turnIndex)))
  const failures = collectFailures(input.golden.id, input.sessionId, turns)
  return { id: input.golden.id, passed: failures.length === 0, turns, failures }
}

/**
 * Evaluate one turn, or report the observation the runner should have produced.
 *
 * The pairing is positional, because the golden case's own turn order is what
 * an observation is compared against. An observation whose own index disagrees
 * is refused rather than evaluated: judging turn three's behaviour against turn
 * one's expectation would produce failures attributed to the wrong turn, which
 * is worse than reporting that the observation is misplaced.
 */
function evaluateGoldenTurn(
  goldenTurn: GoldenTurn,
  index: number,
  observed: ObservedTurn | undefined,
): TurnEvaluation {
  if (observed === undefined) return unobservedTurn(goldenTurn, index, 'the runner produced no observation for this golden turn')
  if (observed.turnIndex !== index) {
    return unobservedTurn(goldenTurn, index, `the observation at position ${String(index)} reports turn ${String(observed.turnIndex)}`)
  }
  const results = evaluateTurn(goldenTurn.expect, observed)
  return {
    turnIndex: index,
    passed: passed(results),
    results,
    toolCalls: observed.toolCalls.map(call => call.name),
    usage: observed.usage,
    caseState: observed.caseState,
    imageObservations: observed.imageObservations,
  }
}

/** A turn whose observation is missing or misplaced, which is a harness gap rather than a model outcome. */
function unobservedTurn(goldenTurn: GoldenTurn, index: number, detail: string): TurnEvaluation {
  return {
    turnIndex: index,
    passed: false,
    results: [{
      kind: 'runtime',
      assertion: 'turn observation',
      failureType: 'RUNTIME_ERROR',
      detail,
      expected: goldenTurn.user,
      actual: null,
      evidence: noEvidence(),
    }],
    toolCalls: [],
    usage: null,
    caseState: null,
    imageObservations: [],
  }
}

/**
 * Assert the tool-call sequence, then the arguments of every pinned call.
 *
 * The two are separate assertions with separate evidence because they fail for
 * different reasons and lead to different fixes: a sequence can be right while
 * an argument is wrong, which is a model-extraction problem rather than a
 * routing one.
 */
function evaluateRouting(routing: ToolRoutingExpectation, observed: ObservedTurn): EvaluationResult[] {
  const expected = routing.calls.map(call => call.name)
  const actual = observed.toolCalls.map(call => call.name)
  const divergence = firstDivergence(expected, actual)
  const results: EvaluationResult[] = divergence === null
    ? [{
      kind: 'toolRouting',
      assertion: 'tool call sequence',
      failureType: null,
      detail: `the turn called ${JSON.stringify(actual)}, matching the expectation`,
      expected,
      actual,
      evidence: evidence(observed),
    }]
    : [routingFailure(divergence, expected, actual, observed)]
  for (const [index, call] of routing.calls.entries()) {
    const observedCall = observed.toolCalls[index]
    // A position the turn never reached, or reached with another tool, is
    // already reported by the sequence assertion above; an argument assertion
    // is attempted only where there is an argument to judge.
    if (observedCall === undefined || observedCall.name !== call.name) continue
    const pinned = call.arguments
    if (pinned === undefined) continue
    results.push(evaluateArguments(pinned, observedCall, index, observed))
  }
  return results
}

/** Where an observed call sequence first departs from the expected one. */
type RoutingDivergence =
  | { readonly kind: 'wrong'; readonly index: number }
  | { readonly kind: 'missing'; readonly index: number }
  | { readonly kind: 'extra'; readonly index: number }

/**
 * Classify the first departure between two call sequences. A sequence that
 * only differs in length is a missing or an extra call rather than a wrong
 * one, so a report says what to fix rather than that "something differed".
 */
function firstDivergence(expected: readonly string[], actual: readonly string[]): RoutingDivergence | null {
  const shared = Math.min(expected.length, actual.length)
  for (let index = 0; index < shared; index += 1) {
    if (expected[index] !== actual[index]) return { kind: 'wrong', index }
  }
  if (actual.length < expected.length) return { kind: 'missing', index: actual.length }
  if (actual.length > expected.length) return { kind: 'extra', index: expected.length }
  return null
}

/** Build the single routing failure a divergent sequence produces. */
function routingFailure(
  divergence: RoutingDivergence,
  expected: readonly string[],
  actual: readonly string[],
  observed: ObservedTurn,
): EvaluationResult {
  const shared: Omit<EvaluationResult, 'failureType' | 'detail'> = {
    kind: 'toolRouting',
    assertion: 'tool call sequence',
    expected: [...expected],
    actual: [...actual],
    evidence: evidence(observed),
  }
  switch (divergence.kind) {
    case 'wrong':
      return {
        ...shared,
        failureType: 'WRONG_TOOL',
        detail: `position ${String(divergence.index)} must call ${JSON.stringify(expected[divergence.index])}, but the model called ${JSON.stringify(actual[divergence.index])}`,
      }
    case 'missing':
      return {
        ...shared,
        failureType: 'TOOL_NOT_CALLED',
        detail: `the turn called ${String(actual.length)} tool(s) where the expectation requires ${String(expected.length)}: the call at position ${String(divergence.index)} (${JSON.stringify(expected[divergence.index])}) is missing`,
      }
    case 'extra':
      return {
        ...shared,
        failureType: 'EXTRA_TOOL_CALL',
        detail: `the turn called ${String(actual.length)} tool(s) where the expectation requires ${String(expected.length)}: ${JSON.stringify(actual[divergence.index])} at position ${String(divergence.index)} is not expected`,
      }
  }
}

/**
 * Assert the argument values one expectation pins.
 *
 * The comparison is a subset match and runs **only** for keys an expectation
 * names, which is why an argument fault is never inferred from a case-state
 * difference: without a pinned value there is no ground truth about what the
 * model extracted, only about what got recorded.
 */
function evaluateArguments(
  pinned: Readonly<Record<string, JsonValue>>,
  observed: ObservedToolCall,
  index: number,
  turn: ObservedTurn,
): EvaluationResult {
  const base: Omit<EvaluationResult, 'failureType' | 'detail'> = {
    kind: 'toolRouting',
    assertion: `arguments of call ${String(index)}`,
    expected: pinned,
    actual: observed.parsedArguments ?? observed.rawArguments,
    evidence: evidence(turn),
  }
  if (observed.argumentParseError !== undefined) {
    return { ...base, failureType: 'ARGUMENT_EXTRACTION_ERROR', detail: observed.argumentParseError }
  }
  const carried = observed.parsedArguments
  if (!isJsonObject(carried)) {
    return {
      ...base,
      failureType: 'ARGUMENT_EXTRACTION_ERROR',
      detail: `the call's arguments must be a JSON object; received ${observed.rawArguments}`,
    }
  }
  const mismatched = Object.keys(pinned).filter(key => !deepEqualJson(pinned[key], carried[key]))
  if (mismatched.length === 0) return { ...base, failureType: null, detail: 'the pinned arguments matched' }
  return {
    ...base,
    failureType: 'ARGUMENT_EXTRACTION_ERROR',
    detail: `the call must carry ${JSON.stringify(pinned)}; ${JSON.stringify(mismatched)} did not match ${observed.rawArguments}`,
  }
}

/** Whether parsed arguments carry a JSON object, the only shape a tool call may carry. */
function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Report every tool result that failed. A medical tool rejecting its own input
 * is never the expected outcome of a golden turn, so no expectation has to
 * declare it.
 */
function evaluateToolErrors(observed: ObservedTurn): EvaluationResult[] {
  return observed.toolResults
    .filter(result => result.isError)
    .map(result => ({
      kind: 'toolError',
      assertion: `tool result ${result.callId}`,
      failureType: 'TOOL_ERROR',
      detail: result.errorCode === undefined
        ? 'the tool reported a failed result'
        : `the tool reported ${result.errorCode}`,
      expected: 'a successful tool result',
      actual: result.errorCode ?? 'a failed result',
      evidence: evidence(observed),
    }))
}

/** Assert the fields of the authoritative case an expectation pins. */
function evaluateCaseState(expectation: CaseStateExpectation | undefined, observed: ObservedTurn): EvaluationResult[] {
  if (expectation === undefined) return []
  const state = observed.caseState
  if (state === null) {
    return [{
      kind: 'caseState',
      assertion: 'case presence',
      failureType: 'CASE_STATE_MISMATCH',
      detail: 'the expectation describes a recorded case, but this session has none',
      expected: 'a recorded case',
      actual: null,
      evidence: evidence(observed),
    }]
  }
  const results: EvaluationResult[] = []
  if (expectation.symptoms !== undefined) {
    results.push(compareField('symptoms', 'caseState', 'CASE_STATE_MISMATCH', [...expectation.symptoms], state.symptoms, observed))
  }
  if (expectation.duration !== undefined) {
    results.push(compareField('duration', 'caseState', 'CASE_STATE_MISMATCH', expectation.duration, state.duration, observed))
  }
  if (expectation.age !== undefined) {
    results.push(compareField('age', 'caseState', 'CASE_STATE_MISMATCH', expectation.age, state.age, observed))
  }
  if (expectation.additionalNotes !== undefined) {
    results.push(compareField('additionalNotes', 'caseState', 'CASE_STATE_MISMATCH', expectation.additionalNotes, state.additionalNotes, observed))
  }
  if (expectation.revision !== undefined) {
    results.push(compareField('revision', 'caseState', 'REVISION_MISMATCH', expectation.revision, state.revision, observed))
  }
  if (expectation.missingFields !== undefined) {
    results.push(compareField('missingFields', 'missingFields', 'MISSING_FIELDS_MISMATCH', [...expectation.missingFields], state.missingFields, observed))
  }
  return results
}

/** Compare one expected value against the authoritative one and classify a difference. */
function compareField(
  assertion: string,
  kind: EvaluationResult['kind'],
  failureType: FailureType,
  expected: JsonValue,
  actual: JsonValue,
  observed: ObservedTurn,
): EvaluationResult {
  const matched = deepEqualJson(expected, actual)
  return {
    kind,
    assertion,
    failureType: matched ? null : failureType,
    detail: matched
      ? `${assertion} matched`
      : `${assertion} must be ${JSON.stringify(expected)}; the case holds ${JSON.stringify(actual)}`,
    expected,
    actual,
    evidence: evidence(observed),
  }
}

/** Assert what the turn did to the durable record. */
function evaluateMutation(expectation: MutationExpectation | undefined, observed: ObservedTurn): EvaluationResult[] {
  if (expectation === undefined) return []
  const appended = observed.caseEvents.length
  const operations = observed.caseEvents.map(event => event.operation)
  const results: EvaluationResult[] = []
  if (expectation.changed !== undefined) {
    results.push(compareMutation('durable change', expectation.changed, appended > 0, observed))
  }
  if (expectation.eventCountDelta !== undefined) {
    results.push(compareMutation('case records appended', expectation.eventCountDelta, appended, observed))
  }
  if (expectation.operations !== undefined) {
    results.push(compareMutation('operations', [...expectation.operations], operations, observed))
  }
  return results
}

/**
 * Compare one mutation against the expectation.
 *
 * Two revisions that appended the same *number* of records can still have
 * written different ones, so the values are compared as JSON and the magnitudes
 * decide only the direction of a failure. That covers the count, the boolean,
 * and the operation list with one rule, since a boolean's magnitude is one or
 * zero and a list's is its length.
 */
function compareMutation(
  assertion: string,
  expected: JsonValue,
  actual: JsonValue,
  observed: ObservedTurn,
): EvaluationResult {
  if (deepEqualJson(expected, actual)) {
    return {
      kind: 'mutation',
      assertion,
      failureType: null,
      detail: `${assertion} matched`,
      expected,
      actual,
      evidence: evidence(observed),
    }
  }
  return {
    kind: 'mutation',
    assertion,
    failureType: magnitude(actual) < magnitude(expected) ? 'EXPECTED_MUTATION_MISSING' : 'UNEXPECTED_CASE_MUTATION',
    detail: `${assertion} must be ${JSON.stringify(expected)}; the turn produced ${JSON.stringify(actual)}`,
    expected,
    actual,
    evidence: evidence(observed),
  }
}

/** How much of something a mutation value describes. */
function magnitude(value: JsonValue): number {
  if (typeof value === 'number') return value
  if (Array.isArray(value)) return value.length
  return Number(value)
}

/**
 * Assert the fields of the authoritative image observations an expectation pins.
 *
 * The comparison is against the domain's own value, never against what a tool
 * call claimed to record: the whole point of the image domain is that a model
 * saying "observed" and a projection holding no observation can disagree, and
 * only one of them is evidence.
 *
 * An expectation naming an image the session holds no observation for fails
 * once, on that image, rather than producing one failure per pinned field.
 */
function evaluateImageObservations(
  expectations: readonly ImageObservationExpectation[] | undefined,
  observed: ObservedTurn,
): EvaluationResult[] {
  if (expectations === undefined) return []
  return expectations.flatMap(expectation => evaluateImageObservation(expectation, observed))
}

/** Assert one image's observation. */
function evaluateImageObservation(
  expectation: ImageObservationExpectation,
  observed: ObservedTurn,
): EvaluationResult[] {
  const stored = observed.imageObservations.find(candidate => candidate.imageKey === expectation.imageKey)
  if (stored === undefined) {
    return [{
      kind: 'imageState',
      assertion: `${expectation.imageKey} observation`,
      failureType: 'IMAGE_OBSERVATION_MISMATCH',
      detail: `the expectation describes an observation of ${JSON.stringify(expectation.imageKey)}, but this session holds none for that image`,
      expected: 'a recorded image observation',
      actual: null,
      evidence: evidence(observed),
    }]
  }
  const results: EvaluationResult[] = []
  if (expectation.bodyRegion !== undefined) {
    results.push(compareImageField(
      `${expectation.imageKey} bodyRegion`, expectation.bodyRegion, stored.bodyRegion, 'IMAGE_OBSERVATION_MISMATCH', observed,
    ))
  }
  if (expectation.findings !== undefined) {
    results.push(compareImageField(
      `${expectation.imageKey} findings`, [...expectation.findings], [...stored.findings], 'IMAGE_OBSERVATION_MISMATCH', observed,
    ))
  }
  if (expectation.minimumFindings !== undefined) {
    results.push(compareImageMinimumFindings(
      expectation.imageKey, expectation.minimumFindings, stored.findings.length, observed,
    ))
  }
  if (expectation.usable !== undefined) {
    results.push(compareImageField(
      `${expectation.imageKey} usable`, expectation.usable, stored.usable, 'IMAGE_OBSERVATION_MISMATCH', observed,
    ))
  }
  if (expectation.qualityIssues !== undefined) {
    results.push(compareImageField(
      `${expectation.imageKey} qualityIssues`, [...expectation.qualityIssues], [...stored.qualityIssues], 'IMAGE_OBSERVATION_MISMATCH', observed,
    ))
  }
  if (expectation.uncertainty !== undefined) {
    results.push(compareImageField(
      `${expectation.imageKey} uncertainty`, [...expectation.uncertainty], [...stored.uncertainty], 'IMAGE_OBSERVATION_MISMATCH', observed,
    ))
  }
  if (expectation.revision !== undefined) {
    results.push(compareImageField(
      `${expectation.imageKey} revision`, expectation.revision, stored.revision, 'IMAGE_REVISION_MISMATCH', observed,
    ))
  }
  return results
}

/** Compare one expected image field against the authoritative one and classify a difference. */
function compareImageField(
  assertion: string,
  expected: JsonValue,
  actual: JsonValue,
  failureType: FailureType,
  observed: ObservedTurn,
): EvaluationResult {
  const matched = deepEqualJson(expected, actual)
  return {
    kind: 'imageState',
    assertion,
    failureType: matched ? null : failureType,
    detail: matched
      ? `${assertion} matched`
      : `${assertion} must be ${JSON.stringify(expected)}; the observation holds ${JSON.stringify(actual)}`,
    expected,
    actual,
    evidence: evidence(observed),
  }
}

/**
 * Assert a lower bound on the finding count.
 *
 * A live observer's wording is not reproducible, so a live case cannot pin the
 * sentence it will produce — but it can honestly assert that the observer found
 * something. This is the assertion that keeps a smoke meaningful without
 * turning it into a phrasing lottery.
 */
function compareImageMinimumFindings(
  imageKey: string,
  minimum: number,
  actual: number,
  observed: ObservedTurn,
): EvaluationResult {
  const matched = actual >= minimum
  return {
    kind: 'imageState',
    assertion: `${imageKey} minimumFindings`,
    failureType: matched ? null : 'IMAGE_OBSERVATION_MISMATCH',
    detail: matched
      ? `${imageKey} recorded ${String(actual)} finding(s), at least the required ${String(minimum)}`
      : `${imageKey} must record at least ${String(minimum)} finding(s); the observation holds ${String(actual)}`,
    expected: `at least ${String(minimum)} findings`,
    actual,
    evidence: evidence(observed),
  }
}

/** Assert what the turn did to the durable image-observation records. */
function evaluateImageMutation(
  expectation: ImageMutationExpectation | undefined,
  observed: ObservedTurn,
): EvaluationResult[] {
  if (expectation === undefined) return []
  const appended = observed.imageEvents.length
  const results: EvaluationResult[] = []
  if (expectation.changed !== undefined) {
    results.push(compareImageMutation('durable image change', expectation.changed, appended > 0, observed))
  }
  if (expectation.eventCountDelta !== undefined) {
    results.push(compareImageMutation('image records appended', expectation.eventCountDelta, appended, observed))
  }
  if (expectation.events !== undefined) {
    results.push(compareImageEvents(expectation.events, observed))
  }
  return results
}

/** Compare one image mutation count or boolean against the expectation. */
function compareImageMutation(
  assertion: string,
  expected: JsonValue,
  actual: JsonValue,
  observed: ObservedTurn,
): EvaluationResult {
  const base = {
    kind: 'imageMutation' as const,
    assertion,
    expected,
    actual,
    evidence: evidence(observed),
  }
  if (deepEqualJson(expected, actual)) return { ...base, failureType: null, detail: `${assertion} matched` }
  return {
    ...base,
    failureType: magnitude(actual) < magnitude(expected)
      ? 'EXPECTED_IMAGE_MUTATION_MISSING'
      : 'UNEXPECTED_IMAGE_MUTATION',
    detail: `${assertion} must be ${JSON.stringify(expected)}; the turn produced ${JSON.stringify(actual)}`,
  }
}

/**
 * Compare the durable image records a turn appended against the ones an
 * expectation pins, positionally.
 *
 * A length difference is a missing or an extra record; a field difference at a
 * position is classified by which field it is, because "the turn wrote about
 * the wrong image" and "the turn advanced the wrong revision" lead to different
 * fixes.
 */
function compareImageEvents(
  expected: readonly ImageMutationEventExpectation[],
  observed: ObservedTurn,
): EvaluationResult {
  const actual = observed.imageEvents.map(event => ({
    imageKey: event.imageKey,
    operation: event.operation,
    revision: event.revision,
  }))
  const base = {
    kind: 'imageMutation' as const,
    assertion: 'image records',
    expected: expected.map(entry => ({ ...entry })),
    actual,
    evidence: evidence(observed),
  }
  if (expected.length !== actual.length) {
    return {
      ...base,
      failureType: actual.length < expected.length ? 'EXPECTED_IMAGE_MUTATION_MISSING' : 'UNEXPECTED_IMAGE_MUTATION',
      detail: `the turn appended ${String(actual.length)} image record(s) where the expectation requires ${String(expected.length)}`,
    }
  }
  for (const [index, want] of expected.entries()) {
    const got = actual[index]
    /* v8 ignore next -- the lengths were just proven equal, so every index has an entry */
    if (got === undefined) continue
    const failureType = imageEventMismatch(want, got)
    if (failureType !== null) {
      return {
        ...base,
        failureType,
        detail: `image record ${String(index)} must be ${JSON.stringify(want)}; the turn appended ${JSON.stringify(got)}`,
      }
    }
  }
  return { ...base, failureType: null, detail: 'image records matched' }
}

/** How one pinned image record differs from the one the turn appended. */
function imageEventMismatch(
  want: ImageMutationEventExpectation,
  got: { readonly imageKey: string | null; readonly operation: string; readonly revision: number },
): FailureType | null {
  if (want.imageKey !== got.imageKey || want.operation !== got.operation) return 'UNEXPECTED_IMAGE_MUTATION'
  if (want.revision !== undefined && want.revision !== got.revision) return 'IMAGE_REVISION_MISMATCH'
  return null
}

/**
 * Assert the invariants that span a case's revisions.
 *
 * Identity and timestamps have no deterministic value to compare, so what is
 * asserted is their continuity: a later revision keeping an earlier one's case
 * identity, and the mutation clock never stepping backwards. Both are
 * properties of the durable state, so a violation is classified as a
 * case-state mismatch — the taxonomy names describe what a reader should look
 * at, and that is the state.
 */
function caseIntegrity(observed: readonly ObservedTurn[]): Map<number, EvaluationResult[]> {
  const results = new Map<number, EvaluationResult[]>()
  const recorded = observed.flatMap((turn, index) =>
    turn.caseState === null ? [] : [{ index, turn, state: turn.caseState }])
  const [first, ...rest] = recorded
  if (first === undefined) return results
  let previous = first
  for (const entry of rest) {
    const found = integrityFailures(first.state, previous.state, entry.state, entry.turn)
    if (found.length > 0) results.set(entry.index, found)
    previous = entry
  }
  return results
}

/** The identity and timestamp checks one revision owes its predecessor. */
function integrityFailures(
  first: CaseView,
  previous: CaseView,
  current: CaseView,
  turn: ObservedTurn,
): EvaluationResult[] {
  const found: EvaluationResult[] = []
  if (current.caseId !== first.caseId) {
    found.push({
      kind: 'caseIntegrity',
      assertion: 'case identity',
      failureType: 'CASE_ID_CHANGED',
      detail: `revision ${String(current.revision)} belongs to case ${JSON.stringify(current.caseId)}; revision ${String(first.revision)} belongs to ${JSON.stringify(first.caseId)}`,
      expected: first.caseId,
      actual: current.caseId,
      evidence: evidence(turn),
    })
  }
  if (current.updatedAt < previous.updatedAt) {
    found.push({
      kind: 'caseIntegrity',
      assertion: 'mutation clock',
      failureType: 'CASE_STATE_MISMATCH',
      detail: `revision ${String(current.revision)} records updatedAt ${String(current.updatedAt)}, earlier than the previous revision's ${String(previous.updatedAt)}`,
      expected: previous.updatedAt,
      actual: current.updatedAt,
      evidence: evidence(turn),
    })
  }
  return found
}

/** Attach the integrity findings of one turn to that turn's evaluation. */
function withIntegrity(turn: TurnEvaluation, extra: readonly EvaluationResult[] | undefined): TurnEvaluation {
  if (extra === undefined) return turn
  const results = [...turn.results, ...extra]
  return { ...turn, results, passed: passed(results) }
}

/** Whether every assertion in a set passed. */
function passed(results: readonly EvaluationResult[]): boolean {
  return results.every(result => result.failureType === null)
}

/** Flatten every failed assertion into the report's failure records. */
function collectFailures(
  goldenCaseId: string,
  sessionId: string,
  turns: readonly TurnEvaluation[],
): EvalFailure[] {
  return turns.flatMap(turn => turn.results.flatMap(result =>
    result.failureType === null ? [] : [{
      goldenCaseId,
      turnIndex: turn.turnIndex,
      sessionId,
      failureType: result.failureType,
      assertion: result.assertion,
      detail: result.detail,
      expected: result.expected,
      actual: result.actual,
      evidence: result.evidence,
    }]))
}

/** The single-turn failure a fault produces, before any other assertion is attempted. */
function fault(
  failureType: FailureType,
  assertion: string,
  observed: ObservedTurn,
  detail: string,
): EvaluationResult {
  return {
    kind: 'runtime',
    assertion,
    failureType,
    detail,
    expected: 'a turn that settled',
    actual: failureType === 'SESSION_TIMEOUT' ? 'a turn that never settled' : 'a turn that failed',
    evidence: evidence(observed),
  }
}

/** Where in the log a turn's assertions were decided. */
function evidence(observed: ObservedTurn): EvaluationEvidence {
  return {
    toolCallSeqs: observed.toolCalls.map(call => call.eventSeq),
    toolResultSeqs: observed.toolResults.map(result => result.eventSeq),
    caseEventSeqs: observed.caseEvents.map(event => event.eventSeq),
    imageEventSeqs: observed.imageEvents.map(event => event.eventSeq),
  }
}

/** Evidence for a finding that refers to no particular event. */
function noEvidence(): EvaluationEvidence {
  return { toolCallSeqs: [], toolResultSeqs: [], caseEventSeqs: [], imageEventSeqs: [] }
}
