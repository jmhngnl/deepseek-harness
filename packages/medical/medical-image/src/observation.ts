/**
 * Pure normalization for one image observation.
 *
 * The service owns identity, revision, and timestamps; this module owns the
 * conversion from what a caller supplied into the exact shape the durable event
 * and the strict decoder require. Keeping it pure is what lets the rules be
 * tested without a session, and keeps one definition of "the same observation"
 * for the no-op comparison.
 *
 * @module @deepseek-ai/dsh-medical-image
 */

import { IMAGE_QUALITY_ISSUES, MedicalImageError } from './runtime.ts'
import type { ImageObservationRequest, ImageQuality, MedicalImageObservation } from './types.ts'

/**
 * Normalize one free-text list: trim each entry, drop entries that are blank once
 * trimmed, and deduplicate by the trimmed text. First-seen order is preserved, so
 * a restatement never reorders what the observer already said.
 * @param values - raw strings as supplied by the model.
 * @returns normalized text with no blanks and no exact duplicates.
 */
export function normalizeObservationText(values: readonly string[]): string[] {
  const normalized: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '' || normalized.includes(trimmed)) continue
    normalized.push(trimmed)
  }
  return normalized
}

/**
 * Normalize the required, nullable body region.
 *
 * Three states are distinct and stay distinct: a stated region, an explicit null,
 * and a mistake. A blank string is the mistake. Folding it into null would let a
 * caller that meant to name a region lose it to a stray whitespace, and the
 * strict decoder refuses an empty string precisely so that "nothing was stated"
 * can only ever be recorded as an explicit null.
 * @param value - the field exactly as the caller supplied it.
 * @returns the trimmed region, or null when the caller stated null.
 * @throws {@link MedicalImageError} when the value is a blank string.
 */
export function requireObservationBodyRegion(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new MedicalImageError(
      'image observation bodyRegion must be a non-empty string or an explicit null',
      'IMAGE_INVALID_BODY_REGION',
    )
  }
  return trimmed
}

/**
 * Normalize the quality block into the canonical issue order.
 *
 * An unrecognized issue is rejected rather than dropped: a limitation the domain
 * cannot name is a limitation the domain cannot persist, and silently discarding
 * it would report a cleaner image than the observer described. The tool schema
 * already restricts the field to the same union, so reaching this rejection means
 * a caller bypassed the schema.
 * @param usable - whether any part of the image could be described.
 * @param issues - raw issue names as supplied by the model.
 * @returns the quality block, ordered by {@link IMAGE_QUALITY_ISSUES} and deduplicated.
 * @throws {@link MedicalImageError} when an issue is not in the union.
 */
export function normalizeImageQuality(usable: boolean, issues: readonly string[]): ImageQuality {
  const named = new Set<string>()
  for (const issue of issues) {
    if (!(IMAGE_QUALITY_ISSUES as readonly string[]).includes(issue)) {
      throw new MedicalImageError(
        `image quality issue ${JSON.stringify(issue)} is not one of ${IMAGE_QUALITY_ISSUES.join(', ')}`,
        'IMAGE_INVALID_QUALITY',
      )
    }
    named.add(issue)
  }
  return { usable, issues: IMAGE_QUALITY_ISSUES.filter(issue => named.has(issue)) }
}

/** The observation fields a caller supplies, normalized and ready to persist. */
export interface ResolvedObservationFields {
  /** Trimmed body region, or null when not stated. */
  readonly bodyRegion: string | null
  /** Normalized findings. */
  readonly findings: string[]
  /** Normalized quality block. */
  readonly quality: ImageQuality
  /** Normalized uncertainty list. */
  readonly uncertainty: string[]
}

/**
 * Resolve one observation request into the fields the durable value carries.
 *
 * Every field is present on the request, so nothing here has to guess what an
 * omission meant: an empty list stays an empty list and never stands in for a
 * field the caller forgot.
 * @param request - the model-supplied full snapshot.
 * @returns the four normalized fields.
 * @throws {@link MedicalImageError} when a field cannot be represented durably.
 */
export function resolveObservationFields(request: ImageObservationRequest): ResolvedObservationFields {
  return {
    bodyRegion: requireObservationBodyRegion(request.bodyRegion),
    findings: normalizeObservationText(request.findings),
    quality: normalizeImageQuality(request.usable, request.qualityIssues),
    uncertainty: normalizeObservationText(request.uncertainty),
  }
}

/**
 * Whether a stored observation already records exactly these fields.
 *
 * Identity, revision, and timestamps are excluded on purpose: this answers "did
 * the observer say anything new", which is what decides whether an event is
 * appended. A restatement that changes no recorded field is a no-op, so the
 * revision stays a count of durable changes rather than of tool calls.
 * @param current - the stored observation for this attachment.
 * @param next - the freshly resolved fields.
 * @returns whether every recorded field already matches.
 */
export function recordsSameObservation(
  current: MedicalImageObservation,
  next: ResolvedObservationFields,
): boolean {
  const { quality } = current
  return current.bodyRegion === next.bodyRegion
    && current.findings.length === next.findings.length
    && current.findings.every((finding, index) => finding === next.findings[index])
    && current.uncertainty.length === next.uncertainty.length
    && current.uncertainty.every((entry, index) => entry === next.uncertainty[index])
    && quality.usable === next.quality.usable
    && quality.issues.length === next.quality.issues.length
    && quality.issues.every((issue, index) => issue === next.quality.issues[index])
}
