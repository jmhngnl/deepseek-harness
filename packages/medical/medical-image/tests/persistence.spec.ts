/**
 * Cold-start durability coverage: a real JSONL log, written by a live session,
 * closed, and read back by a second context.
 *
 * This is the regression test for a harness refusing its own event. The
 * persistence read path validates every stored event type against the generated
 * `KNOWN_SESSION_EVENT_TYPES` and refuses the whole log for a type it does not
 * know — the fail-closed rule that stops a newer harness's log from being
 * silently reconstructed wrong. A domain event that exists in `SessionEventMap`
 * but never reached that generated set therefore makes a session this build wrote
 * unreadable by this build, which is exactly what happened to
 * `medical/image-observation`.
 *
 * The write half goes through the production writer, not a hand-seeded log, so
 * what is replayed is what a real conversation produced. The read half opens the
 * log through the same `sessionPersistence.open` call the Web history path makes,
 * then replays the domain's own projection over the events it returns.
 */

import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import MedicalImageService, { medicalImageProjectionDefinition } from '../src/index.ts'
import type { ImageObservationRequest, MedicalImageProjectionState } from '../src/index.ts'

const PERSISTENCE_TEST_TIMEOUT_MS = 20_000
const SESSION = SessionId('medical-image-cold-start')

const contexts = new Set<Context>()
const roots: string[] = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
    contexts.delete(ctx)
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'cold-start persistence cleanup failed')
})

/** The canonical reference this session will carry. */
const ATTACHMENT: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 2_048,
  width: 640,
  height: 480,
  name: 'image-1.png',
}

/** One COMPLETE observation request; the contract is a full snapshot. */
function observation(overrides: Partial<Omit<ImageObservationRequest, 'attachmentId'>> = {}): ImageObservationRequest {
  return {
    attachmentId: String(ATTACHMENT.attachmentId),
    bodyRegion: 'forearm',
    findings: ['red patch', 'raised border'],
    usable: true,
    qualityIssues: ['blur'],
    uncertainty: ['depth cannot be judged from a single view'],
    ...overrides,
  }
}

/** A context with the loop, the image domain, and a real JSONL log under one root. */
async function stack(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalImageService)
  return ctx
}

/** Put one user message carrying this image on the session's model-visible surface. */
function attach(agent: Agent, ref: ImageAttachmentRef): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'image', attachment: ref }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/**
 * Read one stored session's complete log through a read handle.
 *
 * This is the call that refused the log: `open` runs the storage contract, which
 * validates every event type against `KNOWN_SESSION_EVENT_TYPES`.
 */
async function readStored(ctx: Context): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(SESSION, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

/** Replay the image projection over one stored log, as a cold registry would. */
function replay(events: readonly SessionEvent[]): MedicalImageProjectionState {
  let state = medicalImageProjectionDefinition.init()
  for (const event of events) state = medicalImageProjectionDefinition.apply(state, event)
  if (state.failure !== null) throw new Error(state.failure)
  return state
}

describe('the event vocabulary this build understands', () => {
  it('knows every medical domain event the repository declares', () => {
    // The generated set is what the read path consults. A domain event missing
    // from it makes a session this build wrote unreadable by this build.
    expect(KNOWN_SESSION_EVENT_TYPES.has('medical/case-change')).toBe(true)
    expect(KNOWN_SESSION_EVENT_TYPES.has('medical/image-observation')).toBe(true)
  })
})

describe('a stored image observation across a cold start', () => {
  it('is read back and replayed with its attachment, revision, findings, and uncertainty intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-medical-image-cold-'))
    roots.push(root)

    // ── Write: a live session appends the observation through the production writer.
    const writing = await stack(root)
    const agent = await writing.agentLoop.create(SESSION, {}, {})
    attach(agent, ATTACHMENT)
    const observed = writing.medicalImage.observe(agent, observation())
    expect(observed.changed).toBe(true)
    expect(observed.view.revision).toBe(1)
    const liveEvents = agent.session.snapshotEvents().map(event => event.type)
    expect(liveEvents).toContain('medical/image-observation')
    await writing.fiber.dispose()
    contexts.delete(writing)

    // ── Cold start: a second context, nothing in memory, reads the same log.
    const reading = await stack(root)
    const stored = await readStored(reading)

    // The refusal this test exists for: an unknown type without `ignorable`.
    expect(stored.map(event => event.type)).toContain('medical/image-observation')

    const state = replay(stored)
    expect(state.failure).toBeNull()
    expect(state.observations).toHaveLength(1)
    const [observationBack] = state.observations
    expect(String(observationBack?.attachment.attachmentId)).toBe(String(ATTACHMENT.attachmentId))
    expect(observationBack?.attachment.mediaType).toBe(ATTACHMENT.mediaType)
    expect(observationBack?.attachment.name).toBe(ATTACHMENT.name)
    expect(observationBack?.revision).toBe(1)
    expect(observationBack?.bodyRegion).toBe('forearm')
    expect(observationBack?.findings).toEqual(['red patch', 'raised border'])
    expect(observationBack?.quality).toEqual({ usable: true, issues: ['blur'] })
    expect(observationBack?.uncertainty).toEqual(['depth cannot be judged from a single view'])
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('replays the whole history when a second observation advanced the revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-medical-image-cold-update-'))
    roots.push(root)

    const writing = await stack(root)
    const agent = await writing.agentLoop.create(SESSION, {}, {})
    attach(agent, ATTACHMENT)
    writing.medicalImage.observe(agent, observation())
    const updated = writing.medicalImage.observe(agent, observation({
      findings: ['red patch', 'raised border', 'scaling at the border'],
      uncertainty: [],
    }))
    expect(updated.view.revision).toBe(2)
    await writing.fiber.dispose()
    contexts.delete(writing)

    const reading = await stack(root)
    const state = replay(await readStored(reading))

    // Cold replay folds the whole durable stream, so the latest record alone is
    // enough: the observation carries the complete post-mutation value.
    expect(state.observations).toHaveLength(1)
    expect(state.observations[0]?.revision).toBe(2)
    expect(state.observations[0]?.findings).toEqual(['red patch', 'raised border', 'scaling at the border'])
    expect(state.observations[0]?.uncertainty).toEqual([])
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('serves the replayed observation to the image service on a resumed agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-medical-image-cold-resume-'))
    roots.push(root)

    const writing = await stack(root)
    const agent = await writing.agentLoop.create(SESSION, {}, {})
    attach(agent, ATTACHMENT)
    writing.medicalImage.observe(agent, observation())
    await writing.fiber.dispose()
    contexts.delete(writing)

    const reading = await stack(root)
    const resumed = await reading.agents.resume({ resumeSessionId: SESSION })
    try {
      // The projection registry folds the stored log on resume, so this is the
      // cold replay a Web history read performs — and the read the service makes
      // afterwards is what a reopened conversation answers with.
      const [restored] = reading.medicalImage.list(resumed.agent)
      expect(restored).toBeDefined()
      expect(String(restored?.attachment.attachmentId)).toBe(String(ATTACHMENT.attachmentId))
      expect(restored?.attachment.name).toBe(ATTACHMENT.name)
      expect(restored?.revision).toBe(1)
      expect(restored?.bodyRegion).toBe('forearm')
      expect(restored?.findings).toEqual(['red patch', 'raised border'])
      expect(restored?.quality).toEqual({ usable: true, issues: ['blur'] })
      expect(restored?.uncertainty).toEqual(['depth cannot be judged from a single view'])
    } finally {
      await resumed.dispose()
    }
  }, PERSISTENCE_TEST_TIMEOUT_MS)
})
