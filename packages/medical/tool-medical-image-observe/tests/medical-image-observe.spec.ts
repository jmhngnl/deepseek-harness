/**
 * Unit coverage for `medical_image_observe`: the schema it publishes, the full
 * path from a tool call through the service, the session event, and the
 * projection back to the tool result, and the refusals it must surface.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import MedicalImageService from '@deepseek-ai/dsh-medical-image'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolMedicalImageObserve from '../src/index.ts'

const signal = new AbortController().signal
let callNumber = 0

/** A minimal valid reference; the domain reads the session's own copy, not the bytes. */
const RASH: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 2_048,
  width: 640,
  height: 480,
  name: 'rash.png',
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  execute(arguments_: Record<string, unknown>): Promise<ToolExecutionResult>
}

async function setup(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalImageService)
  await ctx.plugin(ToolMedicalImageObserve)
  const agent = await ctx.agentLoop.create(SessionId('session-a'), {}, {})
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'image', attachment: RASH }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return {
    ctx,
    agent,
    execute: arguments_ => ctx.tools.execute({
      signal,
      callId: ToolCallId(`medical-image-observe-${++callNumber}`),
      name: 'medical_image_observe',
      arguments: arguments_,
      agent,
    }),
  }
}

/** The durable image events one session logged, in order. */
function imageEvents(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'medical/image-observation')
}

describe('medical_image_observe registration and schema', () => {
  it('publishes the observation contract and the visible-evidence boundary', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'medical_image_observe')
    expect(schema).toMatchObject({ name: 'medical_image_observe' })
    const description = schema?.description ?? ''
    expect(description).toContain('DIRECTLY SEE')
    expect(description).toContain('Do NOT state a diagnosis')
    expect(description).toContain('Do NOT restate these findings as patient-reported symptoms')
    expect(description).toContain('usable to false')
    // No parameter NAMES a clinical conclusion. The words appear in the
    // descriptions only inside prohibitions, which is the point of the tool.
    const parameters = (schema?.parameters ?? {}) as { properties?: Record<string, unknown> }
    const names = Object.keys(parameters.properties ?? {})
    expect(names.sort()).toEqual(['attachmentId', 'bodyRegion', 'findings', 'qualityIssues', 'uncertainty', 'usable'])
    for (const banned of ['diagnosis', 'disease', 'condition', 'treatment', 'medication', 'risk', 'urgency', 'triage', 'confidence']) {
      expect(names, `no parameter may be named ${banned}`).not.toContain(banned)
    }
  })

  it('requires the attachment id and the usability verdict', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'medical_image_observe')
    const required = (schema?.parameters as { required?: readonly string[] } | undefined)?.required ?? []
    expect([...required].sort()).toEqual(['attachmentId', 'usable'])
  })

  it('unregisters with its plugin fiber', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(MedicalImageService)
    const fiber = ctx.plugin(ToolMedicalImageObserve)
    await fiber
    expect(ctx.tools.get('medical_image_observe')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('medical_image_observe')).toBeUndefined()
  })
})

describe('medical_image_observe records what the model saw', () => {
  it('writes one event, returns the authoritative observation, and renders it', async () => {
    const harness = await setup()
    const result = await harness.execute({
      attachmentId: String(RASH.attachmentId),
      bodyRegion: 'left forearm',
      findings: ['irregular red patch', 'raised border'],
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth cannot be judged from one view'],
    })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      attachmentId: String(RASH.attachmentId),
      revision: 1,
      bodyRegion: 'left forearm',
      findings: ['irregular red patch', 'raised border'],
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth cannot be judged from one view'],
      changed: true,
    })
    expect(JSON.stringify(result.content)).toContain('Recorded image observation.')
    expect(JSON.stringify(result.content)).toContain('irregular red patch')
    // The tool call reached the session log through the service, not around it.
    expect(imageEvents(harness.agent)).toHaveLength(1)
  })

  it('is a no-op when the same observation is submitted twice', async () => {
    const harness = await setup()
    const arguments_ = { attachmentId: String(RASH.attachmentId), findings: ['red patch'], usable: true }
    await harness.execute(arguments_)
    const second = await harness.execute(arguments_)

    expect(second.value).toMatchObject({ revision: 1, changed: false })
    expect(imageEvents(harness.agent)).toHaveLength(1)
  })

  it('advances the revision when a recorded field changes', async () => {
    const harness = await setup()
    await harness.execute({ attachmentId: String(RASH.attachmentId), findings: ['red patch'], usable: true })
    const second = await harness.execute({
      attachmentId: String(RASH.attachmentId),
      findings: ['red patch', 'scaling'],
      usable: true,
    })

    expect(second.value).toMatchObject({ revision: 2, changed: true })
    expect(imageEvents(harness.agent)).toHaveLength(2)
  })

  it('records an unusable image with the reason and no findings', async () => {
    const harness = await setup()
    const result = await harness.execute({
      attachmentId: String(RASH.attachmentId),
      usable: false,
      qualityIssues: ['blur', 'too_distant'],
    })

    expect(result.value).toMatchObject({ usable: false, findings: [], qualityIssues: ['blur', 'too_distant'] })
  })

  it('reads the record back through the projection, not from the tool result', async () => {
    const harness = await setup()
    await harness.execute({ attachmentId: String(RASH.attachmentId), bodyRegion: 'left forearm', usable: true })
    expect(harness.ctx.medicalImage.require(harness.agent, String(RASH.attachmentId)).bodyRegion).toBe('left forearm')
  })
})

describe('medical_image_observe refusals', () => {
  it('refuses an attachment id this session never carried', async () => {
    const harness = await setup()
    const result = await harness.execute({ attachmentId: 'sha256:made-up', usable: true })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no user image with attachment')
    expect(imageEvents(harness.agent)).toEqual([])
  })

  it('refuses an attachment belonging to another session', async () => {
    const harness = await setup()
    const other = await harness.ctx.agentLoop.create(SessionId('session-b'), {}, {})
    const result = await harness.ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-image-observe-other-session'),
      name: 'medical_image_observe',
      arguments: { attachmentId: String(RASH.attachmentId), usable: true },
      agent: other,
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no user image with attachment')
  })

  it('refuses a quality issue the schema does not admit', async () => {
    const harness = await setup()
    const result = await harness.execute({
      attachmentId: String(RASH.attachmentId),
      usable: true,
      qualityIssues: ['looks_infected'],
    })

    // The published schema is the first gate; the domain validates the same
    // union again on its own, so a caller that bypasses the tool cannot slip a
    // limitation past it either.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('qualityIssues[0]')
    expect(imageEvents(harness.agent)).toEqual([])
  })

  it('refuses to run without a calling agent session', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-image-observe-no-agent'),
      name: 'medical_image_observe',
      arguments: { attachmentId: String(RASH.attachmentId), usable: true },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires a calling agent session')
  })
})
