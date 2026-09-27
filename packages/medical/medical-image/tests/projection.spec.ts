/**
 * Projection coverage: the unit the registry drives, the strict checkpoint
 * schema it validates restored state with, and the latched failure a malformed
 * durable record produces.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyMedicalImageProjection,
  medicalImageProjectionDefinition,
  medicalImageProjectionStateSchema,
} from '../src/index.ts'
import type { MedicalImageProjectionState } from '../src/index.ts'

const ATTACHMENT_ID = `sha256:${'a'.repeat(64)}`

/** One observation in the plain JSON shape the checkpoint schema validates. */
function storedObservation(attachmentId = ATTACHMENT_ID): Record<string, unknown> {
  return {
    attachment: { attachmentId, mediaType: 'image/png', bytes: 2_048, width: 640, height: 480 },
    revision: 1,
    bodyRegion: 'left forearm',
    findings: ['irregular red patch'],
    quality: { usable: true, issues: ['blur'] },
    uncertainty: [],
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

/** One durable change payload as it appears before decoding. */
function payload(observation: Record<string, unknown> = storedObservation()): Record<string, unknown> {
  return { kind: 'medical/image-observation', version: 1, operation: 'observe', observation }
}

const EMPTY: MedicalImageProjectionState = { observations: [], failure: null }

describe('applyMedicalImageProjection', () => {
  it('returns the same state reference for an event belonging to another domain', () => {
    const unrelated: SessionEvent = { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } }
    expect(applyMedicalImageProjection(EMPTY, unrelated)).toBe(EMPTY)
  })

  it('folds this domain\u2019s committed event into a new state', () => {
    const event: SessionEvent = {
      type: 'medical/image-observation',
      seq: SessionSeq(1),
      time: 1,
      data: payload() as never,
    }
    const next = applyMedicalImageProjection(EMPTY, event)
    expect(next).not.toBe(EMPTY)
    expect(next.failure).toBeNull()
    expect(next.observations).toHaveLength(1)
    expect(String(next.observations[0]?.attachment.attachmentId)).toBe(ATTACHMENT_ID)
  })

  it('latches a failure on a malformed record instead of skipping it', () => {
    const event: SessionEvent = {
      type: 'medical/image-observation',
      seq: SessionSeq(7),
      time: 1,
      data: { kind: 'medical/image-observation', version: 1, operation: 'observe' } as never,
    }
    const next = applyMedicalImageProjection(EMPTY, event)
    expect(next.failure).toContain('medical image replay failed at session event 7')
    expect(next.failure).toContain('observation must be an object')
  })

  it('stops folding once a failure is latched', () => {
    const latched: MedicalImageProjectionState = { observations: [], failure: 'already broken' }
    const event: SessionEvent = {
      type: 'medical/image-observation',
      seq: SessionSeq(1),
      time: 1,
      data: payload() as never,
    }
    expect(applyMedicalImageProjection(latched, event)).toBe(latched)
  })
})

describe('the medicalImage projection definition', () => {
  it('declares its key, version, and empty initial state', () => {
    expect(medicalImageProjectionDefinition.key).toBe('medicalImage')
    expect(medicalImageProjectionDefinition.stateVersion).toBe(1)
    expect(medicalImageProjectionDefinition.init()).toEqual({ observations: [], failure: null })
  })
})

describe('the checkpoint state schema', () => {
  it('accepts an empty state and a state holding one observation', () => {
    expect(medicalImageProjectionStateSchema.safeParse(EMPTY).success).toBe(true)
    const populated = { observations: [storedObservation()], failure: null }
    expect(medicalImageProjectionStateSchema.safeParse(populated).success).toBe(true)
  })

  it('refuses two observations of one attachment', () => {
    const duplicated = { observations: [storedObservation(), storedObservation()], failure: null }
    const result = medicalImageProjectionStateSchema.safeParse(duplicated)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('observations must be unique by attachment')
  })

  it('refuses an unknown field rather than dropping it', () => {
    expect(medicalImageProjectionStateSchema.safeParse({ ...EMPTY, extra: 1 }).success).toBe(false)
  })

  it('refuses an observation that does not match the durable shape', () => {
    expect(medicalImageProjectionStateSchema.safeParse({
      observations: [{ ...storedObservation(), revision: 0 }],
      failure: null,
    }).success).toBe(false)
    expect(medicalImageProjectionStateSchema.safeParse({
      observations: [storedObservation('')],
      failure: null,
    }).success).toBe(false)
    expect(medicalImageProjectionStateSchema.safeParse({
      observations: [{ ...storedObservation(), quality: { usable: true, issues: ['diagnosis_visible'] } }],
      failure: null,
    }).success).toBe(false)
  })
})
