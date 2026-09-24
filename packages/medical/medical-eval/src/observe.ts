/**
 * Turn observation: the runner-side projection of one turn's session events
 * into the stable snapshot the evaluator compares against.
 *
 * Two rules make this a seam rather than a convenience. The subject's state is
 * **read** from the domain and never recomputed from tool arguments, so an
 * evaluator can never disagree with the runtime about what the case holds. And
 * nothing here reaches back into the runtime: the result is plain data, so the
 * evaluator stays a total function of its arguments and a report can be
 * re-evaluated without a live session.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CaseView } from '@deepseek-ai/dsh-medical-case'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isJson } from './runtime.ts'
import type {
  ObservedCaseEvent,
  ObservedRuntimeError,
  ObservedTiming,
  ObservedToolCall,
  ObservedToolResult,
  ObservedTurn,
} from './types.ts'

/** What one turn's observation is read from. */
export interface TurnObservationInput {
  /** Zero-based position of this turn within its golden case. */
  readonly turnIndex: number
  /** The user text this turn carried. */
  readonly user: string
  /** Events this turn produced, in log order. */
  readonly events: readonly SessionEvent[]
  /** The authoritative case after the turn, read from `ctx.medicalCase`. */
  readonly caseState: CaseView | null
  /** Whether the runner cancelled this turn at its own ceiling. */
  readonly timedOut?: boolean
}

/**
 * Build the stable snapshot of one turn.
 * @param input - the turn's events and the authoritative case it produced.
 * @returns the observation the evaluator compares against.
 */
export function observeTurn(input: TurnObservationInput): ObservedTurn {
  const observation: ObservedTurn = {
    turnIndex: input.turnIndex,
    user: input.user,
    toolCalls: input.events.flatMap(observeToolCall),
    toolResults: input.events.flatMap(observeToolResult),
    caseState: input.caseState,
    caseEvents: input.events.flatMap(observeCaseEvent),
    usage: sumUsage(input.events),
    timing: turnTiming(input.events),
    timedOut: input.timedOut === true,
    runtimeError: turnFault(input.events),
  }
  return observation
}

/** Read one `tool/call`, parsing its raw arguments without letting a malformed one abort the turn. */
function observeToolCall(event: SessionEvent): ObservedToolCall[] {
  if (event.type !== 'tool/call') return []
  const rawArguments = event.data.arguments
  let decoded: unknown
  try {
    decoded = JSON.parse(rawArguments)
  } catch {
    return [{ ...callIdentity(event, rawArguments), argumentParseError: 'tool arguments are not valid JSON' }]
  }
  if (!isJson(decoded)) {
    return [{
      ...callIdentity(event, rawArguments),
      argumentParseError: 'tool arguments are not a JSON value',
    }]
  }
  return [{ ...callIdentity(event, rawArguments), parsedArguments: decoded }]
}

/** The identity every observation of one call carries, whatever happened to its arguments. */
function callIdentity(
  event: SessionEvent<'tool/call'>,
  rawArguments: string,
): Pick<ObservedToolCall, 'name' | 'rawArguments' | 'eventSeq' | 'callId'> {
  return { name: event.data.name, rawArguments, eventSeq: event.seq, callId: event.data.callId }
}

/** Read one `tool/result`. */
function observeToolResult(event: SessionEvent): ObservedToolResult[] {
  if (event.type !== 'tool/result') return []
  // The message's content is a one-element tuple by contract, so the block is
  // there by construction rather than by a search that could come back empty.
  const [block] = event.data.message.content
  const result: ObservedToolResult = {
    callId: block.toolCallId,
    isError: block.isError === true,
    eventSeq: event.seq,
  }
  const failure = event.data.error
  return [failure === undefined ? result : { ...result, errorCode: failure.code }]
}

/** Read one durable case record. */
function observeCaseEvent(event: SessionEvent): ObservedCaseEvent[] {
  if (event.type !== 'medical/case-change') return []
  return [{
    operation: event.data.operation,
    revision: event.data.case.revision,
    eventSeq: event.seq,
  }]
}

/**
 * Sum the token usage this turn's model calls reported.
 *
 * Absent rather than zero when the runtime reported none: a run that measured
 * nothing and a run that cost nothing are different facts, and the report
 * carries the count so the difference survives aggregation.
 */
function sumUsage(events: readonly SessionEvent[]): TokenUsage | null {
  let inputTokens = 0
  let outputTokens = 0
  let reported = false
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    reported = true
  }
  return reported ? { inputTokens, outputTokens } : null
}

/** Read the turn's own wall-clock span, which needs both boundaries. */
function turnTiming(events: readonly SessionEvent[]): ObservedTiming | null {
  const start = events.find(event => event.type === 'turn/start')
  const end = events.findLast(event => event.type === 'turn/end')
  if (start === undefined || end === undefined) return null
  return { startMs: start.time, endMs: end.time, wallClockMs: end.time - start.time }
}

/**
 * Read the turn's runtime fault from its own closing event.
 *
 * The durable log is the authority here as everywhere else: a turn that the
 * loop closed as failed carries that failure even if nothing in this process
 * saw the exception.
 */
function turnFault(events: readonly SessionEvent[]): ObservedRuntimeError | null {
  const end = events.findLast(event => event.type === 'turn/end')
  if (end === undefined || end.data.reason.kind !== 'error') return null
  const failure = end.data.reason.error
  return { name: failure.code, message: failure.message }
}
