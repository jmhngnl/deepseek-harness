/** Runtime constructors and protocol constants for the medical image domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ImageErrorCode } from './domain.ts'
import type { ImageQualityIssue } from './types.ts'

/** Payload version embedded in every `medical/image-observation` event. */
export const MEDICAL_IMAGE_OBSERVATION_VERSION = 1

/**
 * Every quality limitation this version can record, in the order the domain
 * normalizes them. The order is part of the contract: two observations that name
 * the same limitations are the same observation regardless of the order the
 * caller listed them in.
 */
export const IMAGE_QUALITY_ISSUES = [
  'blur',
  'poor_lighting',
  'occlusion',
  'too_distant',
  'unable_to_assess',
] as const satisfies readonly ImageQualityIssue[]

/** Error returned by the medical image domain boundary. */
export class MedicalImageError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: ImageErrorCode) {
    super(message, code)
  }
}
