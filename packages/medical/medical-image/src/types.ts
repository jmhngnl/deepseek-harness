/**
 * Pure types of the medical image domain: the ONE home of the `medicalImage`
 * projection-key declaration plus the durable value vocabulary it carries.
 * Deliberately free of host-side imports (cordis, dsh-session, dsh-agent) so a
 * future client aggregate can consume the same table without the host-coupled
 * event declarations in ./domain.ts.
 *
 * This vocabulary is the SECOND medical domain, and it is deliberately not the
 * first one. `medical-case` records what the patient reported; this records what
 * the model saw in an image. The two never write to each other: a visible finding
 * is evidence, not a patient-reported symptom, and nothing here can reach
 * `CaseState`.
 *
 * @module @deepseek-ai/dsh-medical-image/types
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * A limitation of one image that the observer can state without diagnosing.
 *
 * A closed union rather than free text: the set is small, every member is a
 * property of the IMAGE rather than of a patient, and a versioned enum is what
 * lets a case be compared across runs. Free-text quality notes would make the
 * same limitation two different strings in two runs.
 */
export type ImageQualityIssue =
  /** Detail is not resolvable in the submitted image. */
  | 'blur'
  /** Exposure, glare, or shadow hides part of the subject. */
  | 'poor_lighting'
  /** Something covers part of the region of interest. */
  | 'occlusion'
  /** The subject occupies too little of the frame to describe. */
  | 'too_distant'
  /** Nothing visible in the image can be described at all. */
  | 'unable_to_assess'

/**
 * Whether the image could be described, and the limitations that bound the
 * description. `usable: false` is a successful, useful outcome — it is how the
 * observer says "ask for a clearer image" instead of inventing detail.
 */
export interface ImageQuality {
  /** Whether any part of the image could be described. */
  readonly usable: boolean
  /** Every limitation observed, in a stable order, without duplicates. */
  readonly issues: ImageQualityIssue[]
}

/** Durable state-changing verbs recorded in the image-observation log. */
export type ImageObservationOperation = 'observe' | 'update'

/**
 * One structured observation of one image the session already holds.
 *
 * The identity is the attachment: `attachment.attachmentId` is content-addressed,
 * so one image can never be observed under two identities and a second id field
 * would only be a second key to keep consistent. Several images in one session
 * are several of these, each addressed by its own attachment.
 *
 * Every field is a DIRECTLY VISIBLE property of the image or an explicit limit of
 * the observation. There is no confidence, no severity, no diagnosis, no
 * treatment, and no risk: those are clinical conclusions, and this domain records
 * evidence.
 *
 * `attachment` is always the canonical reference taken from the session's own
 * user message, never a value the caller supplied — see
 * `MedicalImageService.observe`.
 */
export interface MedicalImageObservation {
  /** Canonical durable reference, copied from the session message that carried the image. */
  readonly attachment: ImageAttachmentRef
  /** Positive revision; 1 on the first observation of this attachment. */
  readonly revision: number
  /**
   * The body region the image depicts, as the observer phrased it, or null when
   * the observer did not state one. Free text on purpose: a fixed anatomical
   * vocabulary would be a clinical ontology, which this phase does not build.
   */
  readonly bodyRegion: string | null
  /** Directly visible findings, in first-seen order, without duplicates. */
  readonly findings: string[]
  /** Whether the image could be described, and what limited it. */
  readonly quality: ImageQuality
  /** What the observer could not determine from this image, without duplicates. */
  readonly uncertainty: string[]
  /** Epoch milliseconds of the first observation of this attachment. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest observation; never decreases. */
  readonly updatedAt: number
}

/** What one observation attempt asks for, before the canonical reference is resolved. */
export interface ImageObservationRequest {
  /** Attachment the model saw; resolved against the current session, never trusted as metadata. */
  readonly attachmentId: string
  /** Body region as the observer phrased it; omit when not stated. */
  readonly bodyRegion?: string
  /** Directly visible findings; omit or pass an empty list when none are describable. */
  readonly findings?: string[]
  /** Whether any part of the image could be described. */
  readonly usable: boolean
  /** Limitations observed; omit when the image has none. */
  readonly qualityIssues?: ImageQualityIssue[]
  /** What could not be determined from this image. */
  readonly uncertainty?: string[]
}

/** Outcome of one accepted observation attempt. */
export interface ImageObservationResult {
  /** The authoritative observation after the attempt. */
  readonly view: MedicalImageObservation
  /** Whether the attempt produced a durable new revision. */
  readonly changed: boolean
}

/** Strict checkpoint state used to derive the session's image observations. */
export interface MedicalImageProjectionState {
  /** Every observation in this Session, ordered by first observation. */
  readonly observations: MedicalImageObservation[]
  /** First strict replay failure, or null while the durable stream is valid. */
  readonly failure: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /**
     * Every image the model has observed in this Session, addressed by
     * attachment. Host-only: the value carries clinical free text and image
     * references, so it is never exposed on a client wire surface.
     */
    medicalImage: MedicalImageProjectionState
  }
}
