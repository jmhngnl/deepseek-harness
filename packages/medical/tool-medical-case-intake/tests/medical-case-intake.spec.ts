/**
 * Unit coverage for `medical_case_intake`: the model-facing schema projection,
 * the Phase 1 missing-information contract, and the durable record the tool now
 * writes through `ctx.medicalCase`.
 *
 * Every call goes through `ctx.tools.execute` rather than the raw `execute`
 * callback, because `defineTool` installs argument validation inside the
 * registry's dispatch path — calling the body directly would skip it.
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
import * as ToolMedicalCaseIntake from '../src/index.ts'

/** The canonical value this tool returns. */
interface IntakeValue {
  caseId: string
  revision: number
  symptoms: string[]
  duration: string | null
  age: number | null
  additionalNotes: string | null
  createdAt: number
  updatedAt: number
  missingFields: string[]
  changed: boolean
}

/** Narrowed view of the projected parameter root, for structural assertions. */
interface IntakeParameterShape {
  type: string
  required?: string[]
  properties: Record<string, { type: string; items?: { type: string }; description?: string }>
}

const signal = new AbortController().signal
let callNumber = 0

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  execute(args: unknown): Promise<ToolExecutionResult>
}

async function setup(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(ToolMedicalCaseIntake)
  const agent = await ctx.agentLoop.create(SessionId('session-a'), {}, {})
  return {
    ctx,
    agent,
    execute: args => ctx.tools.execute({
      signal,
      callId: ToolCallId(`medical-intake-${++callNumber}`),
      name: 'medical_case_intake',
      arguments: args,
      agent,
    }),
  }
}

/** Dispatch one call and return its canonical record, failing loudly on error. */
async function intake(harness: Harness, args: unknown): Promise<IntakeValue> {
  const result = await harness.execute(args)
  if (result.isError) throw new Error(`medical_case_intake unexpectedly failed: ${JSON.stringify(result.content)}`)
  return result.value as unknown as IntakeValue
}

/** The durable case records one session logged, in order. */
function caseEvents(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'medical/case-change')
}

describe('medical_case_intake registration and schema', () => {
  it('projects exactly the model-facing schema, with no required parameter', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'medical_case_intake')

    expect(schema).toMatchObject({
      name: 'medical_case_intake',
      parameters: {
        type: 'object',
        properties: {
          symptoms: { type: 'array', items: { type: 'string' } },
          duration: { type: 'string' },
          age: { type: 'integer' },
          additionalNotes: { type: 'string' },
        },
      },
    })
    // The description is what keeps the tool inside its non-goals and points
    // follow-ups at the update tool, so its content is asserted, not just shape.
    expect(schema?.description ?? '').toContain('does not diagnose')
    expect(schema?.description ?? '').toContain('medical_case_update')

    const parameters = schema?.parameters as unknown as IntakeParameterShape
    expect(Object.keys(parameters.properties).sort()).toEqual(['additionalNotes', 'age', 'duration', 'symptoms'])
    for (const [key, property] of Object.entries(parameters.properties)) {
      const documented = typeof property.description === 'string' && property.description.length > 0
      expect(documented, `${key} must document itself for the model`).toBe(true)
    }
  })

  it('marks nothing required, so an empty object is a legal call', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'medical_case_intake')
    const parameters = schema?.parameters as unknown as IntakeParameterShape
    expect(parameters.required).toBeUndefined()
  })

  it('feeds the assembled tool set the agent would see', async () => {
    const { ctx } = await setup()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toContain('medical_case_intake')
  })

  it('unregisters with its plugin fiber', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(MedicalCaseService)
    const fiber = ctx.plugin(ToolMedicalCaseIntake)
    await fiber
    expect(ctx.tools.get('medical_case_intake')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('medical_case_intake')).toBeUndefined()
  })
})

describe('medical_case_intake records the case', () => {
  it('treats an empty object as a legal call and reports every required field missing', async () => {
    const harness = await setup()
    const value = await intake(harness, {})
    expect(value).toMatchObject({
      revision: 1,
      symptoms: [],
      duration: null,
      age: null,
      additionalNotes: null,
      missingFields: ['symptoms', 'duration', 'age'],
      changed: true,
    })
    expect(value.caseId.length).toBeGreaterThan(0)
  })

  it('reports nothing missing when every required field is supplied', async () => {
    const harness = await setup()
    expect(await intake(harness, {
      symptoms: ['headache', 'fever'], duration: '2 days', age: 25, additionalNotes: 'after travel',
    })).toMatchObject({
      symptoms: ['headache', 'fever'],
      duration: '2 days',
      age: 25,
      additionalNotes: 'after travel',
      missingFields: [],
    })
  })

  it('never treats a missing additionalNotes as missing information', async () => {
    const harness = await setup()
    const value = await intake(harness, { symptoms: ['cough'], duration: '1 day', age: 40 })
    expect(value.additionalNotes).toBeNull()
    expect(value.missingFields).toEqual([])
  })

  it('counts an empty symptoms array as missing', async () => {
    const harness = await setup()
    expect((await intake(harness, { symptoms: [], duration: '2 days', age: 25 })).missingFields).toEqual(['symptoms'])
  })

  it('counts a blank or whitespace-only duration as missing and normalizes it to null', async () => {
    // A blank is tolerated only while there is nothing to lose. Each blank is
    // therefore its own first-contact call, which is the Phase 1 contract.
    for (const duration of ['', '   ', '\t\n']) {
      const harness = await setup()
      const value = await intake(harness, { symptoms: ['fever'], duration, age: 25 })
      expect(value.duration).toBeNull()
      expect(value.missingFields).toEqual(['duration'])
    }
  })

  it('trims surrounding whitespace from supplied text', async () => {
    const harness = await setup()
    const value = await intake(harness, {
      symptoms: ['fever'], duration: '  2 days  ', age: 25, additionalNotes: '  worse at night  ',
    })
    expect(value.duration).toBe('2 days')
    expect(value.additionalNotes).toBe('worse at night')
  })

  it('preserves symptom order and wording', async () => {
    const harness = await setup()
    expect((await intake(harness, { symptoms: ['fever', 'headache'] })).symptoms).toEqual(['fever', 'headache'])
  })

  it('accepts age 0 for an infant under one year', async () => {
    const harness = await setup()
    expect(await intake(harness, { symptoms: ['jaundice'], duration: '3 days', age: 0 }))
      .toMatchObject({ symptoms: ['jaundice'], duration: '3 days', age: 0, missingFields: [] })
  })

  it('restates the same case instead of creating a second one', async () => {
    const harness = await setup()
    const first = await intake(harness, { symptoms: ['headache', 'fever'] })
    const second = await intake(harness, { duration: '2 days', age: 25 })

    expect(second.caseId).toBe(first.caseId)
    expect(second.revision).toBe(2)
    expect(second.symptoms).toEqual(['headache', 'fever'])
    expect(second.missingFields).toEqual([])
    expect(caseEvents(harness.agent)).toHaveLength(2)
  })

  it('reports an unchanged restatement without spending a revision', async () => {
    const harness = await setup()
    await intake(harness, { symptoms: ['headache'], duration: '2 days', age: 25 })
    const again = await intake(harness, { symptoms: ['headache'], duration: '2 days', age: 25 })

    expect(again.changed).toBe(false)
    expect(again.revision).toBe(1)
    expect(caseEvents(harness.agent)).toHaveLength(1)
  })
})

describe('medical_case_intake rejects invalid input', () => {
  it('rejects a wrong parameter type at the schema boundary', async () => {
    const harness = await setup()
    // Requirement B: this is an invalid call, not a case with missing data.
    expect((await harness.execute({ symptoms: 'headache' })).isError).toBe(true)
  })

  it('rejects a non-integer age', async () => {
    const harness = await setup()
    expect((await harness.execute({ age: 1.5 })).isError).toBe(true)
  })

  it('rejects an age outside the accepted range', async () => {
    const harness = await setup()
    for (const age of [-1, 131]) {
      expect((await harness.execute({ age })).isError).toBe(true)
    }
  })

  it('accepts both range endpoints', async () => {
    const harness = await setup()
    expect((await harness.execute({ age: 0 })).isError).toBe(false)
    expect((await harness.execute({ age: 130 })).isError).toBe(false)
  })

  it('reports the failure to the model without leaking a stack trace', async () => {
    const harness = await setup()
    const result = await harness.execute({ age: -1 })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('age must be a whole number between 0 and 130')
  })

  it('refuses to run without a calling agent session', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-intake-no-agent'),
      name: 'medical_case_intake',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires a calling agent session')
  })
})
