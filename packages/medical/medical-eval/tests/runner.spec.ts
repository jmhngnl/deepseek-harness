/**
 * Runner coverage: the shipped roster replayed through real agent loops.
 *
 * Only the model is scripted. The tool registry, the session, the projection
 * registry, the case domain, and tool execution are the shipped
 * implementations, so a case that passes here passed against the runtime
 * rather than against a re-mounting of it. Assertions read the durable case
 * the domain derived — never the assistant's text — because a conversation
 * that says "recorded" and a case holding no symptoms can disagree, and only
 * one of them is evidence.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { loadGoldenCases, runGoldenCases } from '../src/index.ts'
import type { GoldenCase, GoldenCaseHarness } from '../src/index.ts'
import { MedicalCaseService } from '@deepseek-ai/dsh-medical-case'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolMedicalCaseGet from '@deepseek-ai/dsh-tool-medical-case-get'
import * as ToolMedicalCaseIntake from '@deepseek-ai/dsh-tool-medical-case-intake'
import * as ToolMedicalCaseUpdate from '@deepseek-ai/dsh-tool-medical-case-update'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** The directory the shipped roster lives in. */
const ROSTER = fileURLToPath(new URL('../golden/', import.meta.url))

/** Provider route every scripted adapter is registered under. */
const PROVIDER = 'mock'

/** A scripted model call, or a marker that the turn never settles. */
type ScriptEntry = StreamChunk[] | 'hang' | (() => never)

/** One case's runtime as the runner receives it. */
interface Built {
  readonly harness: GoldenCaseHarness
  readonly adapter: MockAdapter
}

/** Mount the shipped services and one scripted model under a context of this case's own. */
async function build(caseId: string, script: ScriptEntry[]): Promise<Built> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(ToolMedicalCaseIntake)
  await ctx.plugin(ToolMedicalCaseUpdate)
  await ctx.plugin(ToolMedicalCaseGet)
  // The adapter consumes the script it is handed, so each case gets its own copy.
  const adapter = new MockAdapter([...script])
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`golden-${caseId}`), { provider: PROVIDER, model: 'mock' })
  return { harness: { ctx, agent }, adapter }
}

/** One shipped case, which the roster is expected to hold. */
function rosterCase(id: string): GoldenCase {
  const found = loadGoldenCases(ROSTER).find(golden => golden.id === id)
  if (found === undefined) throw new Error(`the roster has no case ${id}`)
  return found
}

/** A model call whose tool arguments are whatever the model emitted, verbatim. */
function rawCall(callId: string, name: string, rawArguments: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name, argumentsDelta: rawArguments },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: rawArguments },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A model call that reports no token usage, which is how an unmetered route answers. */
function unmeasuredText(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * What the model says for each case, as the contract documents it.
 *
 * Each turn is two calls: the tool call the case is about, then the text that
 * ends the turn. Anything else — a second tool call, a request the script does
 * not have — fails the run, which is how a case detects that the loop needed
 * more from the model than the case anticipated.
 */
const SCRIPTS: Record<string, ScriptEntry[]> = {
  'intake-first-contact-two-symptoms': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'] }),
    textResponse('症状持续多久了？您多大年龄？'),
  ],
  'intake-complete-first-contact': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
  ],
  'update-completes-the-record': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'] }),
    textResponse('持续多久了？您多大年龄？'),
    toolCallResponse('c2', 'medical_case_update', { duration: '两天', age: 25 }),
    textResponse('已补全。'),
  ],
  'update-adds-a-symptom': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_update', { symptomsAdd: ['恶心'] }),
    textResponse('已添加。'),
  ],
  'update-removes-a-corrected-symptom': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_update', { symptomsRemove: ['发烧'] }),
    textResponse('已更正。'),
  ],
  'update-corrects-the-age': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_update', { age: 26 }),
    textResponse('已更正。'),
  ],
  'get-reads-without-changing': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_get', {}),
    textResponse('记录完整。'),
  ],
  'intake-restatement-writes-nothing': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], age: 25 }),
    textResponse('还需要持续时间和年龄。'),
    toolCallResponse('c2', 'medical_case_intake', { symptoms: ['头疼', '发烧'], age: 25 }),
    textResponse('记录未变。'),
  ],
}

/** Replay the shipped roster, capturing each case's adapter and session. */
async function replayRoster(): Promise<{
  runs: Awaited<ReturnType<typeof runGoldenCases>>
  adapters: Map<string, MockAdapter>
  sessions: string[]
}> {
  const adapters = new Map<string, MockAdapter>()
  const sessions: string[] = []
  const runs = await runGoldenCases(loadGoldenCases(ROSTER), async (golden) => {
    const script = SCRIPTS[golden.id]
    if (script === undefined) throw new Error(`the roster has no script for ${golden.id}`)
    const built = await build(golden.id, script)
    adapters.set(golden.id, built.adapter)
    sessions.push(built.harness.agent.session.id)
    return built.harness
  })
  return { runs, adapters, sessions }
}

describe('replaying the shipped roster', () => {
  it('passes every case', async () => {
    const { runs } = await replayRoster()

    const reported = runs.flatMap(run => run.evaluation.failures.map(failure =>
      `${run.evaluation.id} turn ${String(failure.turnIndex)}: ${failure.failureType} — ${failure.detail}`))

    expect(reported).toEqual([])
    expect(runs).toHaveLength(8)
    expect(runs.every(run => run.evaluation.passed)).toBe(true)
  })

  it('gives every case a session and a case identity of its own', async () => {
    const { runs, sessions } = await replayRoster()

    expect(new Set(sessions).size).toBe(8)
    const identities = runs.map(run => run.evaluation.turns.at(-1)?.caseState?.caseId)
    expect(identities.every(identity => identity !== undefined)).toBe(true)
    expect(new Set(identities).size).toBe(8)
  })

  it('asks the model for exactly the calls each case scripts', async () => {
    const { runs, adapters } = await replayRoster()

    for (const run of runs) {
      // Two calls per turn: the tool call the case is about, then the text that
      // ends the turn. More would mean the loop needed a second step.
      expect(adapters.get(run.evaluation.id)?.requests, run.evaluation.id)
        .toHaveLength(run.golden.turns.length * 2)
    }
  })

  it('measures each case', async () => {
    const { runs } = await replayRoster()
    expect(runs.every(run => Number.isFinite(run.latencyMs))).toBe(true)
  })

  it('leaves the revision and the log alone for a read and for a restatement', async () => {
    const { runs } = await replayRoster()
    const read = runs.find(run => run.evaluation.id === 'get-reads-without-changing')
    const restatement = runs.find(run => run.evaluation.id === 'intake-restatement-writes-nothing')

    // The expectations these cases carry assert `changed: false` and
    // `eventCountDelta: 0`, so a passing turn is the proof that no
    // `medical/case-change` record was appended for it.
    expect(read?.evaluation.turns[1]?.toolCalls).toEqual(['medical_case_get'])
    expect(read?.evaluation.turns[1]?.caseState?.revision).toBe(1)
    expect(restatement?.evaluation.turns[1]?.toolCalls).toEqual(['medical_case_intake'])
    expect(restatement?.evaluation.turns[1]?.caseState?.revision).toBe(1)
  })

  it('advances the revision the case that writes twice expects', async () => {
    const { runs } = await replayRoster()
    const completing = runs.find(run => run.evaluation.id === 'update-completes-the-record')

    expect(completing?.evaluation.turns.map(turn => turn.caseState?.revision)).toEqual([1, 2])
    expect(completing?.evaluation.turns[1]?.caseState?.missingFields).toEqual([])
  })
})

describe('a case that regresses', () => {
  it('classifies the regression instead of passing it', async () => {
    const runs = await runGoldenCases([rosterCase('get-reads-without-changing')], async () => (await build('regression', [
      toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
      textResponse('已记录。'),
      // The turn asked what the record holds and the model wrote to it instead.
      toolCallResponse('c2', 'medical_case_update', { age: 30 }),
      textResponse('已更新。'),
    ])).harness)

    const evaluation = runs[0]?.evaluation
    expect(evaluation?.passed).toBe(false)
    expect(new Set(evaluation?.failures.map(failure => failure.failureType)))
      .toEqual(new Set(['WRONG_TOOL', 'CASE_STATE_MISMATCH', 'REVISION_MISMATCH', 'UNEXPECTED_CASE_MUTATION']))

    const wrong = evaluation?.failures.find(failure => failure.failureType === 'WRONG_TOOL')
    expect(wrong?.goldenCaseId).toBe('get-reads-without-changing')
    expect(wrong?.turnIndex).toBe(1)
    expect(wrong?.evidence.toolResultSeqs).toHaveLength(1)
    expect(wrong?.evidence.caseEventSeqs).toHaveLength(1)
  })
})

describe('a turn that never settles', () => {
  it('cancels it at the ceiling and reports the timeout', async () => {
    const runs = await runGoldenCases(
      [rosterCase('intake-first-contact-two-symptoms')],
      async () => (await build('timeout', ['hang'])).harness,
      { turnTimeoutMs: 150 },
    )

    expect(runs[0]?.evaluation.failures.map(failure => failure.failureType)).toEqual(['SESSION_TIMEOUT'])
    expect(runs[0]?.evaluation.turns[0]?.caseState).toBeNull()
  })
})

describe('a model call that fails', () => {
  it('reports the fault rather than an assertion the partial turn would have failed anyway', async () => {
    let adapter: MockAdapter | undefined
    const runs = await runGoldenCases(
      [rosterCase('intake-first-contact-two-symptoms')],
      async () => {
        const built = await build('request-failure', [
          () => { throw new LlmError('the provider refused the request', 'INVALID_REQUEST') },
        ])
        adapter = built.adapter
        return built.harness
      },
    )

    expect(runs[0]?.evaluation.failures.map(failure => failure.failureType)).toEqual(['RUNTIME_ERROR'])
    expect(runs[0]?.evaluation.failures[0]?.detail).toContain('INVALID_REQUEST')
    expect(adapter?.requests).toHaveLength(1)
  })
})

describe('the harness a caller supplies', () => {
  it('may be built before the run rather than by a factory', async () => {
    const built = await build('prebuilt', SCRIPTS['intake-complete-first-contact'] ?? [])

    const runs = await runGoldenCases([rosterCase('intake-complete-first-contact')], () => built.harness)

    expect(runs[0]?.evaluation.passed).toBe(true)
  })
})

describe('a model that emits arguments the harness cannot read', () => {
  it('reports an argument fault rather than aborting the run', async () => {
    const unreadable: readonly (readonly [label: string, raw: string])[] = [
      ['arguments that are not JSON', '{"symptoms":'],
      ['arguments JSON cannot carry', '{"symptoms": 1e999}'],
    ]

    for (const [index, [label, raw]] of unreadable.entries()) {
      const runs = await runGoldenCases(
        [rosterCase('intake-first-contact-two-symptoms')],
        async () => (await build(`unreadable-${String(index)}`, [
          rawCall('c1', 'medical_case_intake', raw),
          textResponse('已记录。'),
        ])).harness,
      )

      const types = runs[0]?.evaluation.failures.map(failure => failure.failureType) ?? []
      expect(types, label).toContain('ARGUMENT_EXTRACTION_ERROR')
    }
  })
})

describe('a route that measures nothing', () => {
  it('reports usage as absent rather than as zero', async () => {
    const runs = await runGoldenCases(
      [rosterCase('intake-complete-first-contact')],
      async () => (await build('unmeasured', [
        rawCall('c1', 'medical_case_intake', JSON.stringify({ symptoms: ['头疼', '发烧'], duration: '两天', age: 25 })),
        unmeasuredText('已记录。'),
      ])).harness,
    )

    expect(runs[0]?.evaluation.passed).toBe(true)
    expect(runs[0]?.evaluation.turns[0]?.usage).toBeNull()
  })
})
