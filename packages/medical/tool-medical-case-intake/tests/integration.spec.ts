/**
 * Full-loop integration: a scripted mock model drives the REAL
 * `medical_case_intake` tool through the agent loop, exercising the same paths
 * a live model would — the assembled tool schema the agent is given, the
 * `tool/call` + `tool/result` session events, and the result coming back to the
 * model on the next request. Only the model is mocked; the tool, the registry,
 * and the session log are real.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type GenerateOptions, type ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { MedicalCaseService } from '@deepseek-ai/dsh-medical-case'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as ToolMedicalCaseIntake from '../src/index.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(ToolMedicalCaseIntake)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

/** Every tool-result text the model was given in one request. */
function toolResultTexts(request: GenerateOptions | undefined): string[] {
  if (request === undefined) throw new Error('the model made no request')
  return request.messages.flatMap(message => message.content
    .filter((block): block is ToolResultBlock => block.type === 'tool-result')
    .flatMap(block => block.content.flatMap(nested => nested.type === 'text' ? [nested.text] : [])))
}

/** Drive one turn whose first model step calls medical_case_intake with `args`. */
async function runIntake(args: object): Promise<{ log: readonly SessionEvent[]; requests: GenerateOptions[] }> {
  const adapter = new MockAdapter([
    toolCallResponse('call-1', 'medical_case_intake', args, 'Collecting intake.'),
    textResponse('Recorded.'),
  ])
  const ctx = await harness(adapter)
  const agent = await ctx.agentLoop.create(SessionId('it-medical-intake'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'I have had a headache and a fever for 2 days.' }],
    source: { kind: 'user' },
  }))
  await waitForIdle(ctx, agent)
  return { log: agent.session.snapshotEvents(), requests: adapter.requests }
}

describe('medical_case_intake through the agent loop', () => {
  it('gives the agent the tool schema on its request', async () => {
    const { log } = await runIntake({ symptoms: ['headache', 'fever'], duration: '2 days', age: 25 })
    const header = findEvent(log, 'request/header')
    expect(header.data.header.tools?.map(tool => tool.name)).toContain('medical_case_intake')
  })

  it('records a tool/call and a non-error tool/result for a real call', async () => {
    const { log } = await runIntake({ symptoms: ['headache', 'fever'], duration: '2 days', age: 25 })
    const call = findEvent(log, 'tool/call')
    expect(call.data.name).toBe('medical_case_intake')
    // The durable event keeps the model's raw argument JSON, unparsed.
    expect(JSON.parse(call.data.arguments)).toEqual({ symptoms: ['headache', 'fever'], duration: '2 days', age: 25 })
    expect(findEvent(log, 'tool/result').data.message.content[0]?.isError).toBe(false)
  })

  it('returns the tool result to the model on the next request', async () => {
    const { requests } = await runIntake({ symptoms: ['headache', 'fever'], duration: '2 days', age: 25 })
    expect(requests).toHaveLength(2)
    expect(toolResultTexts(requests[1])).toHaveLength(1)
    expect(toolResultTexts(requests[1])[0]).toContain('missingFields: (none)')
  })

  it('treats an empty-argument call as a legal intake that reports what is missing', async () => {
    const { log, requests } = await runIntake({})
    expect(findEvent(log, 'tool/result').data.message.content[0]?.isError).toBe(false)
    const text = toolResultTexts(requests[1])[0] ?? ''
    expect(text).toContain('symptoms: (none provided)')
    expect(text).toContain('duration: (none provided)')
    expect(text).toContain('age: (none provided)')
    expect(text).toContain('missingFields: symptoms, duration, age')
  })

  it('fails the call, not the turn, when the model sends an invalid parameter type', async () => {
    const { log, requests } = await runIntake({ symptoms: 'headache' })
    expect(findEvent(log, 'tool/result').data.message.content[0]?.isError).toBe(true)
    // The turn still completes: the model gets an error result and answers.
    expect(findEvent(log, 'turn/end').data.reason).toBeDefined()
    expect(requests).toHaveLength(2)
    expect(toolResultTexts(requests[1])[0]).toContain('Error:')
  })
})
