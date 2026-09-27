/**
 * Strict replay coverage: the decoder refuses anything it cannot interpret
 * exactly, and the fold refuses any record that the producer contract could not
 * have written. Both failures are loud, and the projection unit that drives this
 * fold latches the first one.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  applyMedicalImageChange,
  applyMedicalImageEvent,
  decodeMedicalImageChange,
  emptyMedicalImageFoldState,
  foldMedicalImage,
  imageReplayError,
} from '../src/fold.ts'
import type { MedicalImageFoldState } from '../src/fold.ts'
import type { MedicalImageChangeMeta } from '../src/domain.ts'
import type { ImageObservationOperation, MedicalImageObservation } from '../src/types.ts'

const ATTACHMENT = AttachmentId('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

/** A complete observation as the service would publish it. */
function record(overrides: Partial<MedicalImageObservation> = {}): MedicalImageObservation {
  return {
    attachment: {
      attachmentId: ATTACHMENT,
      mediaType: 'image/png',
      bytes: 2_048,
      width: 640,
      height: 480,
      name: 'rash.png',
    },
    revision: 1,
    bodyRegion: 'left forearm',
    findings: ['irregular red patch'],
    quality: { usable: true, issues: ['blur'] },
    uncertainty: ['depth cannot be judged from one view'],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** One durable change carrying a full observation. */
function change(
  overrides: Partial<MedicalImageObservation> = {},
  operation: ImageObservationOperation = 'observe',
): MedicalImageChangeMeta {
  return { kind: 'medical/image-observation', version: 1, operation, observation: record(overrides) }
}

/** The raw payload of a change, as it appears before decoding. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'medical/image-observation', version: 1, operation: 'observe', observation: { ...record() }, ...overrides }
}

/** The raw observation of a payload, with one field replaced. */
function rawObservation(field: string, value: unknown): Record<string, unknown> {
  return raw({ observation: { ...record(), [field]: value } })
}

/**
 * A thunk that runs the decoder on one payload, so a rejection can be asserted
 * with `toThrow` and a non-rejection fails the assertion rather than passing it.
 */
function decodeRejection(value: unknown): () => unknown {
  return () => decodeMedicalImageChange(value)
}

/** Capture the error one fold rejection raises. */
function foldFailure(state: MedicalImageFoldState, next: MedicalImageChangeMeta): string {
  try {
    applyMedicalImageChange(state, next)
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('expected the fold to reject this change')
}

describe('decodeMedicalImageChange', () => {
  it('ignores a payload belonging to another domain', () => {
    expect(decodeMedicalImageChange({ kind: 'medical/case-change', version: 1 })).toBeUndefined()
    expect(decodeMedicalImageChange('not an object')).toBeUndefined()
    expect(decodeMedicalImageChange(null)).toBeUndefined()
  })

  it('round-trips a well-formed observation', () => {
    expect(decodeMedicalImageChange(raw())).toEqual(change())
  })

  it('rejects an unsupported payload version rather than reading it as this one', () => {
    expect(decodeRejection(raw({ version: 2 }))).toThrow(/version 2 is not supported/)
  })

  it('rejects an unsupported operation', () => {
    expect(decodeRejection(raw({ operation: 'amend' }))).toThrow(/operation amend is not supported/)
  })

  it('rejects an observation that is not an object', () => {
    expect(decodeRejection(raw({ observation: [] }))).toThrow(/observation must be an object/)
  })

  it('rejects an attachment that is not an object', () => {
    expect(decodeRejection(rawObservation('attachment', 'sha256:x'))).toThrow(/attachment must be an object/)
  })

  it('rejects a blank or non-normalized attachment id', () => {
    expect(decodeRejection(rawObservation('attachment', { ...record().attachment, attachmentId: '' })))
      .toThrow(/attachmentId must be a non-empty normalized string/)
    expect(decodeRejection(rawObservation('attachment', { ...record().attachment, attachmentId: ' sha256:x ' })))
      .toThrow(/attachmentId must be a non-empty normalized string/)
  })

  it('rejects an attachment media type outside the admitted set', () => {
    expect(decodeRejection(rawObservation('attachment', { ...record().attachment, mediaType: 'image/tiff' })))
      .toThrow(/media type "image\/tiff" is not supported/)
  })

  it('rejects non-positive attachment dimensions and byte lengths', () => {
    expect(decodeRejection(rawObservation('attachment', { ...record().attachment, bytes: 0 })))
      .toThrow(/attachment.bytes must be a positive safe integer/)
    expect(decodeRejection(rawObservation('attachment', { ...record().attachment, width: -1 })))
      .toThrow(/attachment.width must be a positive safe integer/)
    expect(decodeRejection(rawObservation('attachment', { ...record().attachment, height: 1.5 })))
      .toThrow(/attachment.height must be a positive safe integer/)
  })

  it('rejects malformed original dimensions', () => {
    expect(decodeRejection(rawObservation('attachment', {
      ...record().attachment,
      originalDimensions: { width: 0, height: 10 },
    }))).toThrow(/originalDimensions.width must be a positive safe integer/)
    expect(decodeRejection(rawObservation('attachment', {
      ...record().attachment,
      originalDimensions: 10,
    }))).toThrow(/originalDimensions must be an object/)
  })

  it('rejects a non-positive revision', () => {
    expect(decodeRejection(rawObservation('revision', 0))).toThrow(/revision must be a positive safe integer/)
  })

  it('rejects blank findings, duplicates, and non-normalized text', () => {
    expect(decodeRejection(rawObservation('findings', ['  ']))).toThrow(/findings\[\] must be a non-empty normalized string/)
    expect(decodeRejection(rawObservation('findings', ['red patch', 'red patch']))).toThrow(/findings must not repeat an entry/)
    expect(decodeRejection(rawObservation('findings', 'red patch'))).toThrow(/findings must be an array/)
  })

  it('rejects a quality block that is not an object or lacks a boolean verdict', () => {
    expect(decodeRejection(rawObservation('quality', null))).toThrow(/quality must be an object/)
    expect(decodeRejection(rawObservation('quality', { usable: 'yes', issues: [] })))
      .toThrow(/quality.usable must be a boolean/)
    expect(decodeRejection(rawObservation('quality', { usable: true, issues: 'blur' })))
      .toThrow(/quality.issues must be an array/)
  })

  it('rejects an unknown quality issue', () => {
    expect(decodeRejection(rawObservation('quality', { usable: true, issues: ['diagnosis_visible'] })))
      .toThrow(/quality issue "diagnosis_visible" is not supported/)
  })

  it('rejects quality issues that are duplicated or out of canonical order', () => {
    expect(decodeRejection(rawObservation('quality', { usable: true, issues: ['blur', 'blur'] })))
      .toThrow(/unique and in canonical order/)
    expect(decodeRejection(rawObservation('quality', { usable: true, issues: ['too_distant', 'blur'] })))
      .toThrow(/unique and in canonical order/)
  })

  it('rejects an update that precedes its own creation', () => {
    expect(decodeRejection(rawObservation('updatedAt', 999))).toThrow(/cannot precede its creation/)
  })

  it('rejects a negative creation or mutation time', () => {
    expect(decodeRejection(rawObservation('createdAt', -1)))
      .toThrow(/createdAt must be a non-negative safe integer/)
    expect(decodeRejection(rawObservation('updatedAt', -1)))
      .toThrow(/updatedAt must be a non-negative safe integer/)
  })

  it('rejects a body region that is an empty or non-normalized string', () => {
    expect(decodeRejection(rawObservation('bodyRegion', ' left forearm')))
      .toThrow(/bodyRegion must be a non-empty normalized string/)
  })

  it('accepts a null body region and an absent display name', () => {
    expect(decodeMedicalImageChange(rawObservation('bodyRegion', null))?.observation.bodyRegion).toBeNull()
    const withoutName = { ...record().attachment } as Record<string, unknown>
    delete withoutName['name']
    expect(decodeMedicalImageChange(rawObservation('attachment', withoutName))?.observation.attachment.name)
      .toBeUndefined()
  })
})

describe('applyMedicalImageChange', () => {
  it('records a first observation at revision one', () => {
    const state = emptyMedicalImageFoldState()
    applyMedicalImageChange(state, change())
    expect([...state.observations.values()]).toEqual([record()])
  })

  it('refuses a first observation that does not start at revision one', () => {
    const state = emptyMedicalImageFoldState()
    expect(foldFailure(state, change({ revision: 2 }))).toMatch(/observe must start at revision one/)
  })

  it('refuses a second first-observation of the same attachment', () => {
    const state = emptyMedicalImageFoldState()
    applyMedicalImageChange(state, change())
    expect(foldFailure(state, change())).toMatch(/observe reuses the already-observed attachment/)
  })

  it('refuses an update with no observation to update', () => {
    const state = emptyMedicalImageFoldState()
    expect(foldFailure(state, change({ revision: 2 }, 'update'))).toMatch(/update requires an existing observation/)
  })

  it('refuses an update that does not advance the revision by exactly one', () => {
    const state = emptyMedicalImageFoldState()
    applyMedicalImageChange(state, change())
    expect(foldFailure(state, change({ revision: 3, findings: ['scaling'] }, 'update')))
      .toMatch(/must advance the observation by one revision/)
  })

  it('refuses an update that moves the creation time or the mutation time backwards', () => {
    const state = emptyMedicalImageFoldState()
    applyMedicalImageChange(state, change())
    expect(foldFailure(state, change({ revision: 2, createdAt: 2_000, updatedAt: 2_000, findings: ['scaling'] }, 'update')))
      .toMatch(/cannot change the creation time/)
    expect(foldFailure(state, change({ revision: 2, updatedAt: 999, findings: ['scaling'] }, 'update')))
      .toMatch(/cannot move the mutation time backwards/)
  })

  it('refuses an update that changes no recorded field', () => {
    const state = emptyMedicalImageFoldState()
    applyMedicalImageChange(state, change())
    expect(foldFailure(state, change({ revision: 2, updatedAt: 2_000 }, 'update')))
      .toMatch(/must change at least one recorded field/)
  })

  it('advances one attachment while leaving another untouched', () => {
    const other = AttachmentId('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const state = emptyMedicalImageFoldState()
    applyMedicalImageChange(state, change())
    applyMedicalImageChange(state, change({
      attachment: { attachmentId: other, mediaType: 'image/jpeg', bytes: 10, width: 4, height: 4 },
      bodyRegion: 'right knee',
    }))
    applyMedicalImageChange(state, change({ revision: 2, updatedAt: 2_000, findings: ['irregular red patch', 'scaling'] }, 'update'))
    const stored = [...state.observations.values()]
    expect(stored.map(entry => String(entry.attachment.attachmentId))).toEqual([String(ATTACHMENT), String(other)])
    expect(stored[0]?.revision).toBe(2)
    expect(stored[1]?.revision).toBe(1)
  })
})

describe('applyMedicalImageEvent', () => {
  it('ignores an event belonging to another domain', () => {
    const state = emptyMedicalImageFoldState()
    const unrelated: SessionEvent = { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } }
    applyMedicalImageEvent(state, unrelated)
    expect([...state.observations.values()]).toEqual([])
  })

  it('applies this domain\u2019s committed event', () => {
    const state = emptyMedicalImageFoldState()
    const event: SessionEvent = { type: 'medical/image-observation', seq: SessionSeq(1), time: 1, data: change() }
    applyMedicalImageEvent(state, event)
    expect([...state.observations.values()]).toEqual([record()])
  })
})

describe('foldMedicalImage', () => {
  it('reports nothing for a log that never observed an image', () => {
    expect(foldMedicalImage([])).toEqual({ observations: [] })
  })

  it('replays a cold log into the same state, in first-observation order', () => {
    const other = AttachmentId('sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')
    const events: readonly SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'medical/image-observation', seq: SessionSeq(1), time: 1, data: change() },
      {
        type: 'medical/image-observation',
        seq: SessionSeq(2),
        time: 2,
        data: change({ attachment: { attachmentId: other, mediaType: 'image/webp', bytes: 5, width: 3, height: 3 } }),
      },
      { type: 'medical/image-observation', seq: SessionSeq(3), time: 3, data: change({ revision: 2, updatedAt: 2_000, findings: ['irregular red patch', 'scaling'] }, 'update') },
    ]
    const folded = foldMedicalImage(events)
    expect(folded.observations.map(entry => String(entry.attachment.attachmentId)))
      .toEqual([String(ATTACHMENT), String(other)])
    expect(folded.observations[0]?.revision).toBe(2)
    expect(folded.observations[0]?.findings).toEqual(['irregular red patch', 'scaling'])
  })

  it('fails loudly on a malformed record in the middle of a log', () => {
    const events: readonly SessionEvent[] = [
      { type: 'medical/image-observation', seq: SessionSeq(1), time: 1, data: change() },
      { type: 'medical/image-observation', seq: SessionSeq(2), time: 2, data: { kind: 'medical/image-observation', version: 1, operation: 'observe' } as never },
    ]
    expect(() => foldMedicalImage(events)).toThrow(/observation must be an object/)
  })
})

describe('imageReplayError', () => {
  it('attributes a decoding failure to the domain without losing the reason', () => {
    const error = imageReplayError(new Error('attachment must be an object'))
    expect(error.code).toBe('IMAGE_STREAM_INVALID')
    expect(error.message).toBe('durable medical image stream is invalid: attachment must be an object')
  })

  it('describes a non-Error rejection too', () => {
    expect(imageReplayError('nope').message).toBe('durable medical image stream is invalid: nope')
  })
})
