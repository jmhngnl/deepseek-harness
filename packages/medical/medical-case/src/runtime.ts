/** Runtime constructors and protocol constants for the medical case domain. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CaseErrorCode } from './domain.ts'
import type { CaseId as CaseIdType } from './types.ts'

/** Payload version embedded in every `medical/case-change` event. */
export const MEDICAL_CASE_CHANGE_VERSION = 1

/**
 * Upper bound accepted for `age`, in years. A real human age above this is
 * treated as a data-entry error rather than a valid case, so the domain
 * rejects it instead of recording implausible input.
 */
export const MAX_AGE_YEARS = 130

/**
 * Brand a string as a case id.
 * @param id - raw case identifier admitted by the service that generated it.
 * @returns the same string with the compile-time brand.
 */
export function CaseId(id: string): CaseIdType {
  return brandString<CaseIdType>(id)
}

/** Error returned by the medical case domain boundary. */
export class MedicalCaseError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: CaseErrorCode) {
    super(message, code)
  }
}
