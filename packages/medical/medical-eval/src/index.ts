/**
 * Golden-case evaluation harness for the medical intake agent.
 *
 * This package is test infrastructure, not a capability. It registers no tool,
 * publishes no service, and mounts nothing into an agent's runtime: the
 * medical agent's model-facing surface stays exactly the three
 * `medical_case_*` tools. What it adds is a way to state what a medical
 * conversation must do — as versioned data rather than as assertions buried in
 * a test — and to replay that statement through the real agent loop against
 * either a scripted or a live model.
 *
 * The pipeline is deliberately linear, and every arrow crosses a documented
 * seam:
 *
 * ```
 * GoldenCase (data)
 *   → runGoldenCases (real runtime, one isolated harness per case)
 *   → observeTurn (session events + the authoritative case, as plain data)
 *   → evaluateTurn / evaluateCase (pure comparison)
 *   → buildReport (counts, ratios, and the evidence each failure carries)
 * ```
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

export type * from './types.ts'
export {
  EVAL_REPORT_SCHEMA_VERSION,
  GOLDEN_CASE_SCHEMA_VERSION,
  GoldenCaseError,
  isJson,
} from './runtime.ts'
export { loadGoldenCases, parseGoldenCase } from './golden.ts'
export { observeTurn } from './observe.ts'
export type { TurnObservationInput } from './observe.ts'
export { evaluateCase, evaluateTurn } from './evaluate.ts'
export type { CaseEvaluationInput } from './evaluate.ts'
export { buildReport, createRunId, evalRunsDirectory, writeEvalReport } from './report.ts'
export type { ReportInput } from './report.ts'
export { runGoldenCases } from './runner.ts'
export type { GoldenCaseHarness, GoldenRunOptions } from './runner.ts'
