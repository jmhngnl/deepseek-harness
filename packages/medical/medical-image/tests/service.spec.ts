/**
 * Session-backed service coverage: the attachment authorization boundary, the
 * durable event each mutation appends, the full-snapshot no-op and update
 * semantics, several images in one session, and the separation from the
 * patient-reported case.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import MedicalCaseService from '@deepseek-ai/dsh-medical-case'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import MedicalImageService, { canonicalImageAttachment } from '../src/index.ts'
import type { ImageObservationRequest } from '../src/index.ts'

/**
 * A minimal valid reference. The domain never reads the bytes — it takes the
 * reference from the session's own message — so a fixture with no image behind it
 * exercises every path this domain owns. Provenance (that `attachment-local`
 * minted this shape) is that package's contract, tested there.
 */
function attachment(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${id.repeat(64).slice(0, 64)}`),
    mediaType: 'image/png',
    bytes: 2_048,
    width: 640,
    height: 480,
    name: `${id}.png`,
    ...overrides,
  }
}

const RASH = attachment('a')
const KNEE = attachment('b', { mediaType: 'image/jpeg', bytes: 512, width: 320, height: 240 })

/**
 * One COMPLETE observation request. The contract is a full snapshot, so every
 * field is stated even when a test only cares about one of them.
 */
function observation(
  attachmentId: string,
  overrides: Partial<Omit<ImageObservationRequest, 'attachmentId'>> = {},
): ImageObservationRequest {
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
}

/** Mount the loop, both medical domains, and create one live agent. */
async function setup(id = 'session-a'): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(MedicalImageService)
  const agent = await ctx.agentLoop.create(SessionId(id), {}, {})
  return { ctx, agent }
}

/** Put one user message carrying these images on the session's model-visible surface. */
function attach(agent: Agent, ...refs: readonly ImageAttachmentRef[]): void {
  agent.session.append('user/message', createUserMessage({
    content: refs.map(ref => ({ type: 'image', attachment: ref })),
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Every durable event of one type this session logged, in order. */
function eventsOfType(agent: Agent, type: string): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === type)
}

describe('attachment authorization', () => {
  it('accepts an attachment this session actually carried', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    const result = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch'] }))
    expect(String(result.view.attachment.attachmentId)).toBe(String(RASH.attachmentId))
    expect(result.changed).toBe(true)
  })

  it('refuses an attachment id that was never attached to this session', async () => {
    const { ctx, agent } = await setup()
    expect(() => ctx.medicalImage.observe(agent, observation('sha256:made-up')))
      .toThrow(/no user image with attachment/)
    expect(eventsOfType(agent, 'medical/image-observation')).toEqual([])
  })

  it('refuses an attachment that belongs to a different session, with the same answer', async () => {
    const first = await setup('session-a')
    const second = await setup('session-b')
    attach(first.agent, RASH)
    expect(() => second.ctx.medicalImage.observe(second.agent, observation(String(RASH.attachmentId))))
      .toThrow(/no user image with attachment/)
    // The two refusals are indistinguishable on purpose: telling them apart would
    // report which attachment ids exist in other sessions.
    expect(eventsOfType(second.agent, 'medical/image-observation')).toEqual([])
  })

  it('persists the session\u2019s canonical reference, not metadata supplied by the caller', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    const forged = {
      ...observation(String(RASH.attachmentId)),
      // Every field below is a lie. The request type has no place for them; a
      // caller that sends them anyway cannot change what gets stored.
      mediaType: 'image/gif',
      bytes: 1,
      width: 1,
      height: 1,
      name: 'forged.gif',
    } as ImageObservationRequest
    const result = ctx.medicalImage.observe(agent, forged)
    expect(result.view.attachment).toEqual(RASH)
  })

  it('resolves the first occurrence when the same attachment appears more than once', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    attach(agent, RASH)
    const result = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId)))
    expect(result.view.attachment).toEqual(RASH)
  })

  it('finds an image nested inside a tool result', async () => {
    const { ctx, agent } = await setup()
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'tool-result', toolCallId: 'call-1' as never, content: [{ type: 'image', attachment: KNEE }] } as never],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const result = ctx.medicalImage.observe(agent, observation(String(KNEE.attachmentId)))
    expect(result.view.attachment).toEqual(KNEE)
  })

  it('refuses an agent that is not the registry\u2019s live instance', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    const foreign = { id: agent.id } as unknown as Agent
    expect(() => ctx.medicalImage.observe(foreign, observation(String(RASH.attachmentId))))
      .toThrow(/is not live in this registry/)
  })
})

describe('canonical reference resolution', () => {
  /** One derived message of a given role carrying these content blocks. */
  function message(role: 'user' | 'assistant', content: readonly unknown[]): Message {
    return { id: 'm' as never, role, content, source: { kind: 'user' } } as unknown as Message
  }

  const image = { type: 'image', attachment: RASH }

  it('finds an image on a user message', () => {
    expect(canonicalImageAttachment([message('user', [image])], String(RASH.attachmentId))).toEqual(RASH)
  })

  it('ignores an image that only the model produced', () => {
    // Production adapters declare text-only output, so this shape cannot arrive
    // from a real provider — and if it did, it still would not authorize a read:
    // a model cannot cite an image by writing one into its own reply.
    expect(canonicalImageAttachment([message('assistant', [image])], String(RASH.attachmentId))).toBeUndefined()
  })

  it('walks nested tool-result content', () => {
    const nested = message('user', [{ type: 'tool-result', toolCallId: 'c', content: [image] }])
    expect(canonicalImageAttachment([nested], String(RASH.attachmentId))).toEqual(RASH)
  })

  it('takes the first occurrence when one attachment appears more than once', () => {
    const first = { type: 'image', attachment: { ...RASH, name: 'first.png' } }
    const second = { type: 'image', attachment: { ...RASH, name: 'second.png' } }
    const resolved = canonicalImageAttachment([message('user', [first]), message('user', [second])], String(RASH.attachmentId))
    expect(resolved?.name).toBe('first.png')
  })

  it('returns undefined for an id no message carried', () => {
    expect(canonicalImageAttachment([message('user', [image])], 'sha256:absent')).toBeUndefined()
  })
})

describe('durable events and revisions', () => {
  it('appends exactly one event for a first observation', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch'] }))
    const events = eventsOfType(agent, 'medical/image-observation')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({ kind: 'medical/image-observation', version: 1, operation: 'observe' })
  })

  it('appends nothing when the same full snapshot is recorded again', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    const request = observation(String(RASH.attachmentId), { findings: [' red patch '] })
    const first = ctx.medicalImage.observe(agent, request)
    const second = ctx.medicalImage.observe(agent, request)
    expect(second.changed).toBe(false)
    expect(second.view).toEqual(first.view)
    expect(eventsOfType(agent, 'medical/image-observation')).toHaveLength(1)
  })

  it('advances the revision by one when the snapshot records something different', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    const first = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch'] }))
    const second = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), {
      findings: ['red patch', 'scaling'],
    }))
    expect(first.view.revision).toBe(1)
    expect(second.view.revision).toBe(2)
    expect(second.changed).toBe(true)
    const events = eventsOfType(agent, 'medical/image-observation')
    expect(events.map(event => (event.data as { operation: string }).operation)).toEqual(['observe', 'update'])
  })

  it('drops a finding that the new full snapshot omits, because nothing preserves it', async () => {
    // The point of the snapshot contract: a restatement is the whole observation,
    // so omitting a finding removes it rather than silently keeping it.
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch', 'scaling'] }))
    const second = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch'] }))
    expect(second.view.findings).toEqual(['red patch'])
    expect(second.view.revision).toBe(2)
  })

  it('keeps the creation time and moves only the mutation time on an update', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    const first = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId)))
    const second = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { bodyRegion: 'left forearm' }))
    expect(second.view.createdAt).toBe(first.view.createdAt)
    expect(second.view.updatedAt).toBeGreaterThanOrEqual(first.view.updatedAt)
  })

  it('records an unusable image with no findings and the reason why', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    const result = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), {
      usable: false,
      findings: [],
      qualityIssues: ['blur', 'too_distant'],
    }))
    expect(result.view.findings).toEqual([])
    expect(result.view.quality).toEqual({ usable: false, issues: ['blur', 'too_distant'] })
  })

  it('refuses a blank body region rather than recording it as null', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    expect(() => ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { bodyRegion: '   ' })))
      .toThrow(/bodyRegion must be a non-empty string or an explicit null/)
    expect(eventsOfType(agent, 'medical/image-observation')).toEqual([])
  })
})

describe('reads', () => {
  it('reports nothing before anything is observed', async () => {
    const { ctx, agent } = await setup()
    expect(ctx.medicalImage.list(agent)).toEqual([])
    expect(ctx.medicalImage.get(agent, String(RASH.attachmentId))).toBeUndefined()
  })

  it('fails a required read with a stable code', async () => {
    const { ctx, agent } = await setup()
    expect(() => ctx.medicalImage.require(agent, String(RASH.attachmentId))).toThrow(/no observation for attachment/)
  })

  it('reports a latched replay failure rather than an empty record', async () => {
    const { ctx, agent } = await setup()
    // A durable record the producer contract could not have written.
    agent.session.append('medical/image-observation', {
      kind: 'medical/image-observation',
      version: 1,
      operation: 'observe',
    } as never)

    // Every read reports the durable fault instead of pretending nothing was
    // observed: a store that cannot read its own stream is not an empty store.
    expect(() => ctx.medicalImage.list(agent)).toThrow(/medical image replay failed/)
    expect(() => ctx.medicalImage.get(agent, String(RASH.attachmentId))).toThrow(/medical image replay failed/)
    expect(() => ctx.medicalImage.require(agent, String(RASH.attachmentId))).toThrow(/medical image replay failed/)
  })

  it('reports a latched failure when a durable update rewrote the attachment', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch'] }))
    const committed = eventsOfType(agent, 'medical/image-observation')[0]?.data as {
      observation: Record<string, unknown>
    }
    // The same attachment id, with the stored image's media type rewritten. The
    // timestamps stay valid so the record fails on the identity rule rather than
    // on an ordering rule that would mask it.
    agent.session.append('medical/image-observation', {
      kind: 'medical/image-observation',
      version: 1,
      operation: 'update',
      observation: {
        ...committed.observation,
        revision: 2,
        updatedAt: Number(committed.observation['createdAt']) + 1,
        findings: ['red patch', 'scaling'],
        attachment: { ...(committed.observation['attachment'] as Record<string, unknown>), mediaType: 'image/gif' },
      },
    } as never)

    expect(() => ctx.medicalImage.list(agent))
      .toThrow(/cannot change the canonical attachment reference/)
    expect(() => ctx.medicalImage.require(agent, String(RASH.attachmentId)))
      .toThrow(/IMAGE_STREAM_INVALID|medical image replay failed/)
  })

  it('reads back one attachment without disturbing the others', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH, KNEE)
    ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch'] }))
    ctx.medicalImage.observe(agent, observation(String(KNEE.attachmentId), { bodyRegion: 'right knee' }))
    expect(ctx.medicalImage.list(agent)).toHaveLength(2)
    expect(ctx.medicalImage.require(agent, String(KNEE.attachmentId)).bodyRegion).toBe('right knee')
    expect(ctx.medicalImage.require(agent, String(RASH.attachmentId)).bodyRegion).toBeNull()
  })
})

describe('several images in one session', () => {
  it('persists and reads each attachment independently', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH, KNEE)
    ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), { findings: ['red patch'] }))
    ctx.medicalImage.observe(agent, observation(String(KNEE.attachmentId), { usable: false, qualityIssues: ['occlusion'] }))
    const stored = ctx.medicalImage.list(agent)
    expect(stored.map(entry => String(entry.attachment.attachmentId)))
      .toEqual([String(RASH.attachmentId), String(KNEE.attachmentId)])
    // The second observation did not overwrite the first: a single-slot store
    // would have lost the rash the moment the knee arrived.
    expect(stored[0]?.findings).toEqual(['red patch'])
    expect(stored[1]?.quality).toEqual({ usable: false, issues: ['occlusion'] })
    expect(eventsOfType(agent, 'medical/image-observation')).toHaveLength(2)
  })
})

describe('separation from the patient-reported case', () => {
  it('leaves the case record and the case event stream untouched', async () => {
    const { ctx, agent } = await setup()
    attach(agent, RASH)
    ctx.medicalCase.intake(agent, { symptoms: ['头疼'], duration: '两天', age: 25 })
    const before = ctx.medicalCase.require(agent)
    const caseEventsBefore = eventsOfType(agent, 'medical/case-change').length

    const observed = ctx.medicalImage.observe(agent, observation(String(RASH.attachmentId), {
      findings: ['irregular red patch'],
    }))

    // The observation is durable and authoritative...
    expect(observed.changed).toBe(true)
    expect(ctx.medicalImage.list(agent)).toHaveLength(1)
    // ...and the patient-reported record is byte-for-byte what it was, with no
    // new case event: visible evidence never becomes a reported symptom.
    expect(ctx.medicalCase.require(agent)).toEqual(before)
    expect(eventsOfType(agent, 'medical/case-change')).toHaveLength(caseEventsBefore)
    expect(ctx.medicalCase.require(agent).symptoms).toEqual(['头疼'])
  })
})
