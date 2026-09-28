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
import type { MedicalImageObservation } from '@deepseek-ai/dsh-medical-image'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isJson } from './runtime.ts'
import type {
  ObservedCaseEvent,
  ObservedImageEvent,
  ObservedImageObservation,
  ObservedRuntimeError,
  ObservedTiming,
  ObservedToolCall,
  ObservedToolResult,
  ObservedTurn,
} from './types.ts'

/**
 * One image the runner admitted for a golden case, with the identity it was
 * admitted under.
 *
 * This mapping is evaluation metadata and nothing else. The domain has no idea
 * a key exists: it knows the canonical attachment id admission minted, and the
 * key is only how a golden case and an expectation can name that image without
 * hard-coding a digest.
 */
export interface AdmittedImage {
  /** Case-local identity the golden turn named. */
  readonly imageKey: string
  /** Canonical durable id admission minted for the fixture's bytes. */
  readonly attachmentId: string
}

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
  /** Every image this case admitted so far, so an attachment can be named by its key. */
  readonly images?: readonly AdmittedImage[]
  /** The authoritative image observations after the turn, read from `ctx.medicalImage`. */
  readonly imageObservations?: readonly MedicalImageObservation[]
  /** Whether the runner cancelled this turn at its own ceiling. */
  readonly timedOut?: boolean
}

/**
 * Build the stable snapshot of one turn.
 * @param input - the turn's events and the authoritative state it produced.
 * @returns the observation the evaluator compares against.
 */
export function observeTurn(input: TurnObservationInput): ObservedTurn {
  const keyOf = imageKeyIndex(input.images ?? [])
  const observation: ObservedTurn = {
    turnIndex: input.turnIndex,
    user: input.user,
    toolCalls: input.events.flatMap(observeToolCall),
    toolResults: input.events.flatMap(observeToolResult),
    caseState: input.caseState,
    caseEvents: input.events.flatMap(observeCaseEvent),
    imageObservations: (input.imageObservations ?? []).map(stored => observeImageObservation(stored, keyOf)),
    imageEvents: input.events.flatMap(event => observeImageEvent(event, keyOf)),
    usage: sumUsage(input.events),
    timing: turnTiming(input.events),
    timedOut: input.timedOut === true,
    runtimeError: turnFault(input.events),
  }
  return observation
}

/**
 * Index one case's admitted images by canonical attachment id.
 *
 * First admission wins when a case attaches one fixture under two keys: the
 * attachment is the same object either way, and a stable answer is what an
 * expectation needs. A later admission of the same bytes under another key
 * would produce the same id, so the earlier key is the one the case named
 * first.
 */
function imageKeyIndex(images: readonly AdmittedImage[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const image of images) {
    if (!index.has(image.attachmentId)) index.set(image.attachmentId, image.imageKey)
  }
  return index
}

/** Project one authoritative observation into the evaluator's vocabulary. */
function observeImageObservation(
  stored: MedicalImageObservation,
  keyOf: ReadonlyMap<string, string>,
): ObservedImageObservation {
  const attachmentId = String(stored.attachment.attachmentId)
  return {
    imageKey: keyOf.get(attachmentId) ?? null,
    attachmentId,
    revision: stored.revision,
    bodyRegion: stored.bodyRegion,
    findings: [...stored.findings],
    usable: stored.quality.usable,
    qualityIssues: [...stored.quality.issues],
    uncertainty: [...stored.uncertainty],
  }
}

/** Read one durable image-observation record. */
function observeImageEvent(event: SessionEvent, keyOf: ReadonlyMap<string, string>): ObservedImageEvent[] {
  if (event.type !== 'medical/image-observation') return []
  const attachmentId = String(event.data.observation.attachment.attachmentId)
  return [{
    imageKey: keyOf.get(attachmentId) ?? null,
    attachmentId,
    operation: event.data.operation,
    revision: event.data.observation.revision,
    eventSeq: event.seq,
  }]
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
