/**
 * Pure contract coverage for the medical case domain: symptom normalization,
 * the patch merge rules, the derived missing-field report, and the revision
 * semantics that decide whether a mutation is durable at all.
 *
 * Timestamps are arguments here, never clock reads, so these cases pin the
 * merge contract without controlling time.
 */

import { describe, expect, it } from 'vitest'
import {
  applyCasePatch,
  applyIntakeRequest,
  createCaseState,
  deriveMissingFields,
  normalizeSymptoms,
  resolveIntakeFields,
} from '../src/patch.ts'
import { CaseId, MAX_AGE_YEARS, MedicalCaseError } from '../src/runtime.ts'
import type { CaseState } from '../src/types.ts'

const CASE_ID = CaseId('case-1')
const CREATED_AT = 1_000
const NOW = 2_000

/** A complete, fully recorded case used as the patching subject. */
function recorded(overrides: Partial<CaseState> = {}): CaseState {
  return {
    caseId: CASE_ID,
    revision: 1,
    symptoms: ['headache', 'fever'],
    duration: '2 days',
    age: 25,
    additionalNotes: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

/** Capture the domain error one call raises. */
function rejection(run: () => unknown): MedicalCaseError {
  try {
    run()
  } catch (error) {
    if (error instanceof MedicalCaseError) return error
    throw error
  }
  throw new Error('expected the domain to reject this call')
}

describe('deriveMissingFields', () => {
  it('reports the three required facts for a case with nothing recorded', () => {
    const empty = createCaseState(CASE_ID, resolveIntakeFields({}), NOW)
    expect(deriveMissingFields(empty)).toEqual(['symptoms', 'duration', 'age'])
  })

  it('reports nothing missing once every required fact is recorded', () => {
    expect(deriveMissingFields(recorded())).toEqual([])
  })

  it('never reports additionalNotes, which is optional context', () => {
    expect(deriveMissingFields(recorded({ additionalNotes: null }))).toEqual([])
  })

  it('reports each fact independently', () => {
    expect(deriveMissingFields(recorded({ symptoms: [] }))).toEqual(['symptoms'])
    expect(deriveMissingFields(recorded({ duration: null }))).toEqual(['duration'])
    expect(deriveMissingFields(recorded({ age: null }))).toEqual(['age'])
  })
})

describe('normalizeSymptoms', () => {
  it('trims entries, drops blanks, and keeps first-seen order', () => {
    expect(normalizeSymptoms(['  headache ', 'fever', '', '   ', '\t'])).toEqual(['headache', 'fever'])
  })

  it('deduplicates exact repeats without reordering', () => {
    expect(normalizeSymptoms(['fever', 'cough', 'fever'])).toEqual(['fever', 'cough'])
  })
})

describe('createCaseState', () => {
  it('starts at revision one with both timestamps from the caller', () => {
    expect(createCaseState(CASE_ID, resolveIntakeFields({ symptoms: ['cough'] }), NOW)).toEqual({
      caseId: CASE_ID,
      revision: 1,
      symptoms: ['cough'],
      duration: null,
      age: null,
      additionalNotes: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
})

describe('applyCasePatch keeps omitted fields', () => {
  it('changes only the supplied field', () => {
    const next = applyCasePatch(recorded(), { duration: '3 days' }, NOW)
    expect(next).toEqual(recorded({ revision: 2, duration: '3 days', updatedAt: NOW }))
  })

  it('appends without disturbing recorded symptoms', () => {
    const next = applyCasePatch(recorded(), { symptomsAdd: ['nausea'] }, NOW)
    expect(next?.symptoms).toEqual(['headache', 'fever', 'nausea'])
  })

  it('never reorders recorded symptoms when appending', () => {
    const next = applyCasePatch(recorded(), { symptomsAdd: ['nausea', 'cough'] }, NOW)
    expect(next?.symptoms).toEqual(['headache', 'fever', 'nausea', 'cough'])
  })

  it('removes a recorded symptom and preserves the rest in order', () => {
    const next = applyCasePatch(recorded(), { symptomsRemove: ['headache'] }, NOW)
    expect(next?.symptoms).toEqual(['fever'])
  })

  it('ignores an add of an already recorded symptom instead of duplicating it', () => {
    const next = applyCasePatch(recorded(), { symptomsAdd: ['fever'] }, NOW)
    expect(next).toBeUndefined()
  })

  it('accepts add and remove together when they name different symptoms', () => {
    const next = applyCasePatch(recorded(), { symptomsAdd: ['nausea'], symptomsRemove: ['fever'] }, NOW)
    expect(next?.symptoms).toEqual(['headache', 'nausea'])
  })
})

describe('applyCasePatch rejects ambiguity instead of guessing', () => {
  it('refuses to combine a replacement list with the deltas', () => {
    expect(rejection(() => applyCasePatch(recorded(), { symptoms: ['cough'], symptomsAdd: ['nausea'] }, NOW)).code)
      .toBe('CASE_INVALID_PATCH')
    expect(rejection(() => applyCasePatch(recorded(), { symptoms: ['cough'], symptomsRemove: ['fever'] }, NOW)).code)
      .toBe('CASE_INVALID_PATCH')
  })

  it('refuses a symptom that is both added and removed', () => {
    const error = rejection(() => applyCasePatch(recorded(), { symptomsAdd: [' nausea '], symptomsRemove: ['nausea'] }, NOW))
    expect(error.code).toBe('CASE_INVALID_SYMPTOMS')
    expect(error.message).toContain('nausea')
  })

  it('refuses an empty replacement list, which could only mean clearing the case', () => {
    expect(rejection(() => applyCasePatch(recorded(), { symptoms: [] }, NOW)).code).toBe('CASE_INVALID_SYMPTOMS')
    expect(rejection(() => applyCasePatch(recorded(), { symptoms: ['  ', ''] }, NOW)).code).toBe('CASE_INVALID_SYMPTOMS')
  })

  it('refuses a blank string rather than treating it as a clear', () => {
    expect(rejection(() => applyCasePatch(recorded(), { duration: '   ' }, NOW)).code).toBe('CASE_INVALID_DURATION')
    expect(rejection(() => applyCasePatch(recorded(), { additionalNotes: '' }, NOW)).code).toBe('CASE_INVALID_NOTES')
  })

  it('refuses an age that is not a whole number of years in range', () => {
    for (const age of [-1, 1.5, MAX_AGE_YEARS + 1]) {
      expect(rejection(() => applyCasePatch(recorded(), { age }, NOW)).code).toBe('CASE_INVALID_AGE')
    }
  })

  it('accepts both age range endpoints', () => {
    expect(applyCasePatch(recorded(), { age: 0 }, NOW)?.age).toBe(0)
    expect(applyCasePatch(recorded(), { age: MAX_AGE_YEARS }, NOW)?.age).toBe(MAX_AGE_YEARS)
  })
})

describe('applyCasePatch revision semantics', () => {
  it('returns undefined for a patch that changes nothing durable', () => {
    expect(applyCasePatch(recorded(), {}, NOW)).toBeUndefined()
    expect(applyCasePatch(recorded(), { duration: '2 days' }, NOW)).toBeUndefined()
    expect(applyCasePatch(recorded(), { symptomsRemove: ['nausea'] }, NOW)).toBeUndefined()
  })

  it('advances exactly one revision and preserves the creation time', () => {
    const next = applyCasePatch(recorded({ revision: 4 }), { age: 26 }, NOW)
    expect(next?.revision).toBe(5)
    expect(next?.createdAt).toBe(CREATED_AT)
  })

  it('never moves the mutation time backwards when the clock does', () => {
    const next = applyCasePatch(recorded({ updatedAt: 5_000 }), { age: 26 }, 4_000)
    expect(next?.updatedAt).toBe(5_000)
    expect(next?.revision).toBe(2)
  })

  it('keeps the case identity for the whole life of the case', () => {
    expect(applyCasePatch(recorded(), { age: 26 }, NOW)?.caseId).toBe(CASE_ID)
  })
})

describe('applyIntakeRequest restates an existing case', () => {
  it('keeps every omitted field', () => {
    expect(applyIntakeRequest(recorded(), { age: 26 }, NOW)).toEqual(
      recorded({ revision: 2, age: 26, updatedAt: NOW }),
    )
  })

  it('replaces the symptom list when the request restates it', () => {
    expect(applyIntakeRequest(recorded(), { symptoms: ['cough'] }, NOW)?.symptoms).toEqual(['cough'])
  })

  it('returns undefined when the restatement matches the record', () => {
    expect(applyIntakeRequest(recorded(), { symptoms: ['headache', 'fever'], age: 25 }, NOW)).toBeUndefined()
  })

  it('refuses to erase recorded facts through a blank or an empty list', () => {
    expect(rejection(() => applyIntakeRequest(recorded(), { symptoms: [] }, NOW)).code).toBe('CASE_INVALID_SYMPTOMS')
    expect(rejection(() => applyIntakeRequest(recorded(), { duration: '  ' }, NOW)).code).toBe('CASE_INVALID_DURATION')
  })
})
