/**
 * Pure state arithmetic of the medical case domain: symptom normalization, the
 * patch merge contract, and the missing-field derivation.
 *
 * Nothing here reads a clock. The service boundary resolves the timestamps and
 * passes them in, so every rule below is a total function of its arguments and
 * a test never has to control time to pin merge behavior.
 *
 * @module @deepseek-ai/dsh-medical-case
 */

import type { CaseIntakeRequest, CasePatch, CaseState, MissingField } from './types.ts'
import { MAX_AGE_YEARS, MedicalCaseError } from './runtime.ts'

/** The four facts a case records, as resolved from one intake request. */
export interface ResolvedIntakeFields {
  readonly symptoms: string[]
  readonly duration: string | null
  readonly age: number | null
  readonly additionalNotes: string | null
}

/**
 * Derive the still-missing required facts from one authoritative state. This is
 * the only definition of "missing": nothing persists the result, so a recorded
 * field and its gap report cannot disagree.
 * @param state - the authoritative case state.
 * @returns required fields absent from `state`, in intake order.
 */
export function deriveMissingFields(state: CaseState): MissingField[] {
  const missing: MissingField[] = []
  if (state.symptoms.length === 0) missing.push('symptoms')
  if (state.duration === null) missing.push('duration')
  if (state.age === null) missing.push('age')
  return missing
}

/**
 * Normalize one symptom list: trim each entry, drop entries that are blank once
 * trimmed, and deduplicate by the trimmed text. First-seen order is preserved,
 * so appending never reorders what the user already said.
 * @param values - raw symptom strings, as supplied by the model.
 * @returns normalized symptoms with no blanks and no exact duplicates.
 */
export function normalizeSymptoms(values: readonly string[]): string[] {
  const normalized: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '' || normalized.includes(trimmed)) continue
    normalized.push(trimmed)
  }
  return normalized
}

/**
 * Resolve one intake request. Omitted or blank fields stay null so a case can
 * be created while the user has said nothing about them yet.
 * @param request - the model-supplied first-contact input.
 * @returns the four recordable facts, with blanks materialized as null.
 */
export function resolveIntakeFields(request: CaseIntakeRequest): ResolvedIntakeFields {
  return {
    symptoms: normalizeSymptoms(request.symptoms ?? []),
    duration: optionalText(request.duration),
    age: request.age === undefined ? null : requireAge(request.age),
    additionalNotes: optionalText(request.additionalNotes),
  }
}

/**
 * Build the revision-one state for a newly created case.
 * @param caseId - identity the service minted for this case.
 * @param fields - resolved intake fields.
 * @param now - epoch milliseconds resolved at the service boundary.
 * @returns the complete initial state.
 */
export function createCaseState(
  caseId: CaseState['caseId'],
  fields: ResolvedIntakeFields,
  now: number,
): CaseState {
  return {
    caseId,
    revision: 1,
    symptoms: fields.symptoms,
    duration: fields.duration,
    age: fields.age,
    additionalNotes: fields.additionalNotes,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Apply one patch to an existing state. An omitted field keeps its value; there
 * is no parameter that clears one. A patch that changes nothing returns
 * undefined so the caller appends no event and keeps the revision.
 * @param current - the authoritative state being changed.
 * @param patch - the model-supplied change.
 * @param now - epoch milliseconds resolved at the service boundary.
 * @returns the next revision-one-higher state, or undefined for a no-op.
 * @throws {@link MedicalCaseError} when the patch is ambiguous or invalid.
 */
export function applyCasePatch(current: CaseState, patch: CasePatch, now: number): CaseState | undefined {
  const replaces = patch.symptoms !== undefined
  const additive = patch.symptomsAdd !== undefined || patch.symptomsRemove !== undefined
  if (replaces && additive) {
    throw new MedicalCaseError(
      'symptoms cannot be combined with symptomsAdd or symptomsRemove in one call: pass symptoms to replace the whole list, or the deltas to change it',
      'CASE_INVALID_PATCH',
    )
  }

  const next: {
    symptoms: string[]
    duration: string | null
    age: number | null
    additionalNotes: string | null
  } = {
    symptoms: current.symptoms,
    duration: current.duration,
    age: current.age,
    additionalNotes: current.additionalNotes,
  }

  if (replaces) next.symptoms = resolveReplacementSymptoms(patch.symptoms ?? [])
  else if (additive) next.symptoms = resolveSymptomDelta(current.symptoms, patch)

  if (patch.duration !== undefined) next.duration = requireText(patch.duration, 'duration', 'CASE_INVALID_DURATION')
  if (patch.age !== undefined) next.age = requireAge(patch.age)
  if (patch.additionalNotes !== undefined) {
    next.additionalNotes = requireText(patch.additionalNotes, 'additionalNotes', 'CASE_INVALID_NOTES')
  }

  const changed = !recordsSameFacts(current, next)
  if (!changed) return undefined
  return nextRevision(current, next, now)
}

/**
 * Apply one intake request to an existing case. The request is a restatement
 * of the record: a field it supplies replaces the recorded value, and a field
 * it omits keeps it.
 *
 * The create path tolerates a blank because there is nothing to lose yet; once
 * a case exists the same blank could only mean "erase the recorded fact", so it
 * is rejected exactly as a patch would reject it. `medical_case_intake`
 * therefore keeps its Phase 1 behavior of creating an incomplete case from `{}`
 * while never silently clearing one.
 * @param current - the authoritative state being restated.
 * @param request - the model-supplied first-contact input.
 * @param now - epoch milliseconds resolved at the service boundary.
 * @returns the next revision state, or undefined for a no-op restatement.
 * @throws {@link MedicalCaseError} when the request is invalid.
 */
export function applyIntakeRequest(current: CaseState, request: CaseIntakeRequest, now: number): CaseState | undefined {
  const next = {
    symptoms: request.symptoms === undefined
      ? current.symptoms
      : resolveReplacementSymptoms(request.symptoms),
    duration: request.duration === undefined
      ? current.duration
      : requireText(request.duration, 'duration', 'CASE_INVALID_DURATION'),
    age: request.age === undefined ? current.age : requireAge(request.age),
    additionalNotes: request.additionalNotes === undefined
      ? current.additionalNotes
      : requireText(request.additionalNotes, 'additionalNotes', 'CASE_INVALID_NOTES'),
  }
  if (recordsSameFacts(current, next)) return undefined
  return nextRevision(current, next, now)
}

/** Whether two fact sets are interchangeable, ignoring identity and timestamps. */
function recordsSameFacts(
  current: CaseState,
  next: Pick<CaseState, 'symptoms' | 'duration' | 'age' | 'additionalNotes'>,
): boolean {
  return next.symptoms.length === current.symptoms.length
    && next.symptoms.every((symptom, index) => symptom === current.symptoms[index])
    && next.duration === current.duration
    && next.age === current.age
    && next.additionalNotes === current.additionalNotes
}

/**
 * Advance one state by exactly one revision.
 *
 * A wall clock that steps backwards must never publish a stale timestamp, which
 * strict replay would reject as a non-monotonic record.
 */
function nextRevision(
  current: CaseState,
  next: Pick<CaseState, 'symptoms' | 'duration' | 'age' | 'additionalNotes'>,
  now: number,
): CaseState {
  return {
    caseId: current.caseId,
    revision: current.revision + 1,
    ...next,
    createdAt: current.createdAt,
    updatedAt: Math.max(now, current.updatedAt),
  }
}

/**
 * Reject an explicit clear-all: erasing every symptom is never what a
 * follow-up sentence means, and Phase 2 has no way to express the intent.
 */
function resolveReplacementSymptoms(values: readonly string[]): string[] {
  const replacement = normalizeSymptoms(values)
  if (replacement.length === 0) {
    throw new MedicalCaseError(
      'symptoms must name at least one symptom: an empty list cannot clear a recorded case',
      'CASE_INVALID_SYMPTOMS',
    )
  }
  return replacement
}

/** Merge one add/remove delta over the recorded symptoms. */
function resolveSymptomDelta(current: readonly string[], patch: CasePatch): string[] {
  const add = normalizeSymptoms(patch.symptomsAdd ?? [])
  const remove = normalizeSymptoms(patch.symptomsRemove ?? [])
  const contradictory = add.filter(symptom => remove.includes(symptom))
  if (contradictory.length > 0) {
    throw new MedicalCaseError(
      `symptomsAdd and symptomsRemove both name ${JSON.stringify(contradictory)}: the call has no single meaning`,
      'CASE_INVALID_SYMPTOMS',
    )
  }
  const removed = current.filter(symptom => remove.includes(symptom))
  const merged = current.filter(symptom => !remove.includes(symptom))
  for (const symptom of add) {
    if (!merged.includes(symptom)) merged.push(symptom)
  }
  // The clear-all rule the replacement path enforces, reached one entry at a
  // time: a `symptomsRemove` that takes every recorded symptom is an erasure,
  // and Phase 2 has no way to express that intent. The guard is conditional on
  // something having actually been removed, so naming a symptom the case never
  // held stays the no-op it already was, and filling in `age` on a case created
  // from an incomplete first contact — which a caller may spell with an empty
  // `symptomsAdd` — keeps working.
  if (removed.length > 0 && merged.length === 0) {
    throw new MedicalCaseError(
      'symptomsRemove cannot remove every recorded symptom: an empty list cannot clear a recorded case',
      'CASE_INVALID_SYMPTOMS',
    )
  }
  return merged
}

/** Treat an omitted or blank string as absent. */
function optionalText(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Require text a patch explicitly supplied. A blank patch value is rejected
 * rather than treated as a clear, so no caller clears a field by accident.
 */
function requireText(value: string, field: string, code: 'CASE_INVALID_DURATION' | 'CASE_INVALID_NOTES'): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new MedicalCaseError(`${field} cannot be blank; omit it to keep the recorded value`, code)
  return trimmed
}

/** Require a whole number of years within the accepted range. */
function requireAge(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_AGE_YEARS) {
    throw new MedicalCaseError(
      `age must be a whole number between 0 and ${String(MAX_AGE_YEARS)} years; received ${String(value)}`,
      'CASE_INVALID_AGE',
    )
  }
  return value
}
