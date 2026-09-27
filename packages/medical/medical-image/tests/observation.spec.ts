/**
 * Unit coverage for the pure normalization rules: what one observation request
 * becomes before it is persisted, and when two requests record the same thing.
 */

import { describe, expect, it } from 'vitest'
import {
  MedicalImageError,
  normalizeImageQuality,
  normalizeObservationText,
  optionalObservationText,
  recordsSameObservation,
  resolveObservationFields,
} from '../src/index.ts'
import type { ImageObservationRequest, MedicalImageObservation } from '../src/index.ts'

describe('observation text normalization', () => {
  it('trims entries, drops blanks, and keeps first-seen order without duplicates', () => {
    expect(normalizeObservationText(['  red patch ', '', '   ', 'raised border', 'red patch']))
      .toEqual(['red patch', 'raised border'])
  })

  it('treats an omitted field and a blank field as the same statement', () => {
    expect(optionalObservationText(undefined)).toBeNull()
    expect(optionalObservationText('   ')).toBeNull()
    expect(optionalObservationText(' left forearm ')).toBe('left forearm')
  })
})

describe('quality normalization', () => {
  it('orders issues canonically and removes duplicates', () => {
    expect(normalizeImageQuality(true, ['too_distant', 'blur', 'blur']))
      .toEqual({ usable: true, issues: ['blur', 'too_distant'] })
  })

  it('accepts an unusable image with no issues recorded yet', () => {
    expect(normalizeImageQuality(false, [])).toEqual({ usable: false, issues: [] })
  })

  it('rejects a limitation the domain cannot name rather than dropping it', () => {
    expect(() => normalizeImageQuality(true, ['diagnosis_visible']))
      .toThrow(MedicalImageError)
    expect(() => normalizeImageQuality(true, ['diagnosis_visible']))
      .toThrow(/not one of blur, poor_lighting, occlusion, too_distant, unable_to_assess/)
  })
})

describe('resolving one request', () => {
  it('materializes omitted fields as null and empty lists', () => {
    expect(resolveObservationFields({ attachmentId: 'a', usable: true })).toEqual({
      bodyRegion: null,
      findings: [],
      quality: { usable: true, issues: [] },
      uncertainty: [],
    })
  })

  it('normalizes every supplied field at once', () => {
    expect(resolveObservationFields({
      attachmentId: 'a',
      bodyRegion: '  left forearm ',
      findings: [' irregular red patch ', 'irregular red patch'],
      usable: false,
      qualityIssues: ['poor_lighting', 'blur'],
      uncertainty: [' depth unclear '],
    })).toEqual({
      bodyRegion: 'left forearm',
      findings: ['irregular red patch'],
      quality: { usable: false, issues: ['blur', 'poor_lighting'] },
      uncertainty: ['depth unclear'],
    })
  })
})

describe('no-op comparison', () => {
  const stored: MedicalImageObservation = {
    attachment: {
      attachmentId: 'sha256:x' as never,
      mediaType: 'image/png',
      bytes: 10,
      width: 2,
      height: 2,
    },
    revision: 3,
    bodyRegion: 'left forearm',
    findings: ['red patch'],
    quality: { usable: true, issues: ['blur'] },
    uncertainty: ['depth unclear'],
    createdAt: 1,
    updatedAt: 2,
  }

  it('matches when every recorded field is unchanged', () => {
    expect(recordsSameObservation(stored, resolveObservationFields({
      attachmentId: 'a',
      bodyRegion: 'left forearm',
      findings: ['red patch'],
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth unclear'],
    }))).toBe(true)
  })

  it('ignores identity, revision, and timestamps, which the service owns', () => {
    expect(recordsSameObservation(stored, resolveObservationFields({
      attachmentId: 'a completely different id',
      bodyRegion: 'left forearm',
      findings: ['red patch'],
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth unclear'],
    }))).toBe(true)
  })

  it('reports a change when a finding is added, removed, or reordered', () => {
    const base: ImageObservationRequest = {
      attachmentId: 'a',
      bodyRegion: 'left forearm',
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth unclear'],
    }
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, findings: ['red patch', 'scaling'] })))
      .toBe(false)
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, findings: [] }))).toBe(false)
  })

  it('reports a change when usability or a quality issue differs', () => {
    const base: ImageObservationRequest = {
      attachmentId: 'a',
      bodyRegion: 'left forearm',
      findings: ['red patch'],
      usable: true,
      uncertainty: ['depth unclear'],
    }
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, usable: false, qualityIssues: ['blur'] })))
      .toBe(false)
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, usable: true }))).toBe(false)
  })

  it('reports a change when the body region or uncertainty differs', () => {
    const base: ImageObservationRequest = {
      attachmentId: 'a',
      findings: ['red patch'],
      usable: true,
      qualityIssues: ['blur'],
    }
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, uncertainty: ['depth unclear'] })))
      .toBe(false)
    expect(recordsSameObservation(stored, resolveObservationFields({
      ...base,
      bodyRegion: 'right forearm',
      uncertainty: ['depth unclear'],
    }))).toBe(false)
  })
})
