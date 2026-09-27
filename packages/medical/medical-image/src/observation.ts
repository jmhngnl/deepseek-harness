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
 * Normalize one optional free-text field. A blank value is the same statement as
 * an omitted one — "the observer did not say" — so both become null rather than
 * an empty string the strict decoder would reject.
 * @param value - raw field as supplied by the model.
 * @returns the trimmed text, or null when absent or blank.
 */
export function optionalObservationText(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
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
 * @param request - the model-supplied observation.
 * @returns the four normalized fields.
 * @throws {@link MedicalImageError} when a field cannot be represented durably.
 */
export function resolveObservationFields(request: ImageObservationRequest): ResolvedObservationFields {
  return {
    bodyRegion: optionalObservationText(request.bodyRegion),
    findings: normalizeObservationText(request.findings ?? []),
    quality: normalizeImageQuality(request.usable, request.qualityIssues ?? []),
    uncertainty: normalizeObservationText(request.uncertainty ?? []),
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
