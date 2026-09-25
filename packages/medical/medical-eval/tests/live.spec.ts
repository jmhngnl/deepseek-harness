/**
 * Live-runner coverage: the argument grammar, the case selection, the
 * statements the report makes about itself, the surface guard, and one booted
 * composition.
 *
 * Exactly one test here boots, because booting is the expensive part and one
 * run already exercises the seam. Its model is scripted: CI must not spend a
 * real request, and a live failure is a result to be read rather than a flake
 * to be retried. What the runner does with the composition's own default route
 * — the live path — is deliberately not faked here; a route substituted for it
 * would misreport what the report's `runner: live` line claims.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-llm'
import { buildReport, createRunId } from '../src/index.ts'
import type { EvalReport, GoldenCase } from '../src/index.ts'
import {
  LIVE_MEDICAL_TOOLS,
  LIVE_PROFILE,
  SMOKE_CASE_IDS,
  assertMedicalSurface,
  liveRoster,
  liveRuntime,
  parseLiveArgs,
  renderLiveArgsErrors,
  renderLiveSummary,
  runLiveEval,
  selectLiveCases,
} from '../src/live.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** The shipped roster, read the way the entry point reads it. */
const ROSTER: readonly GoldenCase[] = liveRoster()

/** The route a scripted run declares, so no real provider is ever addressed. */
const MOCK_ROUTE = { provider: 'medharness-live-eval-mock', model: 'mock' }

/** Booting pulls this bundle's workspace graph through the test transform; cold that is tens of seconds. */
const BOOT_TIMEOUT = 120_000

/** The one shipped case the booted run replays: a single turn, recorded in one call. */
function rosterCase(id: string): GoldenCase {
  const found = ROSTER.find(golden => golden.id === id)
  if (found === undefined) throw new Error(`the roster has no case ${id}`)
  return found
}

describe('the live argument grammar', () => {
  it('asks for the smoke set when the invocation names nothing', () => {
    const parsed = parseLiveArgs([])

    expect(parsed.errors).toEqual([])
    expect(parsed.args).toEqual({ all: false, ids: [] })
  })

  it('collects every --case, in the order given', () => {
    const parsed = parseLiveArgs(['--case', 'one', '--case', 'two'])

    expect(parsed.errors).toEqual([])
    expect(parsed.args?.ids).toEqual(['one', 'two'])
    expect(parsed.args?.all).toBe(false)
  })

  it('reads --all as the whole roster', () => {
    const parsed = parseLiveArgs(['--all'])

    expect(parsed.errors).toEqual([])
    expect(parsed.args).toEqual({ all: true, ids: [] })
  })

  it('refuses to combine --all with --case', () => {
    const parsed = parseLiveArgs(['--all', '--case', 'one'])

    expect(parsed.args).toBeUndefined()
    expect(parsed.errors).toEqual(['--all cannot be combined with --case'])
  })

  it('refuses a --case with no value', () => {
    const parsed = parseLiveArgs(['--case'])

    expect(parsed.args).toBeUndefined()
    expect(parsed.errors).toEqual(['--case requires a case id'])
  })

  it('refuses a --case whose value is itself an option', () => {
    const parsed = parseLiveArgs(['--case', '--all'])

    expect(parsed.args).toBeUndefined()
    expect(parsed.errors).toEqual(['--case requires a case id'])
  })

  it('refuses a --case whose value is blank', () => {
    const parsed = parseLiveArgs(['--case', ''])

    expect(parsed.args).toBeUndefined()
    expect(parsed.errors).toEqual(['--case requires a case id'])
  })

  it('names an unknown option', () => {
    const parsed = parseLiveArgs(['--provider', 'other'])

    expect(parsed.args).toBeUndefined()
    expect(parsed.errors).toEqual(['unknown option --provider'])
  })

  it('names a bare positional', () => {
    const parsed = parseLiveArgs(['007-get-reads-without-changing'])

    expect(parsed.args).toBeUndefined()
    expect(parsed.errors).toEqual(['unexpected argument 007-get-reads-without-changing'])
  })

  it('renders a rejection with the cases that could have been named', () => {
    const lines = renderLiveArgsErrors(['unknown case nope'], ROSTER)

    expect(lines[0]).toBe('medharness:eval: unknown case nope')
    expect(lines[1]).toContain(SMOKE_CASE_IDS[0]!)
    expect(lines[1]).toContain('get-reads-without-changing')
  })
})

describe('selecting live cases', () => {
  it('defaults to the smoke set, in roster order', () => {
    const selected = selectLiveCases(ROSTER, { all: false, ids: [] })

    expect(selected.unknown).toEqual([])
    expect(selected.cases.map(golden => golden.id)).toEqual([...SMOKE_CASE_IDS])
  })

  it('honours a named case and nothing else', () => {
    const selected = selectLiveCases(ROSTER, { all: false, ids: ['get-reads-without-changing'] })

    expect(selected.unknown).toEqual([])
    expect(selected.cases.map(golden => golden.id)).toEqual(['get-reads-without-changing'])
  })

  it('takes the whole roster for --all', () => {
    const selected = selectLiveCases(ROSTER, { all: true, ids: [] })

    expect(selected.unknown).toEqual([])
    expect(selected.cases).toHaveLength(ROSTER.length)
  })

  it('reports an id the roster does not hold instead of running a shorter suite', () => {
    const selected = selectLiveCases(ROSTER, { all: false, ids: ['nope', 'update-adds-a-symptom'] })

    expect(selected.unknown).toEqual(['nope'])
    expect(selected.cases.map(golden => golden.id)).toEqual(['update-adds-a-symptom'])
  })
})

describe('the statements a live report makes about itself', () => {
  it('records the profile, the route it resolved, and that a live runner produced it', () => {
    expect(liveRuntime({ provider: 'p', model: 'm' })).toEqual({
      profile: LIVE_PROFILE,
      provider: 'p',
      model: 'm',
      runner: 'live',
    })
  })

  it('names a run at millisecond resolution', () => {
    const first = createRunId(new Date('2026-01-01T00:00:00.000Z'))

    // The identity keeps the milliseconds `toISOString` carries, so two runs in
    // the same millisecond collide and two a millisecond apart do not.
    expect(createRunId(new Date('2026-01-01T00:00:00.000Z'))).toBe(first)
    expect(createRunId(new Date('2026-01-01T00:00:00.001Z'))).not.toBe(first)
    expect(first).not.toContain(':')
  })

  it('prints a passing case and its measurements', () => {
    const report = reportWith([])
    const lines = renderLiveSummary(report, '/tmp/run.json')

    expect(lines[0]).toBe(`profile=${LIVE_PROFILE} provider=p model=m runner=live`)
    // The counts are asserted as a shape here and as values by the booted run
    // below; a renderer test should not invent numbers a run never produced.
    expect(lines[1]).toMatch(/^cases=\d+\/\d+ passed routing=\d+\/\d+ state=\d+\/\d+ missingFields=\d+\/\d+$/)
    expect(lines[2]).toMatch(/^toolErrors=\d+ unexpectedMutations=\d+ timeouts=\d+ runtimeErrors=\d+$/)
    expect(lines[3]).toMatch(/^usage input=\d+ output=\d+ turns=\d+\/\d+ complete=(?:true|false)$/)
    expect(lines[4]).toMatch(/^latency totalMs=\d+$/)
    expect(lines).toContain('PASS some-case')
    expect(lines).toContain('report=/tmp/run.json')
  })

  it('prints a failing case with its taxonomy entry and detail rather than hiding it', () => {
    const report = reportWith([{
      goldenCaseId: 'some-case',
      turnIndex: 1,
      sessionId: 'session-1',
      failureType: 'WRONG_TOOL',
      assertion: 'toolRouting',
      detail: 'the model wrote to the record a read-only turn must leave alone',
      expected: 'medical_case_get',
      actual: 'medical_case_update',
      evidence: { toolCallSeqs: [4], toolResultSeqs: [5], caseEventSeqs: [7] },
    }])
    const lines = renderLiveSummary(report, '/tmp/run.json')

    expect(lines).toContain('FAIL some-case')
    expect(lines.some(line => line.includes('WRONG_TOOL'))).toBe(true)
    expect(lines.some(line => line.includes('must leave alone'))).toBe(true)
  })
})

describe('the surface guard', () => {
  it('accepts exactly the three medical tools, in any order', () => {
    expect(() => { assertMedicalSurface([...LIVE_MEDICAL_TOOLS].reverse()) }).not.toThrow()
  })

  it('rejects a composition that published a fourth tool', () => {
    expect(() => { assertMedicalSurface([...LIVE_MEDICAL_TOOLS, 'bash']) })
      .toThrow(/must publish exactly/)
  })

  it('rejects a composition that published nothing', () => {
    expect(() => { assertMedicalSurface([]) }).toThrow(/it published nothing/)
  })
})

describe('a run with nothing selected', () => {
  it('refuses before booting anything', async () => {
    await expect(runLiveEval({ root: tmpdir(), cases: [] }))
      .rejects.toThrow(/no case selected/)
  })
})

describe('a booted live run', () => {
  it('replays a case through the shipped profile and writes its report', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
      textResponse('已记录。'),
    ])
    const root = mkdtempSync(join(tmpdir(), 'medharness-live-eval-'))

    const result = await runLiveEval({
      root,
      cases: [rosterCase('intake-complete-first-contact')],
      route: MOCK_ROUTE,
      onRuntimeReady: (ctx) => { ctx.llm.registerAdapter([MOCK_ROUTE.provider], adapter) },
    })

    expect(result.report.schemaVersion).toBe(1)
    expect(result.report.runtime).toEqual({
      profile: LIVE_PROFILE,
      provider: MOCK_ROUTE.provider,
      model: MOCK_ROUTE.model,
      runner: 'live',
    })
    expect(result.route).toEqual(MOCK_ROUTE)
    // The report lands where the harness documents it, named by the run id.
    expect(result.path).toBe(join(root, '.medharness', 'eval-runs', `${result.report.runId}.json`))
    expect(existsSync(result.path)).toBe(true)
    // The case passed against the SHIPPED composition: the surface guard above
    // would have refused a runtime that published anything but the three tools.
    expect(result.report.cases.map(reported => reported.id)).toEqual(['intake-complete-first-contact'])
    expect(result.report.cases[0]?.failures).toEqual([])
    expect(result.report.summary.casesPassed).toBe(1)
    expect(result.report.summary.toolRoutingPassed).toBe(1)
    // Two model calls per turn: the tool call, then the text that ends it.
    expect(adapter.requests).toHaveLength(2)
    // The scripted route reports usage on both calls, so the run is a complete
    // measurement rather than a partial one.
    expect(result.report.summary.usage.complete).toBe(true)
    expect(result.report.summary.usage.observedTurns).toBe(1)

    // What the entry point prints is derived from this report, so the route
    // line and the verdict are checkable without opening the JSON.
    const printed = renderLiveSummary(result.report, result.path)
    expect(printed[0]).toBe(
      `profile=${LIVE_PROFILE} provider=${MOCK_ROUTE.provider} model=${MOCK_ROUTE.model} runner=live`,
    )
    expect(printed).toContain('PASS intake-complete-first-contact')
    expect(printed).toContain(`report=${result.path}`)
  }, BOOT_TIMEOUT)

  it('cancels a turn that never settles and reports it rather than retrying', async () => {
    const adapter = new MockAdapter(['hang'])
    const root = mkdtempSync(join(tmpdir(), 'medharness-live-eval-timeout-'))

    const result = await runLiveEval({
      root,
      cases: [rosterCase('intake-first-contact-two-symptoms')],
      route: MOCK_ROUTE,
      turnTimeoutMs: 200,
      onRuntimeReady: (ctx) => { ctx.llm.registerAdapter([MOCK_ROUTE.provider], adapter) },
    })

    // A live failure is a result: the run finished, wrote its report, and says
    // what went wrong instead of repairing the case or retrying the turn.
    expect(result.report.summary.casesPassed).toBe(0)
    expect(result.report.summary.timeouts).toBe(1)
    expect(result.report.cases[0]?.failures.map(failure => failure.failureType))
      .toEqual(['SESSION_TIMEOUT'])
    expect(existsSync(result.path)).toBe(true)
    const printed = renderLiveSummary(result.report, result.path)
    expect(printed).toContain('FAIL intake-first-contact-two-symptoms')
    expect(printed.some(line => line.includes('SESSION_TIMEOUT'))).toBe(true)
  }, BOOT_TIMEOUT)
})

/**
 * A report over one synthetic case, carrying the failure passed in.
 *
 * `renderLiveSummary` reads only a case's verdict and its failures, so the
 * summary block can be the empty one a run with no cases produces.
 * @param failures - the failures the synthetic case reports.
 * @returns a report over a single case.
 */
function reportWith(failures: EvalReport['cases'][number]['failures']): EvalReport {
  const base = buildReport({
    runId: 'run',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    runtime: liveRuntime({ provider: 'p', model: 'm' }),
    runs: [],
  })
  return { ...base, cases: [{ id: 'some-case', passed: failures.length === 0, turns: [], failures }] }
}
