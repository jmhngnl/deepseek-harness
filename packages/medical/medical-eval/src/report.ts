/**
 * The evaluation report: pure aggregation over evaluated cases, plus the one
 * filesystem seam that persists a finished run.
 *
 * Deliberately no weighted score. A single number would have to be defined
 * before there is data to define it against, and the dimensions below are not
 * interchangeable: a run that routes every turn correctly but records nothing
 * is worse than one that mislabels a tool, and an average would hide that.
 * Token and latency figures ride along as observations, never as thresholds.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVAL_REPORT_SCHEMA_VERSION } from './runtime.ts'
import type {
  CaseReport,
  CaseReportTurn,
  EvalLatencyAggregate,
  EvalReport,
  EvalRuntime,
  EvalSummary,
  EvalUsageAggregate,
  GoldenCaseRun,
  TurnEvaluation,
} from './types.ts'

/** What a report is built from. */
export interface ReportInput {
  /** Identity of this run, unique within the directory it is written to. */
  readonly runId: string
  /** ISO 8601 start instant. */
  readonly startedAt: string
  /** ISO 8601 finish instant. */
  readonly finishedAt: string
  /** The route and runner the cases ran under. */
  readonly runtime: EvalRuntime
  /** Every evaluated case, in replay order. */
  readonly runs: readonly GoldenCaseRun[]
}

/**
 * Build one run's report.
 * @param input - the runs, their route, and the run's identity and bounds.
 * @returns the versioned report document.
 */
export function buildReport(input: ReportInput): EvalReport {
  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    runtime: input.runtime,
    summary: summarize(input.runs),
    cases: input.runs.map(caseReport),
  }
}

/**
 * Derive a run identity from the instant the run started.
 *
 * Deterministic in its argument rather than random, so a report's file name can
 * be predicted from its start time and two runs started in the same millisecond
 * are the same run as far as the directory is concerned. `toISOString` keeps
 * milliseconds, so that is the resolution the identity actually has.
 * @param instant - when the run started.
 * @returns a filesystem-safe identifier.
 */
export function createRunId(instant: Date): string {
  return instant.toISOString().replaceAll(':', '-').replace('.', '-')
}

/**
 * The directory local reports are written to.
 *
 * Gitignored by design: a report quotes clinical free text from the cases it
 * replayed, so it belongs beside the session logs rather than in history.
 * @param root - the checkout root.
 * @returns the absolute report directory.
 */
export function evalRunsDirectory(root: string): string {
  return join(root, '.medharness', 'eval-runs')
}

/**
 * Write one report as JSON.
 * @param report - the report to persist.
 * @param directory - the directory to write into, created when absent.
 * @returns the absolute path of the written file.
 */
export function writeEvalReport(report: EvalReport, directory: string): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${report.runId}.json`)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return path
}

/**
 * Count and ratio every dimension a run reports on.
 *
 * Routing is counted per turn, so its denominator is the turn count no matter
 * how the model behaved; a run cannot improve its routing ratio by producing
 * fewer assertions. The state dimensions are counted per assertion, which is
 * the granularity a reader needs to tell "the record was wrong" from "the gap
 * report was wrong".
 */
function summarize(runs: readonly GoldenCaseRun[]): EvalSummary {
  let casesPassed = 0
  let toolRoutingPassed = 0
  let toolRoutingTotal = 0
  let stateAssertionsPassed = 0
  let stateAssertionsTotal = 0
  let missingFieldAssertionsPassed = 0
  let missingFieldAssertionsTotal = 0
  let toolErrors = 0
  let unexpectedMutations = 0
  let timeouts = 0
  let runtimeErrors = 0
  let inputTokens = 0
  let outputTokens = 0
  let observedTurns = 0
  let totalTurns = 0

  for (const run of runs) {
    if (run.evaluation.passed) casesPassed += 1
    for (const turn of run.evaluation.turns) {
      totalTurns += 1
      toolRoutingTotal += 1
      const routing = turn.results.filter(result => result.kind === 'toolRouting')
      // A turn that faulted produced no routing assertion to pass, so it counts
      // against the ratio rather than for it: "no answer" is not a right answer.
      if (routing.length > 0 && routing.every(result => result.failureType === null)) {
        toolRoutingPassed += 1
      }
      for (const result of turn.results) {
        if (result.kind === 'caseState') {
          stateAssertionsTotal += 1
          if (result.failureType === null) stateAssertionsPassed += 1
        }
        if (result.kind === 'missingFields') {
          missingFieldAssertionsTotal += 1
          if (result.failureType === null) missingFieldAssertionsPassed += 1
        }
        if (result.failureType === 'TOOL_ERROR') toolErrors += 1
        if (result.failureType === 'UNEXPECTED_CASE_MUTATION') unexpectedMutations += 1
        if (result.failureType === 'SESSION_TIMEOUT') timeouts += 1
        if (result.failureType === 'RUNTIME_ERROR') runtimeErrors += 1
      }
      if (turn.usage !== null) {
        inputTokens += turn.usage.inputTokens
        outputTokens += turn.usage.outputTokens
        observedTurns += 1
      }
    }
  }

  return {
    casesPassed,
    casesTotal: runs.length,
    toolRoutingPassed,
    toolRoutingTotal,
    stateAssertionsPassed,
    stateAssertionsTotal,
    missingFieldAssertionsPassed,
    missingFieldAssertionsTotal,
    toolErrors,
    unexpectedMutations,
    timeouts,
    runtimeErrors,
    passRate: runs.length === 0 ? 0 : casesPassed / runs.length,
    usage: usageAggregate({ inputTokens, outputTokens, observedTurns, totalTurns }),
    latencyMs: latencyAggregate(runs),
  }
}

/**
 * State token usage with its own coverage.
 *
 * The sums are over the turns that reported usage, and the counts travel with
 * them, so a run whose runtime measured three turns out of ten reads as an
 * incomplete measurement rather than as a cheap run.
 */
function usageAggregate(totals: {
  inputTokens: number
  outputTokens: number
  observedTurns: number
  totalTurns: number
}): EvalUsageAggregate {
  return { ...totals, complete: totals.observedTurns === totals.totalTurns }
}

/** Sum the wall clock the runner measured per case. */
function latencyAggregate(runs: readonly GoldenCaseRun[]): EvalLatencyAggregate {
  const perCaseMs = runs.map(run => run.latencyMs)
  return { totalMs: perCaseMs.reduce((sum, value) => sum + value, 0), perCaseMs }
}

/** Present one case. */
function caseReport(run: GoldenCaseRun): CaseReport {
  return {
    id: run.evaluation.id,
    passed: run.evaluation.passed,
    failures: run.evaluation.failures,
    turns: run.evaluation.turns.map(reportTurn),
  }
}

/** Present one turn, without the conversation text a report never needs. */
function reportTurn(turn: TurnEvaluation): CaseReportTurn {
  return { turnIndex: turn.turnIndex, toolCalls: turn.toolCalls, caseState: turn.caseState }
}
