/**
 * Host-side vocabulary of the medical case domain: the durable change payload
 * carried by the domain's own session event, the strict fold shapes, and the
 * stable rejection codes. Kept separate from ./types.ts because these
 * declarations pull `dsh-session` into the program.
 *
 * @module @deepseek-ai/dsh-medical-case
 */

import type { CaseId, CaseOperation, CaseRef, CaseState } from './types.ts'

/**
 * Full-state case mutation committed by a durable `medical/case-change` event.
 * The event carries the complete post-mutation state so last-wins projection
 * and strict replay never need an earlier record.
 */
export interface MedicalCaseSnapshotChange {
  /** Discriminant letting a reader recognize this event's payload shape. */
  readonly kind: 'medical/case-change'
  /** Payload version; raised only by an incompatible shape change. */
  readonly version: 1
  /** Whether this event created the case or advanced an existing one. */
  readonly operation: CaseOperation
  /** Complete durable state after the mutation. */
  readonly case: CaseState
}

/** Durable change payload carried by the case domain's session event. */
export type MedicalCaseChangeMeta = MedicalCaseSnapshotChange

/** Immutable result of folding every durable case fact in one Session. */
export interface FoldedMedicalCase {
  /** Current case, absent before the first create. */
  readonly current?: CaseState
  /** Every case identity created in this Session, in creation order. */
  readonly seenCaseIds: readonly CaseId[]
  /** Latest mutation ref, absent before the first create. */
  readonly lastRef?: CaseRef
}

/** Stable error codes for rejected case reads and mutations. */
export type CaseErrorCode =
  | 'CASE_AGENT_NOT_LIVE'
  | 'CASE_NOT_FOUND'
  | 'CASE_ALREADY_EXISTS'
  | 'CASE_STREAM_INVALID'
  | 'CASE_INVALID_PATCH'
  | 'CASE_INVALID_SYMPTOMS'
  | 'CASE_INVALID_DURATION'
  | 'CASE_INVALID_AGE'
  | 'CASE_INVALID_NOTES'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation intake case state. Every mutation writes the whole
     * {@link CaseState}, so the session log remains the only durable source of
     * truth: persistence, resume, and fork inherit the record with no second
     * store. `missingFields` is deliberately absent — it is derived on read.
     */
    'medical/case-change': MedicalCaseChangeMeta
  }
}
