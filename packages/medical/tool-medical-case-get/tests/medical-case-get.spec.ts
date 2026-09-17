/**
 * Unit coverage for `medical_case_get`: the explicit read path that returns the
 * session's authoritative case without changing it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import MedicalCaseService from '@deepseek-ai/dsh-medical-case'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolMedicalCaseGet from '../src/index.ts'

const signal = new AbortController().signal
let callNumber = 0

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  execute(): Promise<ToolExecutionResult>
}

async function setup(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(ToolMedicalCaseGet)
  const agent = await ctx.agentLoop.create(SessionId('session-a'), {}, {})
  return {
    ctx,
    agent,
    execute: () => ctx.tools.execute({
      signal,
      callId: ToolCallId(`medical-get-${++callNumber}`),
      name: 'medical_case_get',
      arguments: {},
      agent,
    }),
  }
}

/** The durable case records one session logged, in order. */
function caseEvents(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'medical/case-change')
}

describe('medical_case_get registration and schema', () => {
  it('takes no parameter and offers the read-only contract', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'medical_case_get')
    expect(schema).toMatchObject({ name: 'medical_case_get', parameters: { type: 'object', properties: {} } })
    expect(schema?.description ?? '').toContain('without changing it')
    expect(schema?.description ?? '').toContain('does not diagnose')
  })

  it('unregisters with its plugin fiber', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(MedicalCaseService)
    const fiber = ctx.plugin(ToolMedicalCaseGet)
    await fiber
    expect(ctx.tools.get('medical_case_get')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('medical_case_get')).toBeUndefined()
  })
})

describe('medical_case_get reads the authoritative record', () => {
  it('returns the record the session has already captured', async () => {
    const harness = await setup()
    harness.ctx.medicalCase.create(harness.agent, { symptoms: ['headache', 'fever'], duration: '2 days', age: 25 })
    const result = await harness.execute()

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      revision: 1,
      symptoms: ['headache', 'fever'],
      duration: '2 days',
      age: 25,
      missingFields: [],
    })
  })

  it('reports the facts still missing', async () => {
    const harness = await setup()
    harness.ctx.medicalCase.intake(harness.agent, { symptoms: ['headache'] })
    expect((await harness.execute()).value).toMatchObject({ missingFields: ['duration', 'age'] })
  })

  it('reflects a later revision, not the state at write time', async () => {
    const harness = await setup()
    harness.ctx.medicalCase.intake(harness.agent, { symptoms: ['headache'] })
    harness.ctx.medicalCase.applyPatch(harness.agent, { duration: '2 days', age: 25 })
    expect((await harness.execute()).value).toMatchObject({ revision: 2, missingFields: [] })
  })

  it('changes nothing: no event and no revision', async () => {
    const harness = await setup()
    harness.ctx.medicalCase.create(harness.agent, { symptoms: ['headache'], duration: '2 days', age: 25 })
    const before = caseEvents(harness.agent).length
    await harness.execute()
    await harness.execute()
    expect(caseEvents(harness.agent)).toHaveLength(before)
    expect(harness.ctx.medicalCase.require(harness.agent).revision).toBe(1)
  })

  it('fails clearly when the session has no case yet', async () => {
    const harness = await setup()
    const result = await harness.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no recorded medical case')
  })

  it('refuses to run without a calling agent session', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-get-no-agent'),
      name: 'medical_case_get',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires a calling agent session')
  })
})

describe('medical_case_get respects session isolation', () => {
  it('reads only its own session', async () => {
    const harness = await setup()
    const other = await harness.ctx.agentLoop.create(SessionId('session-b'), {}, {})
    harness.ctx.medicalCase.create(harness.agent, { symptoms: ['headache'], duration: '2 days', age: 25 })
    harness.ctx.medicalCase.create(other, { symptoms: ['cough'], duration: '1 day', age: 60 })

    const mine = await harness.execute()
    expect(mine.value).toMatchObject({ age: 25, symptoms: ['headache'] })

    const theirs = await harness.ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-get-other'),
      name: 'medical_case_get',
      arguments: {},
      agent: other,
    })
    expect(theirs.value).toMatchObject({ age: 60, symptoms: ['cough'] })
  })
})
