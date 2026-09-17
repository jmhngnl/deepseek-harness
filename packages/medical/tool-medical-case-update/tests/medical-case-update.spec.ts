/**
 * Unit coverage for `medical_case_update`: the incremental patch contract it
 * exposes to the model, the ambiguity it refuses, and the revision it spends.
 *
 * The case is seeded through the domain service so these cases pin the *tool*
 * contract; the domain's own merge rules are covered in `dsh-medical-case`.
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
import * as ToolMedicalCaseUpdate from '../src/index.ts'

/** The canonical value this tool returns. */
interface UpdateValue {
  caseId: string
  revision: number
  symptoms: string[]
  duration: string | null
  age: number | null
  additionalNotes: string | null
  missingFields: string[]
  changed: boolean
}

/** Narrowed view of the projected parameter root, for structural assertions. */
interface UpdateParameterShape {
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
  await ctx.plugin(ToolMedicalCaseUpdate)
  const agent = await ctx.agentLoop.create(SessionId('session-a'), {}, {})
  return {
    ctx,
    agent,
    execute: args => ctx.tools.execute({
      signal,
      callId: ToolCallId(`medical-update-${++callNumber}`),
      name: 'medical_case_update',
      arguments: args,
      agent,
    }),
  }
}

/** Seed a complete case, then return the harness ready for patching. */
async function withCase(): Promise<Harness> {
  const harness = await setup()
  harness.ctx.medicalCase.create(harness.agent, { symptoms: ['headache', 'fever'], duration: '2 days', age: 25 })
  return harness
}

/** Dispatch one call and return its canonical record, failing loudly on error. */
async function update(harness: Harness, args: unknown): Promise<UpdateValue> {
  const result = await harness.execute(args)
  if (result.isError) throw new Error(`medical_case_update unexpectedly failed: ${JSON.stringify(result.content)}`)
  return result.value as unknown as UpdateValue
}

/** The durable case records one session logged, in order. */
function caseEvents(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'medical/case-change')
}

describe('medical_case_update registration and schema', () => {
  it('projects the incremental contract, with no required parameter', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'medical_case_update')

    expect(schema).toMatchObject({
      name: 'medical_case_update',
      parameters: {
        type: 'object',
        properties: {
          symptoms: { type: 'array', items: { type: 'string' } },
          symptomsAdd: { type: 'array', items: { type: 'string' } },
          symptomsRemove: { type: 'array', items: { type: 'string' } },
          duration: { type: 'string' },
          age: { type: 'integer' },
          additionalNotes: { type: 'string' },
        },
      },
    })
    expect(schema?.description ?? '').toContain('does not diagnose')

    const parameters = schema?.parameters as unknown as UpdateParameterShape
    expect(Object.keys(parameters.properties).sort())
      .toEqual(['additionalNotes', 'age', 'duration', 'symptoms', 'symptomsAdd', 'symptomsRemove'])
    expect(parameters.required).toBeUndefined()
    for (const [key, property] of Object.entries(parameters.properties)) {
      const documented = typeof property.description === 'string' && property.description.length > 0
      expect(documented, `${key} must document itself for the model`).toBe(true)
    }
  })

  it('unregisters with its plugin fiber', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(MedicalCaseService)
    const fiber = ctx.plugin(ToolMedicalCaseUpdate)
    await fiber
    expect(ctx.tools.get('medical_case_update')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('medical_case_update')).toBeUndefined()
  })
})

describe('medical_case_update changes only what it is given', () => {
  it('appends a symptom without losing the recorded ones', async () => {
    const harness = await withCase()
    expect(await update(harness, { symptomsAdd: ['nausea'] })).toMatchObject({
      revision: 2,
      symptoms: ['headache', 'fever', 'nausea'],
      duration: '2 days',
      age: 25,
      changed: true,
    })
  })

  it('drops a recorded symptom and keeps the rest', async () => {
    const harness = await withCase()
    expect((await update(harness, { symptomsRemove: ['fever'] })).symptoms).toEqual(['headache'])
  })

  it('replaces the whole list only when the model restates it', async () => {
    const harness = await withCase()
    expect((await update(harness, { symptoms: ['cough'] })).symptoms).toEqual(['cough'])
  })

  it('fills the facts that were still missing, then reports none missing', async () => {
    const harness = await setup()
    harness.ctx.medicalCase.intake(harness.agent, { symptoms: ['headache'] })
    const value = await update(harness, { duration: '2 days', age: 25 })
    expect(value.missingFields).toEqual([])
  })

  it('trims, drops blanks, and deduplicates added symptoms', async () => {
    const harness = await withCase()
    const value = await update(harness, { symptomsAdd: ['  nausea ', '', 'nausea', 'headache'] })
    expect(value.symptoms).toEqual(['headache', 'fever', 'nausea'])
  })

  it('ignores a removal of a symptom that was never recorded', async () => {
    const harness = await withCase()
    const value = await update(harness, { symptomsRemove: ['nausea'] })
    expect(value.changed).toBe(false)
    expect(value.symptoms).toEqual(['headache', 'fever'])
  })

  it('replaces the age and normalizes the recorded text', async () => {
    const harness = await withCase()
    expect(await update(harness, { age: 26, duration: '  3 days  ' }))
      .toMatchObject({ age: 26, duration: '3 days' })
  })
})

describe('medical_case_update refuses ambiguity', () => {
  it('rejects a replace combined with the deltas', async () => {
    const harness = await withCase()
    expect((await harness.execute({ symptoms: ['cough'], symptomsAdd: ['nausea'] })).isError).toBe(true)
    expect((await harness.execute({ symptoms: ['cough'], symptomsRemove: ['fever'] })).isError).toBe(true)
  })

  it('rejects a symptom that is both added and removed', async () => {
    const harness = await withCase()
    const result = await harness.execute({ symptomsAdd: ['nausea'], symptomsRemove: [' nausea '] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('nausea')
  })

  it('rejects an empty replacement list rather than clearing the case', async () => {
    const harness = await withCase()
    expect((await harness.execute({ symptoms: [] })).isError).toBe(true)
    expect(caseEvents(harness.agent)).toHaveLength(1)
  })

  it('rejects a blank string rather than clearing a recorded fact', async () => {
    const harness = await withCase()
    expect((await harness.execute({ duration: '   ' })).isError).toBe(true)
    expect((await harness.execute({ additionalNotes: '' })).isError).toBe(true)
    expect((await harness.execute({ symptomsAdd: [''] })).isError).toBe(false)
  })

  it('rejects an age that is not a whole number of years in range', async () => {
    const harness = await withCase()
    for (const age of [-1, 1.5, 131]) {
      expect((await harness.execute({ age })).isError).toBe(true)
    }
  })

  it('reports the failure to the model without leaking a stack trace', async () => {
    const harness = await withCase()
    const result = await harness.execute({ age: 131 })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('age must be a whole number between 0 and 130')
  })

  it('refuses to patch a session with no case', async () => {
    const harness = await setup()
    const result = await harness.execute({ age: 25 })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no recorded medical case')
  })

  it('refuses to run without a calling agent session', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-update-no-agent'),
      name: 'medical_case_update',
      arguments: { age: 25 },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires a calling agent session')
  })
})

describe('medical_case_update revision semantics', () => {
  it('reports no change and spends no revision for a patch that matches the record', async () => {
    const harness = await withCase()
    const value = await update(harness, { duration: '2 days', symptomsRemove: ['nausea'] })
    expect(value.changed).toBe(false)
    expect(value.revision).toBe(1)
    expect(caseEvents(harness.agent)).toHaveLength(1)
  })

  it('writes one full-state record per accepted change', async () => {
    const harness = await withCase()
    await update(harness, { symptomsAdd: ['nausea'] })
    await update(harness, { age: 26 })

    const events = caseEvents(harness.agent)
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({
      data: {
        operation: 'update',
        case: { revision: 3, symptoms: ['headache', 'fever', 'nausea'], duration: '2 days', age: 26 },
      },
    })
  })
})
