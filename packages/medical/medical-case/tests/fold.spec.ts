/**
 * Strict replay coverage: the decoder refuses anything it cannot interpret
 * exactly, and the fold refuses any record that the producer contract could not
 * have written. Both failures are loud, and the first one latches.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeMedicalCaseChange, applyMedicalCaseChange, applyMedicalCaseEvent, emptyMedicalCaseFoldState, foldMedicalCase } from '../src/fold.ts'
import type { MedicalCaseFoldState } from '../src/fold.ts'
import type { MedicalCaseChangeMeta } from '../src/domain.ts'
import { CaseId } from '../src/runtime.ts'
import type { CaseOperation, CaseState } from '../src/types.ts'

const CASE_ID = CaseId('case-1')

/** A complete case record as the service would publish it. */
function record(overrides: Partial<CaseState> = {}): CaseState {
  return {
    caseId: CASE_ID,
    revision: 1,
    symptoms: ['headache', 'fever'],
    duration: '2 days',
    age: 25,
    additionalNotes: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** One durable change carrying a full state. */
function change(overrides: Partial<CaseState> = {}, operation: CaseOperation = 'create'): MedicalCaseChangeMeta {
  return { kind: 'medical/case-change', version: 1, operation, case: record(overrides) }
}

/** The raw payload of a change, as it appears before decoding. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'medical/case-change', version: 1, operation: 'create', case: { ...record() }, ...overrides }
}

/** Capture the error one fold rejection raises. */
function foldFailure(state: MedicalCaseFoldState, change: MedicalCaseChangeMeta): string {
  try {
    applyMedicalCaseChange(state, change)
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('expected the fold to reject this change')
}

/** Capture the error one decode raises. */
function decodeFailure(value: unknown): Error {
  try {
    decodeMedicalCaseChange(value)
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected the decoder to reject this payload')
}

describe('decodeMedicalCaseChange', () => {
  it('ignores a payload that belongs to another domain', () => {
    expect(decodeMedicalCaseChange({ kind: 'something/else' })).toBeUndefined()
    expect(decodeMedicalCaseChange(null)).toBeUndefined()
    expect(decodeMedicalCaseChange('medical/case-change')).toBeUndefined()
  })

  it('accepts exactly the shape the service publishes', () => {
    expect(decodeMedicalCaseChange(raw())).toEqual(change())
  })

  it('refuses a payload version this build does not know', () => {
    expect(decodeFailure(raw({ version: 2 })).message).toContain('version')
  })

  it('refuses an operation outside the closed set', () => {
    expect(decodeFailure(raw({ operation: 'clear' })).message).toContain('operation')
  })

  it('refuses a case body that is not a record', () => {
    expect(decodeFailure(raw({ case: 'case-1' })).message).toContain('must be an object')
    expect(decodeFailure(raw({ case: null })).message).toContain('must be an object')
  })

  it('refuses an identity that is blank or not normalized', () => {
    expect(decodeFailure(raw({ case: { ...record(), caseId: '' } })).message).toContain('caseId')
    expect(decodeFailure(raw({ case: { ...record(), caseId: ' case-1' } })).message).toContain('caseId')
  })

  it('refuses a revision that is not a positive integer', () => {
    for (const revision of [0, -1, 1.5]) {
      expect(decodeFailure(raw({ case: { ...record(), revision } })).message).toContain('revision')
    }
  })

  it('refuses symptoms that are blank, unnormalized, or repeated', () => {
    expect(decodeFailure(raw({ case: { ...record(), symptoms: [''] } })).message).toContain('symptoms')
    expect(decodeFailure(raw({ case: { ...record(), symptoms: [' fever'] } })).message).toContain('symptoms')
    expect(decodeFailure(raw({ case: { ...record(), symptoms: ['fever', 'fever'] } })).message).toContain('must not repeat')
    expect(decodeFailure(raw({ case: { ...record(), symptoms: 'fever' } })).message).toContain('must be an array')
  })

  it('refuses optional text that is present but blank', () => {
    expect(decodeFailure(raw({ case: { ...record(), duration: '' } })).message).toContain('duration')
    expect(decodeFailure(raw({ case: { ...record(), additionalNotes: ' ' } })).message).toContain('additionalNotes')
  })

  it('refuses an age outside the accepted range or not whole', () => {
    for (const age of [-1, 1.5, 131]) {
      expect(decodeFailure(raw({ case: { ...record(), age } })).message).toContain('age')
    }
  })

  it('refuses a mutation time that precedes creation', () => {
    expect(decodeFailure(raw({ case: { ...record(), createdAt: 5, updatedAt: 4 } })).message).toContain('precede')
  })
})

describe('applyMedicalCaseChange', () => {
  it('establishes revision one on create', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change())
    expect(state.current).toEqual(record())
    expect(state.lastRef).toEqual({ caseId: CASE_ID, revision: 1 })
    expect([...state.seenCaseIds]).toEqual([CASE_ID])
  })

  it('refuses a second create in the same session', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change())
    expect(foldFailure(state, change())).toMatch(/requires no current case/)
  })

  it('refuses a create that does not start at revision one', () => {
    const state = emptyMedicalCaseFoldState()
    expect(foldFailure(state, change({ revision: 2 }))).toMatch(/revision one/)
  })

  it('refuses an update before any case exists', () => {
    const state = emptyMedicalCaseFoldState()
    expect(foldFailure(state, change({}, 'update'))).toMatch(/requires a current case/)
  })

  it('refuses an update that swaps the case identity', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change())
    expect(foldFailure(state, change({ caseId: CaseId('case-2'), revision: 2, age: 26 }, 'update'))).toMatch(/keep the current case id/)
  })

  it('refuses an update that skips or repeats a revision', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change())
    for (const revision of [1, 3]) {
      expect(foldFailure(state, change({ revision, age: 26 }, 'update'))).toMatch(/advance the current case by one revision/)
    }
  })

  it('refuses an update that rewrites the creation time', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change())
    expect(foldFailure(state, change({ revision: 2, age: 26, createdAt: 9, updatedAt: 9 }, 'update'))).toMatch(/cannot change the creation time/)
  })

  it('refuses an update that moves the mutation time backwards', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change({ updatedAt: 5_000 }))
    expect(foldFailure(state, change({ revision: 2, age: 26, updatedAt: 4_999 }, 'update'))).toMatch(/backwards/)
  })

  it('refuses an update that records the same facts, which the service never writes', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change())
    expect(foldFailure(state, change({ revision: 2, updatedAt: 2_000 }, 'update'))).toMatch(/change at least one recorded fact/)
  })

  it('advances one revision and accumulates the projection', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseChange(state, change())
    applyMedicalCaseChange(state, change({ revision: 2, duration: '3 days', updatedAt: 2_000 }, 'update'))
    expect(state.current).toEqual(record({ revision: 2, duration: '3 days', updatedAt: 2_000 }))
  })
})

describe('applyMedicalCaseEvent', () => {
  it('ignores an event belonging to another domain', () => {
    const state = emptyMedicalCaseFoldState()
    applyMedicalCaseEvent(state, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as never)
    expect(state.current).toBeUndefined()
    expect([...state.seenCaseIds]).toEqual([])
  })

  it('applies this domain\u2019s committed event', () => {
    const state = emptyMedicalCaseFoldState()
    const event = { type: 'medical/case-change', seq: 1, time: 1, data: change() } as never
    applyMedicalCaseEvent(state, event)
    expect(state.current).toEqual(record())
  })
})

describe('foldMedicalCase', () => {
  it('reports no case for a log that never recorded one', () => {
    expect(foldMedicalCase([])).toEqual({ seenCaseIds: [] })
  })

  it('replays the whole case history from the log alone', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'medical/case-change', seq: 1, time: 1, data: change() },
      { type: 'medical/case-change', seq: 2, time: 2, data: change({ revision: 2, age: 26, updatedAt: 2_000 }, 'update') },
    ] as readonly SessionEvent[]
    const folded = foldMedicalCase(events)
    expect(folded.current).toEqual(record({ revision: 2, age: 26, updatedAt: 2_000 }))
    expect(folded.lastRef).toEqual({ caseId: CASE_ID, revision: 2 })
    expect(folded.seenCaseIds).toEqual([CASE_ID])
  })

  it('stops at the first malformed record instead of skipping it', () => {
    const events = [
      { type: 'medical/case-change', seq: 1, time: 1, data: change() },
      { type: 'medical/case-change', seq: 2, time: 2, data: change({ revision: 4, age: 26, updatedAt: 2_000 }, 'update') },
    ] as readonly SessionEvent[]
    expect(() => foldMedicalCase(events)).toThrow(/advance the current case by one revision/)
  })
})
