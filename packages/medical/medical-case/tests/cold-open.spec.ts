/**
 * Cold-open coverage: a browser opening an existing intake gets its state back
 * WITHOUT sending a new message.
 *
 * The product claim is that a person can close the tab, come back tomorrow, and
 * still see what they told us and what the images showed. That claim rests on
 * the host folding the stored log when a client opens a session — not on a new
 * turn, not on a live agent, and not on anything the browser computes.
 *
 * This case exercises exactly that seam: a case is written by the production
 * writer into a real JSONL log, the whole context is disposed, and a second
 * context observes the same session through the query engine the Web history
 * path uses. What the observation carries is what the browser is seeded with.
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
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import MedicalCaseService from '../src/index.ts'

const PERSISTENCE_TEST_TIMEOUT_MS = 20_000
const SESSION = SessionId('medical-case-cold-open')

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
  if (failures.length > 0) throw new AggregateError(failures, 'cold-open cleanup failed')
})

/**
 * The query engine, with search left unimplemented: this case reads one exact
 * session's projection baseline, which is the part the browser's follow opening
 * frame is built from. Search is a different seam and not what is under test.
 */
class TestQueryEngine extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] }
  }
}

/** A context with the loop, the case domain, a real JSONL log, and the query engine. */
async function stack(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(TestQueryEngine)
  return ctx
}

describe('opening an existing intake', () => {
  it('delivers the patient report with no new message and no live agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-medical-case-cold-open-'))
    roots.push(root)

    // ── Write: a live session records a case through the production service.
    const writing = await stack(root)
    const agent: Agent = await writing.agentLoop.create(SESSION, {}, {})
    writing.medicalCase.intake(agent, { symptoms: ['headache'], duration: '2 days' })
    writing.medicalCase.applyPatch(agent, { age: 25 })
    expect(writing.medicalCase.require(agent).revision).toBe(2)
    await writing.fiber.dispose()
    contexts.delete(writing)

    // ── Cold open: a second context, nothing in memory, no agent, no new turn.
    const reading = await stack(root)
    using observation = await reading.sessionQuery.observeSession(SESSION)

    expect(reading.sessions.get(SESSION)).toBeUndefined()

    const baseline = observation.projections
    expect(baseline).toBeDefined()
    // This is the value the browser's follow opening frame carries, so this is
    // what the intake page renders before anyone types anything.
    const reported = baseline?.values['medicalCase']
    expect(reported).toMatchObject({
      revision: 2,
      symptoms: ['headache'],
      duration: '2 days',
      age: 25,
      missingFields: [],
    })
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('delivers a null case for an intake that never recorded one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-medical-case-cold-empty-'))
    roots.push(root)

    const writing = await stack(root)
    const agent = await writing.agentLoop.create(SESSION, {}, {})
    // A session with a conversation but no intake: persistence writes no artifact
    // for a truly empty log, so this records a turn and nothing else.
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await writing.fiber.dispose()
    contexts.delete(writing)

    const reading = await stack(root)
    using observation = await reading.sessionQuery.observeSession(SESSION)
    // The key is present and explicitly null: the page distinguishes "no intake
    // yet" from "not loaded", and only the host can make that distinction.
    expect(observation.projections?.values).toHaveProperty('medicalCase')
    expect(observation.projections?.values['medicalCase']).toBeNull()
  }, PERSISTENCE_TEST_TIMEOUT_MS)
})
