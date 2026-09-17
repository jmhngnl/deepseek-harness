/** Pure replay fold and strict decoder for durable medical case changes. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { MEDICAL_CASE_CHANGE_VERSION, MAX_AGE_YEARS, MedicalCaseError, CaseId } from './runtime.ts'
import type { FoldedMedicalCase, MedicalCaseChangeMeta } from './domain.ts'
import type { CaseId as CaseIdType, CaseState } from './types.ts'

/** Mutable accumulator kept private to the pure fold. */
export interface MedicalCaseFoldState {
  /** Latest valid case, absent before the first create. */
  current: CaseState | undefined
  /** Case identities already created in this Session, to reject reuse. */
  seenCaseIds: Set<CaseIdType>
  /** Latest mutation identity. */
  lastRef: { caseId: CaseIdType; revision: number } | undefined
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current case and no prior identity.
 */
export function emptyMedicalCaseFoldState(): MedicalCaseFoldState {
  return { current: undefined, seenCaseIds: new Set(), lastRef: undefined }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`medical case change ${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`medical case change ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Require a non-empty, already-normalized string. */
function normalizedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`medical case change ${field} must be a non-empty normalized string`)
  }
  return value
}

/** Require null or a non-empty, already-normalized string. */
function optionalNormalizedText(value: unknown, field: string): string | null {
  return value === null ? null : normalizedText(value, field)
}

/** Require null or a whole number of years within the accepted range. */
function optionalAge(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_AGE_YEARS) {
    throw new Error(`medical case change age must be null or a whole number of at most ${String(MAX_AGE_YEARS)} years`)
  }
  return value
}

/** Require the normalized symptom list: no blanks, no exact duplicates. */
function decodeSymptoms(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('medical case change symptoms must be an array')
  const symptoms = value.map(entry => normalizedText(entry, 'symptoms[]'))
  if (new Set(symptoms).size !== symptoms.length) {
    throw new Error('medical case change symptoms must not repeat an entry')
  }
  return symptoms
}

/** Strictly decode the durable case carried by one change. */
function decodeCaseState(value: unknown): CaseState {
  if (!isRecord(value)) throw new Error('medical case change case must be an object')
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt) throw new Error('medical case change update cannot precede its creation')
  return {
    caseId: CaseId(normalizedText(value['caseId'], 'caseId')),
    revision: positiveInteger(value['revision'], 'revision'),
    symptoms: decodeSymptoms(value['symptoms']),
    duration: optionalNormalizedText(value['duration'], 'duration'),
    age: optionalAge(value['age']),
    additionalNotes: optionalNormalizedText(value['additionalNotes'], 'additionalNotes'),
    createdAt,
    updatedAt,
  }
}

/**
 * Strictly decode one durable change payload.
 * @param value - untrusted payload read back from a session log.
 * @returns the decoded change, or undefined when the payload is not this domain's.
 */
export function decodeMedicalCaseChange(value: unknown): MedicalCaseChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'medical/case-change') return undefined
  if (value['version'] !== MEDICAL_CASE_CHANGE_VERSION) {
    throw new Error(`medical case change version ${String(value['version'])} is not supported`)
  }
  const operation = value['operation']
  if (operation !== 'create' && operation !== 'update') {
    throw new Error(`medical case change operation ${String(operation)} is not supported`)
  }
  return { kind: 'medical/case-change', version: MEDICAL_CASE_CHANGE_VERSION, operation, case: decodeCaseState(value['case']) }
}

/** Whether two states record the same facts, ignoring identity and timestamps. */
function recordsSameFacts(current: CaseState, next: CaseState): boolean {
  return next.symptoms.length === current.symptoms.length
    && next.symptoms.every((symptom, index) => symptom === current.symptoms[index])
    && next.duration === current.duration
    && next.age === current.age
    && next.additionalNotes === current.additionalNotes
}

/** Validate one create change against the preceding projection. */
function applyCreate(state: MedicalCaseFoldState, next: CaseState): void {
  if (state.current !== undefined) throw new Error('medical case create requires no current case')
  if (next.revision !== 1) throw new Error('medical case create must start at revision one')
  if (state.seenCaseIds.has(next.caseId)) {
    throw new Error(`medical case create reuses the already-seen id ${JSON.stringify(next.caseId)}`)
  }
}

/** Validate one update change against the preceding projection. */
function applyUpdate(state: MedicalCaseFoldState, next: CaseState): void {
  const current = state.current
  /* v8 ignore next -- the caller resolves `current` before dispatching on the operation */
  if (current === undefined) throw new Error('medical case update requires a current case')
  if (next.caseId !== current.caseId) throw new Error('medical case update must keep the current case id')
  if (next.revision !== current.revision + 1) {
    throw new Error('medical case update must advance the current case by one revision')
  }
  if (next.createdAt !== current.createdAt) throw new Error('medical case update cannot change the creation time')
  if (next.updatedAt < current.updatedAt) throw new Error('medical case update cannot move the mutation time backwards')
  // The service never writes an event for a patch that changed nothing, so a
  // repeated record means the producer and this fold disagree about the case.
  if (recordsSameFacts(current, next)) throw new Error('medical case update must change at least one recorded fact')
}

/**
 * Apply one decoded change to the accumulator, validating it strictly.
 * @param state - accumulator covering all prior events.
 * @param change - decoded durable change.
 */
export function applyMedicalCaseChange(state: MedicalCaseFoldState, change: MedicalCaseChangeMeta): void {
  if (change.operation === 'create') applyCreate(state, change.case)
  else applyUpdate(state, change.case)
  state.current = change.case
  state.seenCaseIds.add(change.case.caseId)
  state.lastRef = { caseId: change.case.caseId, revision: change.case.revision }
}

/**
 * Apply one committed session event to the accumulator. Events belonging to
 * other domains are ignored.
 * @param state - accumulator covering all prior events.
 * @param event - the next committed session event.
 */
export function applyMedicalCaseEvent(state: MedicalCaseFoldState, event: SessionEvent): void {
  if (event.type !== 'medical/case-change') return
  const change = decodeMedicalCaseChange(event.data)
  /* v8 ignore next -- the declaration merge types the payload as this domain's change */
  if (change === undefined) throw new Error('medical/case-change carried a foreign payload')
  applyMedicalCaseChange(state, change)
}

/**
 * Fold every durable case fact in a session log.
 * @param events - the committed events, in sequence order.
 * @returns the immutable folded result.
 * @throws when any case record is malformed or inconsistent.
 */
export function foldMedicalCase(events: readonly SessionEvent[]): FoldedMedicalCase {
  const state = emptyMedicalCaseFoldState()
  for (const event of events) applyMedicalCaseEvent(state, event)
  return {
    ...state.current === undefined ? {} : { current: state.current },
    seenCaseIds: [...state.seenCaseIds],
    ...state.lastRef === undefined ? {} : { lastRef: state.lastRef },
  }
}

/**
 * Attribute a strict-decoding failure to this domain without losing the reason
 * a reader needs to diagnose the log.
 * @param error - the failure raised while decoding or validating a record.
 * @returns the domain error to surface.
 */
export function caseReplayError(error: unknown): MedicalCaseError {
  const message = error instanceof Error ? error.message : String(error)
  return new MedicalCaseError(`durable medical case stream is invalid: ${message}`, 'CASE_STREAM_INVALID')
}
