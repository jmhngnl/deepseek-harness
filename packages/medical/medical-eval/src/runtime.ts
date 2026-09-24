/** Runtime constants, the error class, and the JSON narrowing shared by the reader and the observer. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Contract version of the golden-case document. A case declares the version it
 * was written against, and the loader refuses a document that declares another,
 * so extending the contract is a visible act rather than a silent widening.
 */
export const GOLDEN_CASE_SCHEMA_VERSION = 1

/**
 * Contract version of the evaluation report, covering the failure taxonomy the
 * report carries. Raised together with {@link GOLDEN_CASE_SCHEMA_VERSION} when
 * a classification is added or redefined.
 */
export const EVAL_REPORT_SCHEMA_VERSION = 1

/**
 * Rejection raised while reading a golden case. The message names the exact
 * document path that failed, so a malformed case is fixed by reading the error
 * rather than by bisecting the file.
 */
export class GoldenCaseError extends Error {
  /**
   * @param message - the failing document path and what was expected there.
   */
  constructor(message: string) {
    super(message)
    this.name = 'GoldenCaseError'
  }
}

/**
 * Narrow the shared JSON check to a predicate, so callers can build a typed
 * object from its answer instead of asserting the type at each use.
 *
 * Both users of this harness read values that must have survived a JSON round
 * trip: a golden case is a document, and a tool call's arguments are raw model
 * text. A value that cannot round-trip — a non-finite number, a class
 * instance, `undefined` — could never match an expectation, so it is reported
 * rather than carried into a comparison.
 * @param value - candidate value.
 * @returns whether the value is losslessly JSON-serializable.
 */
export function isJson(value: unknown): value is JsonValue {
  return isJsonValue(value)
}
