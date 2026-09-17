/**
 * Pure types of the medical case domain: the ONE home of the `medicalCase`
 * projection-key declaration plus the durable value vocabulary it carries.
 * Deliberately free of host-side imports (cordis, dsh-session, dsh-agent) so
 * a future client aggregate can consume the same table without the
 * host-coupled event declarations in ./domain.ts.
 *
 * @module @deepseek-ai/dsh-medical-case/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one intake case across its durable revisions. */
export type CaseId = Branded<'CaseId'>

/** Compare-and-set identity for one exact case revision. */
export interface CaseRef {
  /** Stable case identity. */
  readonly caseId: CaseId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/**
 * A fact the agent still has to obtain before the intake is complete.
 * `additionalNotes` is deliberately absent: it is optional context, so its
 * absence is never reported as missing information.
 */
export type MissingField = 'symptoms' | 'duration' | 'age'

/** Durable state-changing verbs recorded in the case log. */
export type CaseOperation = 'create' | 'update'

/**
 * The complete durable case state. Every `medical/case-change` event carries
 * this whole value — never a patch — so a reader that folds only the latest
 * event still holds the authoritative record.
 */
export interface CaseState extends CaseRef {
  /** Symptoms exactly as recorded, in first-seen order. */
  readonly symptoms: string[]
  /** Free-text duration, or null while unrecorded. */
  readonly duration: string | null
  /** Whole years of age, or null while unrecorded. */
  readonly age: number | null
  /** Optional context, or null while unrecorded. */
  readonly additionalNotes: string | null
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation; never decreases. */
  readonly updatedAt: number
}

/**
 * The read model: durable state plus values derived from it. `missingFields`
 * is computed from the current {@link CaseState} on every read and is never
 * persisted, so the record and its gap report cannot disagree.
 */
export interface CaseView extends CaseState {
  /** Required facts absent from this revision. */
  readonly missingFields: MissingField[]
}

/**
 * First-contact input. Every field may be omitted: recording that the user has
 * not said something yet is a successful, useful outcome.
 */
export interface CaseIntakeRequest {
  /** Symptoms the user named; omit when none were named. */
  readonly symptoms?: string[]
  /** How long the symptoms have lasted, as the user phrased it. */
  readonly duration?: string
  /** Patient age in whole years. */
  readonly age?: number
  /** Any other case context the user volunteered. */
  readonly additionalNotes?: string
}

/**
 * Incremental change against an existing case. An omitted field keeps its
 * current value; there is no parameter that silently clears one.
 */
export interface CasePatch {
  /** Replace the whole symptom list. Mutually exclusive with the two deltas. */
  readonly symptoms?: string[]
  /** Append these symptoms, preserving the ones already recorded. */
  readonly symptomsAdd?: string[]
  /** Drop these symptoms; a value that is not recorded is a no-op. */
  readonly symptomsRemove?: string[]
  /** Replacement duration text. */
  readonly duration?: string
  /** Replacement age in whole years. */
  readonly age?: number
  /** Replacement optional notes. */
  readonly additionalNotes?: string
}

/** Outcome of one accepted patch attempt. */
export interface CaseUpdateResult {
  /** The authoritative case after the attempt. */
  readonly view: CaseView
  /** Whether the attempt produced a durable new revision. */
  readonly changed: boolean
}

/** Strict checkpoint state used to derive the current case. */
export interface MedicalCaseProjectionState {
  /** Latest valid case, or null before the first create. */
  readonly current: CaseState | null
  /** Case identities already created in this Session, retained to reject reuse. */
  readonly seenCaseIds: CaseId[]
  /** First strict replay failure, or null while the durable stream is valid. */
  readonly failure: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /**
     * The session's current medical intake case, or `null` before the first
     * create. Host-only: the value carries clinical free text, so it is never
     * exposed on a client wire surface.
     */
    medicalCase: MedicalCaseProjectionState
  }
}
