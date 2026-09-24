/**
 * Report coverage: aggregation over evaluated cases, and the one seam that
 * writes a report to disk.
 *
 * The cases are built from evaluated assertions rather than replayed, because
 * what is under test is how a run is counted, not how it ran.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { buildReport, createRunId, evalRunsDirectory, writeEvalReport } from '../src/index.ts'
import type {
  AssertionKind,
  CaseEvaluation,
  EvalFailure,
  EvaluationResult,
  FailureType,
  GoldenCase,
  GoldenCaseRun,
  TurnEvaluation,
} from '../src/index.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** The route a synthetic run reports. */
const RUNTIME = { profile: 'medharness', provider: 'mock', model: 'mock', runner: 'deterministic' as const }

/** One evaluated assertion. */
function result(kind: AssertionKind, failureType: FailureType | null): EvaluationResult {
  return {
    kind,
    assertion: `${kind} assertion`,
    failureType,
    detail: `${kind} ${failureType ?? 'passed'}`,
    expected: 'expected',
    actual: failureType === null ? 'expected' : 'actual',
    evidence: { toolCallSeqs: [], toolResultSeqs: [], caseEventSeqs: [] },
  }
}

/** One evaluated turn. */
function turn(index: number, results: EvaluationResult[], usage: TokenUsage | null = null): TurnEvaluation {
  return {
    turnIndex: index,
    passed: results.every(entry => entry.failureType === null),
    results,
    toolCalls: [],
    caseState: null,
    usage,
  }
}

/** The golden case a synthetic run reports against. */
function golden(id: string): GoldenCase {
  return {
    schemaVersion: 1,
    id,
    description: 'A synthetic case used to pin report aggregation.',
    turns: [{ user: '提问', expect: { toolRouting: { kind: 'exact', calls: [] } } }],
  }
}

/** A synthetic run whose failures are derived from its turns, as the evaluator would derive them. */
function run(id: string, turns: TurnEvaluation[], latencyMs: number): GoldenCaseRun {
  const failures: EvalFailure[] = turns.flatMap(entry => entry.results.flatMap(assertion =>
    assertion.failureType === null ? [] : [{
      goldenCaseId: id,
      turnIndex: entry.turnIndex,
      sessionId: `session-${id}`,
      failureType: assertion.failureType,
      assertion: assertion.assertion,
      detail: assertion.detail,
      expected: assertion.expected,
      actual: assertion.actual,
      evidence: assertion.evidence,
    }]))
  const evaluation: CaseEvaluation = {
    id,
    passed: failures.length === 0,
    turns,
    failures,
  }
  return { golden: golden(id), evaluation, latencyMs }
}

/** A passing run: routing, state, and the gap report all hold, and usage was measured. */
function passingRun(): GoldenCaseRun {
  return run('passing', [turn(0, [
    result('toolRouting', null),
    result('caseState', null),
    result('caseState', null),
    result('missingFields', null),
    result('mutation', null),
  ], { inputTokens: 100, outputTokens: 20 })], 500)
}

/** A failing run: one fault of each kind a summary counts separately. */
function failingRun(): GoldenCaseRun {
  return run('failing', [
    turn(0, [
      result('toolRouting', 'WRONG_TOOL'),
      result('toolError', 'TOOL_ERROR'),
      result('missingFields', 'MISSING_FIELDS_MISMATCH'),
      result('caseState', 'UNEXPECTED_CASE_MUTATION'),
    ]),
    turn(1, [result('runtime', 'SESSION_TIMEOUT'), result('runtime', 'RUNTIME_ERROR')]),
  ], 250)
}

describe('summarizing a run', () => {
  it('counts each dimension on its own', () => {
    const report = buildReport({
      runId: 'run-1',
      startedAt: '2026-09-24T06:00:00.000Z',
      finishedAt: '2026-09-24T06:00:01.000Z',
      runtime: RUNTIME,
      runs: [passingRun(), failingRun()],
    })

    expect(report.summary).toEqual({
      casesPassed: 1,
      casesTotal: 2,
      // Routing is counted per turn, so the denominator is the turn count; the
      // turn that faulted and the turn that routed wrongly both count against
      // it, and neither can inflate the ratio by producing no assertion.
      toolRoutingPassed: 1,
      toolRoutingTotal: 3,
      stateAssertionsPassed: 2,
      stateAssertionsTotal: 3,
      missingFieldAssertionsPassed: 1,
      missingFieldAssertionsTotal: 2,
      toolErrors: 1,
      unexpectedMutations: 1,
      timeouts: 1,
      runtimeErrors: 1,
      passRate: 0.5,
      usage: { inputTokens: 100, outputTokens: 20, observedTurns: 1, totalTurns: 3, complete: false },
      latencyMs: { totalMs: 750, perCaseMs: [500, 250] },
    })
  })

  it('reports a run whose runtime measured every turn as complete', () => {
    const report = buildReport({
      runId: 'run-complete',
      startedAt: '2026-09-24T06:00:00.000Z',
      finishedAt: '2026-09-24T06:00:01.000Z',
      runtime: RUNTIME,
      runs: [passingRun()],
    })

    expect(report.summary.usage.complete).toBe(true)
    expect(report.summary.passRate).toBe(1)
  })

  it('reports an empty run without inventing a rate', () => {
    const report = buildReport({
      runId: 'run-empty',
      startedAt: '2026-09-24T06:00:00.000Z',
      finishedAt: '2026-09-24T06:00:00.000Z',
      runtime: { ...RUNTIME, runner: 'live' },
      runs: [],
    })

    expect(report.summary).toEqual({
      casesPassed: 0,
      casesTotal: 0,
      toolRoutingPassed: 0,
      toolRoutingTotal: 0,
      stateAssertionsPassed: 0,
      stateAssertionsTotal: 0,
      missingFieldAssertionsPassed: 0,
      missingFieldAssertionsTotal: 0,
      toolErrors: 0,
      unexpectedMutations: 0,
      timeouts: 0,
      runtimeErrors: 0,
      passRate: 0,
      usage: { inputTokens: 0, outputTokens: 0, observedTurns: 0, totalTurns: 0, complete: true },
      latencyMs: { totalMs: 0, perCaseMs: [] },
    })
  })
})

describe('a report document', () => {
  it('stamps its contract version and the run it describes', () => {
    const report = buildReport({
      runId: 'run-1',
      startedAt: '2026-09-24T06:00:00.000Z',
      finishedAt: '2026-09-24T06:00:01.000Z',
      runtime: RUNTIME,
      runs: [failingRun()],
    })

    expect(report.schemaVersion).toBe(1)
    expect(report.runId).toBe('run-1')
    expect(report.runtime).toEqual(RUNTIME)
    expect(report.cases.map(entry => entry.id)).toEqual(['failing'])
  })

  it('carries the failures and the per-turn outcome, and no conversation text', () => {
    const report = buildReport({
      runId: 'run-1',
      startedAt: '2026-09-24T06:00:00.000Z',
      finishedAt: '2026-09-24T06:00:01.000Z',
      runtime: RUNTIME,
      runs: [failingRun()],
    })

    const presented = report.cases[0]
    expect(presented?.passed).toBe(false)
    expect(presented?.failures.map(failure => failure.failureType)).toEqual([
      'WRONG_TOOL',
      'TOOL_ERROR',
      'MISSING_FIELDS_MISMATCH',
      'UNEXPECTED_CASE_MUTATION',
      'SESSION_TIMEOUT',
      'RUNTIME_ERROR',
    ])
    expect(presented?.turns).toEqual([
      { turnIndex: 0, toolCalls: [], caseState: null },
      { turnIndex: 1, toolCalls: [], caseState: null },
    ])
    expect(JSON.stringify(report)).not.toContain('提问')
  })
})

describe('where a report lives', () => {
  it('names a run after the instant it started', () => {
    expect(createRunId(new Date('2026-09-24T06:00:00.000Z'))).toBe('2026-09-24T06-00-00-000Z')
  })

  it('keeps local reports beside the session logs rather than in history', () => {
    expect(evalRunsDirectory('D:/checkout')).toBe(join('D:/checkout', '.medharness', 'eval-runs'))
  })

  it('writes a report as JSON, creating the directory it needs', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-eval-')), 'eval-runs')
    roots.push(directory)
    const report = buildReport({
      runId: 'run-1',
      startedAt: '2026-09-24T06:00:00.000Z',
      finishedAt: '2026-09-24T06:00:01.000Z',
      runtime: RUNTIME,
      runs: [passingRun()],
    })

    const path = writeEvalReport(report, directory)

    expect(path).toBe(join(directory, 'run-1.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report)
  })
})
