/**
 * Host-side vocabulary of the medical image domain: the durable change payload
 * carried by the domain's own session event, the strict fold shapes, and the
 * stable rejection codes. Kept separate from ./types.ts because these
 * declarations pull `dsh-session` into the program.
 *
 * @module @deepseek-ai/dsh-medical-image
 */

import type { ImageObservationOperation, MedicalImageObservation } from './types.ts'

/**
 * Full-state observation mutation committed by a durable
 * `medical/image-observation` event.
 *
 * The event carries the complete post-mutation observation, including the
 * canonical attachment reference and the revision, so last-wins projection and
 * strict replay never need an earlier record or the session's messages. That is
 * what makes a cold replay independent of the transcript: the durable stream
 * alone answers what was observed, at which revision, for which image.
 */
export interface MedicalImageObservationChange {
  /** Discriminant letting a reader recognize this event's payload shape. */
  readonly kind: 'medical/image-observation'
  /** Payload version; raised only by an incompatible shape change. */
  readonly version: 1
  /** Whether this event first observed the attachment or advanced an existing observation. */
  readonly operation: ImageObservationOperation
  /** Complete durable observation after the mutation. */
  readonly observation: MedicalImageObservation
}

/** Durable change payload carried by the image domain's session event. */
export type MedicalImageChangeMeta = MedicalImageObservationChange

/** Immutable result of folding every durable observation fact in one Session. */
export interface FoldedMedicalImage {
  /** Every observation, ordered by first observation. */
  readonly observations: readonly MedicalImageObservation[]
}

/**
 * Stable error codes for rejected image observations and reads.
 *
 * `IMAGE_ATTACHMENT_NOT_IN_SESSION` is the authorization boundary: it is the one
 * answer for an id this session never carried, an id belonging to another
 * session, and an id that only exists in the model's own output. Distinguishing
 * those would tell a caller which ids exist elsewhere.
 *
 * Every code here has a producer. A full-snapshot request carries every field, so
 * there is no "which fields did the caller mean to keep" failure to report — the
 * only field-level rejection left is a body region that is neither a real region
 * nor an explicit null.
 */
export type ImageErrorCode =
  | 'IMAGE_AGENT_NOT_LIVE'
  | 'IMAGE_ATTACHMENT_NOT_IN_SESSION'
  | 'IMAGE_OBSERVATION_NOT_FOUND'
  | 'IMAGE_STREAM_INVALID'
  | 'IMAGE_INVALID_BODY_REGION'
  | 'IMAGE_INVALID_QUALITY'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation observation of one session image. Every mutation
     * writes the whole {@link MedicalImageObservation}, so the session log stays
     * the only durable source of truth: persistence, resume, and fork inherit
     * the observation with no second store.
     *
     * This event records what the MODEL saw. It is deliberately not a
     * `medical/case-change`: patient-reported facts and model-observed evidence
     * are separate domains, and nothing in this event can alter a case.
     */
    'medical/image-observation': MedicalImageChangeMeta
  }
}
