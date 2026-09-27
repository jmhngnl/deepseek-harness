/**
 * Unit coverage for `medical_image_get`: the read-only contract, the
 * attachment-addressed read, and the list that keeps several images apart.
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
import type { ImageObservationRequest } from '@deepseek-ai/dsh-medical-image'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolMedicalImageGet from '../src/index.ts'

const signal = new AbortController().signal
let callNumber = 0

/** Minimal valid references; the domain reads the session's own copies. */
const RASH: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 2_048,
  width: 640,
  height: 480,
  name: 'rash.png',
}
const KNEE: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
  mediaType: 'image/jpeg',
  bytes: 512,
  width: 320,
  height: 240,
}

/** One COMPLETE observation request; the contract is a full snapshot, not a patch. */
function observation(attachmentId: string, overrides: Partial<ImageObservationRequest> = {}): ImageObservationRequest {
  return {
    attachmentId,
    bodyRegion: null,
    findings: [],
    usable: true,
    qualityIssues: [],
    uncertainty: [],
    ...overrides,
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  execute(arguments_?: Record<string, unknown>): Promise<ToolExecutionResult>
}

async function setup(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalImageService)
  await ctx.plugin(ToolMedicalImageGet)
  const agent = await ctx.agentLoop.create(SessionId('session-a'), {}, {})
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'image', attachment: RASH }, { type: 'image', attachment: KNEE }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return {
    ctx,
    agent,
    execute: arguments_ => ctx.tools.execute({
      signal,
      callId: ToolCallId(`medical-image-get-${++callNumber}`),
      name: 'medical_image_get',
      arguments: arguments_ ?? {},
      agent,
    }),
  }
}

/** The durable image events one session logged, in order. */
function imageEvents(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'medical/image-observation')
}

describe('medical_image_get registration and schema', () => {
  it('offers the read-only contract with an optional attachment id', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'medical_image_get')
    expect(schema).toMatchObject({ name: 'medical_image_get' })
    const description = schema?.description ?? ''
    expect(description).toContain('without changing them')
    expect(description).toContain('does not diagnose')
    expect(description).toContain('never patient-reported facts')
    const required = (schema?.parameters as { required?: readonly string[] } | undefined)?.required ?? []
    expect(required).toEqual([])
  })

  it('unregisters with its plugin fiber', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(MedicalImageService)
    const fiber = ctx.plugin(ToolMedicalImageGet)
    await fiber
    expect(ctx.tools.get('medical_image_get')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('medical_image_get')).toBeUndefined()
  })
})

describe('medical_image_get reads the authoritative observations', () => {
  it('reports nothing before anything was observed', async () => {
    const harness = await setup()
    const result = await harness.execute()

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ observations: [] })
    expect(JSON.stringify(result.content)).toContain('No image observations recorded')
  })

  it('reads one attachment by id', async () => {
    const harness = await setup()
    harness.ctx.medicalImage.observe(harness.agent, observation(String(RASH.attachmentId), {
      bodyRegion: 'left forearm',
      findings: ['irregular red patch'],
      qualityIssues: ['blur'],
      uncertainty: ['depth cannot be judged from one view'],
    }))
    const result = await harness.execute({ attachmentId: String(RASH.attachmentId) })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      observations: [{
        attachmentId: String(RASH.attachmentId),
        revision: 1,
        bodyRegion: 'left forearm',
        findings: ['irregular red patch'],
        usable: true,
        qualityIssues: ['blur'],
        uncertainty: ['depth cannot be judged from one view'],
      }],
    })
    const rendered = JSON.stringify(result.content)
    expect(rendered).toContain('Recorded image observations.')
    expect(rendered).toContain('irregular red patch')
    expect(rendered).toContain('depth cannot be judged from one view')
  })

  it('lists every image, keeping the second from hiding the first', async () => {
    const harness = await setup()
    harness.ctx.medicalImage.observe(harness.agent, observation(String(RASH.attachmentId), {
      findings: ['red patch'],
    }))
    harness.ctx.medicalImage.observe(harness.agent, observation(String(KNEE.attachmentId), {
      usable: false,
      qualityIssues: ['occlusion'],
    }))
    const result = await harness.execute()

    expect(result.value).toMatchObject({
      observations: [
        { attachmentId: String(RASH.attachmentId), findings: ['red patch'], usable: true },
        { attachmentId: String(KNEE.attachmentId), findings: [], usable: false, qualityIssues: ['occlusion'] },
      ],
    })
  })

  it('reflects a later revision rather than the state at first write', async () => {
    const harness = await setup()
    harness.ctx.medicalImage.observe(harness.agent, observation(String(RASH.attachmentId)))
    harness.ctx.medicalImage.observe(harness.agent, observation(String(RASH.attachmentId), {
      findings: ['scaling'],
    }))
    expect((await harness.execute({ attachmentId: String(RASH.attachmentId) })).value)
      .toMatchObject({ observations: [{ revision: 2, findings: ['scaling'] }] })
  })

  it('changes nothing: no event and no revision', async () => {
    const harness = await setup()
    harness.ctx.medicalImage.observe(harness.agent, observation(String(RASH.attachmentId)))
    const before = imageEvents(harness.agent).length
    await harness.execute()
    await harness.execute({ attachmentId: String(RASH.attachmentId) })

    expect(imageEvents(harness.agent)).toHaveLength(before)
    expect(harness.ctx.medicalImage.require(harness.agent, String(RASH.attachmentId)).revision).toBe(1)
  })

  it('fails clearly when the named attachment has no observation', async () => {
    const harness = await setup()
    const result = await harness.execute({ attachmentId: String(KNEE.attachmentId) })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no observation for attachment')
  })

  it('refuses to run without a calling agent session', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-image-get-no-agent'),
      name: 'medical_image_get',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires a calling agent session')
  })
})

describe('medical_image_get respects session isolation', () => {
  it('reads only its own session', async () => {
    const harness = await setup()
    const other = await harness.ctx.agentLoop.create(SessionId('session-b'), {}, {})
    harness.ctx.medicalImage.observe(harness.agent, observation(String(RASH.attachmentId), {
      findings: ['red patch'],
    }))

    expect((await harness.execute()).value).toMatchObject({ observations: [{ findings: ['red patch'] }] })
    const otherResult = await harness.ctx.tools.execute({
      signal,
      callId: ToolCallId('medical-image-get-other-session'),
      name: 'medical_image_get',
      arguments: {},
      agent: other,
    })
    expect(otherResult.value).toEqual({ observations: [] })
  })
})
