/**
 * Pure replay fold and strict decoder for durable image observations.
 *
 * Mirrors the case domain's fold: the first malformed record throws, and the
 * projection unit that drives this fold latches that failure instead of skipping
 * it. A store that cannot read its own stream must not look like a store that
 * recorded nothing.
 *
 * @module @deepseek-ai/dsh-medical-image
 */

import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FoldedMedicalImage, MedicalImageChangeMeta } from './domain.ts'
import { IMAGE_QUALITY_ISSUES, MEDICAL_IMAGE_OBSERVATION_VERSION, MedicalImageError } from './runtime.ts'
import type { ImageQualityIssue, MedicalImageObservation } from './types.ts'

/** The raster formats the attachment service admits; repeated here so the decoder validates without an attachment provider. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Mutable accumulator kept private to the pure fold. */
export interface MedicalImageFoldState {
  /** Every observation so far, keyed by attachment id in first-observation order. */
  observations: Map<string, MedicalImageObservation>
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no observations.
 */
export function emptyMedicalImageFoldState(): MedicalImageFoldState {
  return { observations: new Map() }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`medical image observation ${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`medical image observation ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Require a non-empty, already-normalized string. */
function normalizedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`medical image observation ${field} must be a non-empty normalized string`)
  }
  return value
}

/** Require null or a non-empty, already-normalized string. */
function optionalNormalizedText(value: unknown, field: string): string | null {
  return value === null ? null : normalizedText(value, field)
}

/** Require the normalized text list: no blanks, no exact duplicates. */
function decodeTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`medical image observation ${field} must be an array`)
  const entries = value.map(entry => normalizedText(entry, `${field}[]`))
  if (new Set(entries).size !== entries.length) {
    throw new Error(`medical image observation ${field} must not repeat an entry`)
  }
  return entries
}

/** Require the canonical quality block: a known issue set, in canonical order, without duplicates. */
function decodeQuality(value: unknown): MedicalImageObservation['quality'] {
  if (!isRecord(value)) throw new Error('medical image observation quality must be an object')
  const usable = value['usable']
  if (typeof usable !== 'boolean') throw new Error('medical image observation quality.usable must be a boolean')
  const raw = value['issues']
  if (!Array.isArray(raw)) throw new Error('medical image observation quality.issues must be an array')
  const issues = raw.map((issue) => {
    if (typeof issue !== 'string' || !(IMAGE_QUALITY_ISSUES as readonly string[]).includes(issue)) {
      throw new Error(`medical image observation quality issue ${JSON.stringify(issue)} is not supported`)
    }
    return issue as ImageQualityIssue
  })
  const expected = IMAGE_QUALITY_ISSUES.filter(issue => issues.includes(issue))
  if (issues.length !== expected.length || issues.some((issue, index) => issue !== expected[index])) {
    throw new Error('medical image observation quality issues must be unique and in canonical order')
  }
  return { usable, issues: expected }
}

/** Strictly decode the canonical attachment reference carried by one observation. */
function decodeAttachment(value: unknown): ImageAttachmentRef {
  if (!isRecord(value)) throw new Error('medical image observation attachment must be an object')
  const mediaType = value['mediaType']
  if (typeof mediaType !== 'string' || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new Error(`medical image observation attachment media type ${JSON.stringify(mediaType)} is not supported`)
  }
  const name = value['name']
  const originalDimensions = value['originalDimensions']
  return {
    // The brand is applied only after the value has been proven to be a
    // non-empty normalized string, so an invalid id cannot enter the fold.
    attachmentId: AttachmentId(normalizedText(value['attachmentId'], 'attachment.attachmentId')),
    mediaType: mediaType as ImageMediaType,
    bytes: positiveInteger(value['bytes'], 'attachment.bytes'),
    width: positiveInteger(value['width'], 'attachment.width'),
    height: positiveInteger(value['height'], 'attachment.height'),
    ...name === undefined ? {} : { name: normalizedText(name, 'attachment.name') },
    ...originalDimensions === undefined ? {} : {
      originalDimensions: decodeOriginalDimensions(originalDimensions),
    },
  }
}

/** Strictly decode the optional pre-normalization dimensions. */
function decodeOriginalDimensions(value: unknown): { width: number; height: number } {
  if (!isRecord(value)) throw new Error('medical image observation attachment.originalDimensions must be an object')
  return {
    width: positiveInteger(value['width'], 'attachment.originalDimensions.width'),
    height: positiveInteger(value['height'], 'attachment.originalDimensions.height'),
  }
}

/** Strictly decode one durable observation. */
function decodeObservation(value: unknown): MedicalImageObservation {
  if (!isRecord(value)) throw new Error('medical image observation must be an object')
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt) throw new Error('medical image observation update cannot precede its creation')
  return {
    attachment: decodeAttachment(value['attachment']),
    revision: positiveInteger(value['revision'], 'revision'),
    bodyRegion: optionalNormalizedText(value['bodyRegion'], 'bodyRegion'),
    findings: decodeTextList(value['findings'], 'findings'),
    quality: decodeQuality(value['quality']),
    uncertainty: decodeTextList(value['uncertainty'], 'uncertainty'),
    createdAt,
    updatedAt,
  }
}

/**
 * Strictly decode one durable change payload.
 * @param value - untrusted payload read back from a session log.
 * @returns the decoded change, or undefined when the payload is not this domain's.
 */
export function decodeMedicalImageChange(value: unknown): MedicalImageChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'medical/image-observation') return undefined
  if (value['version'] !== MEDICAL_IMAGE_OBSERVATION_VERSION) {
    throw new Error(`medical image observation version ${String(value['version'])} is not supported`)
  }
  const operation = value['operation']
  if (operation !== 'observe' && operation !== 'update') {
    throw new Error(`medical image observation operation ${String(operation)} is not supported`)
  }
  return {
    kind: 'medical/image-observation',
    version: MEDICAL_IMAGE_OBSERVATION_VERSION,
    operation,
    observation: decodeObservation(value['observation']),
  }
}

/** Validate one first-observation change against the preceding projection. */
function applyObserve(state: MedicalImageFoldState, next: MedicalImageObservation): void {
  if (next.revision !== 1) throw new Error('medical image observe must start at revision one')
  const key = String(next.attachment.attachmentId)
  if (state.observations.has(key)) {
    throw new Error(`medical image observe reuses the already-observed attachment ${JSON.stringify(key)}`)
  }
}

/** Validate one update change against the preceding projection. */
function applyUpdate(state: MedicalImageFoldState, next: MedicalImageObservation): void {
  const key = String(next.attachment.attachmentId)
  const current = state.observations.get(key)
  if (current === undefined) {
    throw new Error(`medical image update requires an existing observation for ${JSON.stringify(key)}`)
  }
  if (next.revision !== current.revision + 1) {
    throw new Error('medical image update must advance the observation by one revision')
  }
  if (next.createdAt !== current.createdAt) throw new Error('medical image update cannot change the creation time')
  if (next.updatedAt < current.updatedAt) {
    throw new Error('medical image update cannot move the mutation time backwards')
  }
  if (sameObservationFields(current, next)) {
    throw new Error('medical image update must change at least one recorded field')
  }
}

/** Whether two observations record the same fields, ignoring revision and timestamps. */
function sameObservationFields(current: MedicalImageObservation, next: MedicalImageObservation): boolean {
  return current.bodyRegion === next.bodyRegion
    && current.findings.length === next.findings.length
    && current.findings.every((finding, index) => finding === next.findings[index])
    && current.uncertainty.length === next.uncertainty.length
    && current.uncertainty.every((entry, index) => entry === next.uncertainty[index])
    && current.quality.usable === next.quality.usable
    && current.quality.issues.length === next.quality.issues.length
    && current.quality.issues.every((issue, index) => issue === next.quality.issues[index])
}

/**
 * Apply one decoded change to the accumulator, validating it strictly.
 * @param state - accumulator covering all prior events.
 * @param change - decoded durable change.
 */
export function applyMedicalImageChange(state: MedicalImageFoldState, change: MedicalImageChangeMeta): void {
  if (change.operation === 'observe') applyObserve(state, change.observation)
  else applyUpdate(state, change.observation)
  state.observations.set(String(change.observation.attachment.attachmentId), change.observation)
}

/**
 * Apply one committed session event to the accumulator. Events belonging to other
 * domains are ignored.
 * @param state - accumulator covering all prior events.
 * @param event - the next committed session event.
 */
export function applyMedicalImageEvent(state: MedicalImageFoldState, event: SessionEvent): void {
  if (event.type !== 'medical/image-observation') return
  const change = decodeMedicalImageChange(event.data)
  /* v8 ignore next -- the declaration merge types the payload as this domain's change */
  if (change === undefined) throw new Error('medical/image-observation carried a foreign payload')
  applyMedicalImageChange(state, change)
}

/**
 * Fold every durable observation in a session log.
 * @param events - the committed events, in sequence order.
 * @returns the immutable folded result, in first-observation order.
 * @throws when any observation record is malformed or inconsistent.
 */
export function foldMedicalImage(events: readonly SessionEvent[]): FoldedMedicalImage {
  const state = emptyMedicalImageFoldState()
  for (const event of events) applyMedicalImageEvent(state, event)
  return { observations: [...state.observations.values()] }
}

/**
 * Attribute a strict-decoding failure to this domain without losing the reason a
 * reader needs to diagnose the log.
 * @param error - the failure raised while decoding or validating a record.
 * @returns the domain error to surface.
 */
export function imageReplayError(error: unknown): MedicalImageError {
  const message = error instanceof Error ? error.message : String(error)
  return new MedicalImageError(`durable medical image stream is invalid: ${message}`, 'IMAGE_STREAM_INVALID')
}
