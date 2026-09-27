/**
 * Unit coverage for the pure normalization rules: what one full-snapshot
 * observation request becomes before it is persisted, and when two requests
 * record the same thing.
 */

import { describe, expect, it } from 'vitest'
import {
  MedicalImageError,
  normalizeImageQuality,
  normalizeObservationText,
  recordsSameObservation,
  requireObservationBodyRegion,
  resolveObservationFields,
} from '../src/index.ts'
import type { ImageObservationRequest, MedicalImageObservation } from '../src/index.ts'

/** One complete request; every field is required, so tests state all of them. */
function request(overrides: Partial<ImageObservationRequest> = {}): ImageObservationRequest {
  return {
    attachmentId: 'sha256:a',
    bodyRegion: null,
    findings: [],
    usable: true,
    qualityIssues: [],
    uncertainty: [],
    ...overrides,
  }
}

describe('observation text normalization', () => {
  it('trims entries, drops blanks, and keeps first-seen order without duplicates', () => {
    expect(normalizeObservationText(['  red patch ', '', '   ', 'raised border', 'red patch']))
      .toEqual(['red patch', 'raised border'])
  })

  it('leaves an empty list empty rather than inventing an entry', () => {
    expect(normalizeObservationText([])).toEqual([])
  })
})

describe('body region normalization', () => {
  it('keeps an explicit null as null', () => {
    expect(requireObservationBodyRegion(null)).toBeNull()
  })

  it('trims a stated region', () => {
    expect(requireObservationBodyRegion(' left forearm ')).toBe('left forearm')
  })

  it('refuses a blank string instead of folding it into null', () => {
    // The contract distinguishes "no region can be stated" from "the caller wrote
    // nothing", so a blank string is a mistake rather than a silent null.
    expect(() => requireObservationBodyRegion('')).toThrow(MedicalImageError)
    expect(() => requireObservationBodyRegion('')).toThrow(/non-empty string or an explicit null/)
    expect(() => requireObservationBodyRegion('   ')).toThrow(/non-empty string or an explicit null/)
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

describe('resolving one full snapshot', () => {
  it('keeps every empty list empty and null null', () => {
    expect(resolveObservationFields(request())).toEqual({
      bodyRegion: null,
      findings: [],
      quality: { usable: true, issues: [] },
      uncertainty: [],
    })
  })

  it('normalizes every supplied field at once', () => {
    expect(resolveObservationFields(request({
      bodyRegion: '  left forearm ',
      findings: [' irregular red patch ', 'irregular red patch'],
      usable: false,
      qualityIssues: ['poor_lighting', 'blur'],
      uncertainty: [' depth unclear '],
    }))).toEqual({
      bodyRegion: 'left forearm',
      findings: ['irregular red patch'],
      quality: { usable: false, issues: ['blur', 'poor_lighting'] },
      uncertainty: ['depth unclear'],
    })
  })

  it('treats an empty findings list as a recorded emptiness, not a missing field', () => {
    // Full-snapshot semantics: there is no "keep the previous findings" path, so
    // an empty list is the caller saying "nothing is describable".
    const resolved = resolveObservationFields(request({ usable: false, findings: [] }))
    expect(resolved.findings).toEqual([])
    expect(resolved.quality.usable).toBe(false)
  })

  it('refuses a blank body region', () => {
    expect(() => resolveObservationFields(request({ bodyRegion: '  ' })))
      .toThrow(/bodyRegion must be a non-empty string or an explicit null/)
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
    expect(recordsSameObservation(stored, resolveObservationFields(request({
      bodyRegion: 'left forearm',
      findings: ['red patch'],
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth unclear'],
    })))).toBe(true)
  })

  it('ignores identity, revision, and timestamps, which the service owns', () => {
    expect(recordsSameObservation(stored, resolveObservationFields(request({
      attachmentId: 'a completely different id',
      bodyRegion: 'left forearm',
      findings: ['red patch'],
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth unclear'],
    })))).toBe(true)
  })

  it('reports a change when a finding is added, removed, or reordered', () => {
    const base = request({
      bodyRegion: 'left forearm',
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth unclear'],
    })
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, findings: ['red patch', 'scaling'] })))
      .toBe(false)
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, findings: [] }))).toBe(false)
  })

  it('reports a change when usability or a quality issue differs', () => {
    const base = request({
      bodyRegion: 'left forearm',
      findings: ['red patch'],
      uncertainty: ['depth unclear'],
    })
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, usable: false, qualityIssues: ['blur'] })))
      .toBe(false)
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, usable: true }))).toBe(false)
  })

  it('reports a change when the body region or uncertainty differs', () => {
    const base = request({
      findings: ['red patch'],
      usable: true,
      qualityIssues: ['blur'],
    })
    expect(recordsSameObservation(stored, resolveObservationFields({ ...base, uncertainty: ['depth unclear'] })))
      .toBe(false)
    expect(recordsSameObservation(stored, resolveObservationFields({
      ...base,
      bodyRegion: 'right forearm',
      uncertainty: ['depth unclear'],
    }))).toBe(false)
  })
})
