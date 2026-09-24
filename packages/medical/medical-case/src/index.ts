/**
 * Session-backed medical intake case domain: durable case state carried by the
 * owning session log, a monotonic revision guarded by replay consistency, and
 * the strict projection the registry drives on every committed event.
 *
 * The domain owns the contract only. Durability, resume, and fork inheritance
 * are the harness session log's business (`dsh-session`), and the per-session
 * fold cell is `dsh-session-projection`'s — this package adds no store of its
 * own, so a case can never disagree with the log it lives in.
 *
 * @module @deepseek-ai/dsh-medical-case
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { applyMedicalCaseEvent } from './fold.ts'
import type { MedicalCaseFoldState } from './fold.ts'
import {
  applyCasePatch,
  applyIntakeRequest,
  createCaseState,
  deriveMissingFields,
  resolveIntakeFields,
} from './patch.ts'
import { CaseId, MAX_AGE_YEARS, MEDICAL_CASE_CHANGE_VERSION, MedicalCaseError } from './runtime.ts'
import type { CaseOperation, CasePatch, CaseIntakeRequest, CaseState, CaseUpdateResult, CaseView, MedicalCaseProjectionState } from './types.ts'
import type { MedicalCaseChangeMeta } from './domain.ts'

// The pure type outlet (./types.ts, ONE home of the `medicalCase` projection-key
// declaration) is re-exported onto the package root so the emitted index.d.ts
// keeps the module edge, and aggregate programs consuming the declarations
// still receive the SessionProjectionStateMap merge.
export type * from './types.ts'
export type * from './domain.ts'
export { CaseId, MAX_AGE_YEARS, MEDICAL_CASE_CHANGE_VERSION, MedicalCaseError } from './runtime.ts'
export { emptyMedicalCaseFoldState, foldMedicalCase, applyMedicalCaseEvent, decodeMedicalCaseChange } from './fold.ts'
export type { MedicalCaseFoldState } from './fold.ts'
export { applyCasePatch, applyIntakeRequest, createCaseState, deriveMissingFields, normalizeSymptoms, resolveIntakeFields } from './patch.ts'
export type { ResolvedIntakeFields } from './patch.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    medicalCase: MedicalCaseService
  }
}

/** Wire shape of one durable case, as persisted inside a change payload. */
const caseStateSchema = zod.object({
  caseId: zod.string().min(1),
  revision: zod.number().int().positive(),
  symptoms: zod.array(zod.string().min(1)),
  duration: zod.string().min(1).nullable(),
  age: zod.number().int().min(0).max(MAX_AGE_YEARS).nullable(),
  additionalNotes: zod.string().min(1).nullable(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
}).strict()

const medicalCaseProjectionStateSchema: ZodType<MedicalCaseProjectionState> = zod.object({
  current: caseStateSchema.nullable(),
  seenCaseIds: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'seen case ids must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  if (state.current === null) return
  if (!state.seenCaseIds.includes(state.current.caseId)) {
    context.addIssue({ code: 'custom', message: 'current case id must be retained among seen case ids' })
  }
}) as unknown as ZodType<MedicalCaseProjectionState>

/** Build strict fold state from one checkpoint-safe projection state. */
function foldStateFromProjection(state: MedicalCaseProjectionState): MedicalCaseFoldState {
  const current = state.current
  return {
    current: current ?? undefined,
    seenCaseIds: new Set(state.seenCaseIds),
    lastRef: current === null ? undefined : { caseId: current.caseId, revision: current.revision },
  }
}

/** Convert strict fold state into checkpoint-safe projection state. */
function projectionStateFromFold(state: MedicalCaseFoldState): MedicalCaseProjectionState {
  return {
    current: state.current ?? null,
    seenCaseIds: [...state.seenCaseIds],
    failure: null,
  }
}

/**
 * Drive the strict case fold from one committed session event. A unit
 * uninterested in the event returns the same state reference, so the registry
 * performs no downstream work; the first malformed record latches a failure
 * that every later read reports instead of silently skipping it.
 * @param state - projection state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection state, or the same reference when it did not change.
 */
export function applyMedicalCaseProjection(
  state: MedicalCaseProjectionState,
  event: SessionEvent,
): MedicalCaseProjectionState {
  if (state.failure !== null) return state
  if (event.type !== 'medical/case-change') return state
  const folded = foldStateFromProjection(state)
  try {
    applyMedicalCaseEvent(folded, event)
    return projectionStateFromFold(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- strict decoding throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `medical case replay failed at session event ${event.seq}: ${message}` }
  }
}

/**
 * The `medicalCase` projection unit: host-only, because the folded value carries
 * clinical free text that no client wire surface should carry.
 *
 * Bump {@link medicalCaseProjectionDefinition.stateVersion} whenever the
 * serialized fields or the fold semantics change, so persisted checkpoint rows
 * from an older unit are discarded rather than forward-applied.
 */
export const medicalCaseProjectionDefinition = {
  key: 'medicalCase',
  stateSchema: medicalCaseProjectionStateSchema,
  init: (): MedicalCaseProjectionState => ({ current: null, seenCaseIds: [], failure: null }),
  apply: applyMedicalCaseProjection,
  stateVersion: 1,
} satisfies ProjectionDefinition<'medicalCase', MedicalCaseProjectionState>

/** Build the read model from one authoritative state. */
function caseView(state: CaseState): CaseView {
  return { ...state, missingFields: deriveMissingFields(state) }
}

/**
 * The medical intake case service (`ctx.medicalCase`), backed exclusively by
 * the owning session log. Every mutation appends a full-state
 * `medical/case-change` event and returns the resulting authoritative view;
 * a mutation that would change nothing appends no event and keeps the revision.
 */
export class MedicalCaseService extends Service {
  static inject = ['agents', 'sessionProjections']

  /**
   * @param ctx - context carrying the agent registry and the projection registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'medicalCase')
    ctx.sessionProjections.register(medicalCaseProjectionDefinition)
  }

  /**
   * Read the current case for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view, or `undefined` when no case has been recorded.
   * @throws {@link MedicalCaseError} when the agent is not the registry's live instance.
   */
  get(agent: Agent): CaseView | undefined {
    this.assertLive(agent)
    const state = this.state(agent.session)
    return state === null ? undefined : caseView(state)
  }

  /**
   * Read the current case, failing when this session has none.
   * @param agent - owning live agent.
   * @returns a fresh view.
   * @throws {@link MedicalCaseError} when no case exists or the agent is not live.
   */
  require(agent: Agent): CaseView {
    this.assertLive(agent)
    const state = this.state(agent.session)
    if (state === null) {
      throw new MedicalCaseError('this session has no recorded medical case yet', 'CASE_NOT_FOUND')
    }
    return caseView(state)
  }

  /**
   * Record the first-contact case for one exact live agent.
   * @param agent - owning live agent.
   * @param request - the facts the user has volunteered so far; any may be omitted.
   * @returns the created view at revision one.
   * @throws {@link MedicalCaseError} when a case already exists.
   */
  create(agent: Agent, request: CaseIntakeRequest): CaseUpdateResult {
    this.assertLive(agent)
    if (this.state(agent.session) !== null) {
      throw new MedicalCaseError('this session already has a medical case; update it instead', 'CASE_ALREADY_EXISTS')
    }
    return this.commit(
      agent,
      'create',
      createCaseState(CaseId(randomUUID()), resolveIntakeFields(request), Date.now()),
    )
  }

  /**
   * Record what the user just described. Creates the case when the session has
   * none, and otherwise treats the request as a restatement of the record.
   * @param agent - owning live agent.
   * @param request - the facts the user volunteered in this message.
   * @returns the authoritative view and whether it changed.
   */
  intake(agent: Agent, request: CaseIntakeRequest): CaseUpdateResult {
    this.assertLive(agent)
    const current = this.state(agent.session)
    if (current === null) return this.create(agent, request)
    const next = applyIntakeRequest(current, request, Date.now())
    if (next === undefined) return { view: caseView(current), changed: false }
    return this.commit(agent, 'update', next)
  }

  /**
   * Apply one incremental patch to the current case.
   * @param agent - owning live agent.
   * @param patch - the change; an omitted field keeps its recorded value.
   * @returns the authoritative view and whether it changed.
   * @throws {@link MedicalCaseError} when no case exists or the patch is invalid.
   */
  applyPatch(agent: Agent, patch: CasePatch): CaseUpdateResult {
    this.assertLive(agent)
    const current = this.state(agent.session)
    if (current === null) {
      throw new MedicalCaseError('this session has no recorded medical case yet; record it first', 'CASE_NOT_FOUND')
    }
    const next = applyCasePatch(current, patch, Date.now())
    if (next === undefined) return { view: caseView(current), changed: false }
    return this.commit(agent, 'update', next)
  }

  /** Reject callers that are not the exact instance this registry hosts. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new MedicalCaseError(`agent "${agent.id}" is not live in this registry`, 'CASE_AGENT_NOT_LIVE')
    }
  }

  /** Read the current durable projection maintained by the registry. */
  private state(session: Session): CaseState | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'medicalCase')
    /* v8 ignore next -- static inject requires the projection registry before this service activates */
    if (state === undefined) throw new Error('medicalCase projection is not registered')
    if (state.failure !== null) throw new MedicalCaseError(state.failure, 'CASE_STREAM_INVALID')
    return state.current
  }

  /**
   * Append one durable change and return the state the fold derived from it, so
   * a producer/fold disagreement surfaces at the mutation that caused it rather
   * than at a later read.
   */
  private commit(agent: Agent, operation: CaseOperation, next: CaseState): CaseUpdateResult {
    const change: MedicalCaseChangeMeta = {
      kind: 'medical/case-change',
      version: MEDICAL_CASE_CHANGE_VERSION,
      operation,
      case: next,
    }
    agent.session.append('medical/case-change', change)
    const committed = this.state(agent.session)
    /* v8 ignore next -- the change just committed is the latest case record */
    if (committed === null) throw new Error('medical case change committed without establishing a case')
    return { view: caseView(committed), changed: true }
  }
}

export default MedicalCaseService
