/**
 * End-to-end coverage of the case feature through the REAL agent loop: only the
 * model is mocked. Turn one records what the user says, turn two completes the
 * record, and the assertions read the domain's authoritative state — not the
 * assistant's prose — because remembering the case in conversation history is
 * exactly what this feature exists to stop relying on.
 *
 * The final cases replay the durable JSONL log to show the case survives a
 * process restart with nothing but the session log to rebuild it from.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { foldMedicalCase, MedicalCaseService } from '@deepseek-ai/dsh-medical-case'
import { SessionId, type SessionEvent, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolMedicalCaseGet from '@deepseek-ai/dsh-tool-medical-case-get'
import * as ToolMedicalCaseUpdate from '@deepseek-ai/dsh-tool-medical-case-update'
import * as ToolMedicalCaseIntake from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** Mount every capability the case tools need, optionally over a real log root. */
async function harness(adapter: MockAdapter, root?: string): Promise<Context> {
  const ctx = new Context()
  if (root === undefined) {
    await mountAgentLoopTestDependencies(ctx)
  } else {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // The backend mounts before the loop so root teardown unwinds the loop first.
    await ctx.plugin(JsonlSessionPersistence, { root })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(ToolMedicalCaseIntake)
  await ctx.plugin(ToolMedicalCaseUpdate)
  await ctx.plugin(ToolMedicalCaseGet)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Send one human turn and wait for the loop to settle. */
async function say(ctx: Context, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
}

/** Tool names the log recorded, in call order. */
function calledTools(log: readonly SessionEvent[]): string[] {
  return log.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
}

/** The durable case records a session logged, in order. */
function caseEvents(log: readonly SessionEvent[]): SessionEvent[] {
  return log.filter(event => event.type === 'medical/case-change')
}

const SCRIPT = [
  toolCallResponse('call-1', 'medical_case_intake', { symptoms: ['头疼', '发烧'] }, 'Recording the case.'),
  textResponse('症状持续多久了？您的年龄是多少？'),
  toolCallResponse('call-2', 'medical_case_update', { duration: '两天', age: 25 }, 'Completing the record.'),
  textResponse('病例信息已收集完整。'),
]

describe('two-turn case intake through the agent loop', () => {
  it('records turn one, completes the record in turn two, and keeps one case', async () => {
    const ctx = await harness(new MockAdapter([...SCRIPT]))
    const agent = await ctx.agentLoop.create(SessionId('multi-turn'), { provider: 'mock', model: 'mock' })

    await say(ctx, agent, '我头疼、发烧')
    const afterTurnOne = ctx.medicalCase.require(agent)
    expect(afterTurnOne).toMatchObject({
      revision: 1,
      symptoms: ['头疼', '发烧'],
      duration: null,
      age: null,
      missingFields: ['duration', 'age'],
    })

    await say(ctx, agent, '25 岁，两天了')
    const afterTurnTwo = ctx.medicalCase.require(agent)
    expect(afterTurnTwo).toMatchObject({
      revision: 2,
      symptoms: ['头疼', '发烧'],
      duration: '两天',
      age: 25,
      missingFields: [],
    })
    // Turn two updated the recorded case rather than starting a second one.
    expect(afterTurnTwo.caseId).toBe(afterTurnOne.caseId)

    const log = agent.session.snapshotEvents()
    expect(calledTools(log)).toEqual(['medical_case_intake', 'medical_case_update'])
    expect(caseEvents(log)).toHaveLength(2)
    expect(caseEvents(log).map(event => event.type === 'medical/case-change' ? event.data.operation : ''))
      .toEqual(['create', 'update'])
  })

  it('records a tool/call and a non-error tool/result for every model call', async () => {
    const ctx = await harness(new MockAdapter([...SCRIPT]))
    const agent = await ctx.agentLoop.create(SessionId('multi-turn-events'), { provider: 'mock', model: 'mock' })
    await say(ctx, agent, '我头疼、发烧')
    await say(ctx, agent, '25 岁，两天了')

    const log = agent.session.snapshotEvents()
    for (const callId of ['call-1', 'call-2']) {
      const call = log.find(event => event.type === 'tool/call' && event.data.callId === callId)
      const result = log.find(event => event.type === 'tool/result'
        && event.data.message.content.some(block => block.type === 'tool-result' && block.toolCallId === callId))
      expect(call, `${callId} must be logged`).toBeDefined()
      expect(result, `${callId} must produce a result`).toBeDefined()
      const block = result?.type === 'tool/result'
        ? result.data.message.content.find(entry => entry.type === 'tool-result')
        : undefined
      expect(block?.isError).toBe(false)
    }
  })

  it('keeps two sessions in the same process fully separate', async () => {
    const ctx = await harness(new MockAdapter([
      ...SCRIPT,
      toolCallResponse('call-3', 'medical_case_intake', { symptoms: ['咳嗽'], duration: '1 天', age: 60 }, 'Recording.'),
      textResponse('已记录。'),
    ]))
    const first = await ctx.agentLoop.create(SessionId('isolated-a'), { provider: 'mock', model: 'mock' })
    const second = await ctx.agentLoop.create(SessionId('isolated-b'), { provider: 'mock', model: 'mock' })

    await say(ctx, first, '我头疼、发烧')
    await say(ctx, first, '25 岁，两天了')
    await say(ctx, second, '我咳嗽')

    expect(ctx.medicalCase.require(first)).toMatchObject({ age: 25, symptoms: ['头疼', '发烧'] })
    expect(ctx.medicalCase.require(second)).toMatchObject({ age: 60, symptoms: ['咳嗽'] })
    expect(ctx.medicalCase.require(first).caseId).not.toBe(ctx.medicalCase.require(second).caseId)
  })

  it('lets the agent read the record back with the explicit get tool', async () => {
    const ctx = await harness(new MockAdapter([
      ...SCRIPT,
      toolCallResponse('call-3', 'medical_case_get', {}, 'Reading the record.'),
      textResponse('记录完整，无缺失字段。'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('read-back'), { provider: 'mock', model: 'mock' })
    await say(ctx, agent, '我头疼、发烧')
    await say(ctx, agent, '25 岁，两天了')
    await say(ctx, agent, '现在病例里都记了什么？')

    const log = agent.session.snapshotEvents()
    expect(calledTools(log)).toEqual(['medical_case_intake', 'medical_case_update', 'medical_case_get'])
    const read = log.findLast(event => event.type === 'tool/result')
    expect(JSON.stringify(read)).toContain('missingFields: (none)')
  })
})

describe('the case survives a restart with only the session log', () => {
  it('replays the persisted log into the same case', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-medical-case-'))
    roots.push(root)
    const sessionId = SessionId('persisted')

    const ctx = await harness(new MockAdapter([...SCRIPT]), root)
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    await say(ctx, agent, '我头疼、发烧')
    await say(ctx, agent, '25 岁，两天了')
    const live = ctx.medicalCase.require(agent)
    await ctx.fiber.dispose()

    // A brand-new process reads the durable log back through the persistence seam.
    const reopened = await harness(new MockAdapter([]), root)
    const handle = await reopened.sessionPersistence.open(sessionId, 'read')
    let persisted: readonly SessionEvent[]
    try {
      persisted = (await handle.read()).events
    } finally {
      await handle.close()
    }

    expect(persisted.length).toBeGreaterThan(0)
    const records = persisted.filter(event => event.type === 'medical/case-change')
    expect(records).toHaveLength(2)

    // The whole case is reconstructable from the durable log alone.
    const folded = foldMedicalCase(persisted)
    expect(folded.current).toMatchObject({
      caseId: live.caseId,
      revision: 2,
      symptoms: ['头疼', '发烧'],
      duration: '两天',
      age: 25,
    })

    // And a cold projection registry rebuilds the identical case from those records.
    const fresh = await harness(new MockAdapter([]))
    const rebuilt = await fresh.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    for (const record of records) rebuilt.session.append(record.type, record.data)
    expect(fresh.medicalCase.require(rebuilt)).toEqual(live)
  })
})
