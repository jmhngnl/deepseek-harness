/**
 * Service coverage for the session-backed case domain: revision semantics, the
 * authoritative read, per-session isolation, and the durable event the log
 * carries. Only the model is absent here — the session store, the projection
 * registry, and the domain are the real ones.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import MedicalCaseService, { MedicalCaseError } from '../src/index.ts'
import type { CaseView } from '../src/index.ts'

interface Harness {
  readonly ctx: Context
  /** Function-typed so a test may destructure it without unbinding `this`. */
  readonly open: (id: string) => Promise<Agent>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  return {
    ctx,
    open: (id: string) => ctx.agentLoop.create(SessionId(id), {}, {}),
  }
}

/** The durable case records one session logged, in order. */
function caseEvents(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'medical/case-change')
}

/** Capture the domain error one call raises. */
function rejection(run: () => unknown): MedicalCaseError {
  try {
    run()
  } catch (error) {
    if (error instanceof MedicalCaseError) return error
    throw error
  }
  throw new Error('expected the domain to reject this call')
}

describe('MedicalCaseService lifecycle', () => {
  it('reports no case before the first create', async () => {
    const { ctx, open } = await harness()
    expect(ctx.medicalCase.get(await open('session-a'))).toBeUndefined()
  })

  it('creates revision one and reports every missing fact for an empty request', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    const { view, changed } = ctx.medicalCase.create(agent, {})

    expect(changed).toBe(true)
    expect(view).toMatchObject({
      revision: 1,
      symptoms: [],
      duration: null,
      age: null,
      additionalNotes: null,
      missingFields: ['symptoms', 'duration', 'age'],
    })
  })

  it('refuses a second create in the same session', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.create(agent, {})
    expect(rejection(() => ctx.medicalCase.create(agent, {})).code).toBe('CASE_ALREADY_EXISTS')
  })

  it('keeps the creation time stable across later revisions', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    const created = ctx.medicalCase.create(agent, { symptoms: ['headache'] })
    const updated = ctx.medicalCase.applyPatch(agent, { age: 25 })
    expect(updated.view.createdAt).toBe(created.view.createdAt)
    expect(updated.view.caseId).toBe(created.view.caseId)
    expect(updated.view.revision).toBe(2)
  })

  it('refuses a patch before any case exists', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    expect(rejection(() => ctx.medicalCase.applyPatch(agent, { age: 25 })).code).toBe('CASE_NOT_FOUND')
    expect(rejection(() => ctx.medicalCase.require(agent)).code).toBe('CASE_NOT_FOUND')
  })

  it('refuses an agent this registry does not host', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    const foreign = { id: agent.id } as unknown as Agent
    expect(rejection(() => ctx.medicalCase.get(foreign)).code).toBe('CASE_AGENT_NOT_LIVE')
    expect(rejection(() => ctx.medicalCase.create(foreign, {})).code).toBe('CASE_AGENT_NOT_LIVE')
  })
})

describe('MedicalCaseService intake', () => {
  it('creates the case on first contact and reports the gaps', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    const { view } = ctx.medicalCase.intake(agent, { symptoms: ['headache', 'fever'] })
    expect(view.missingFields).toEqual(['duration', 'age'])
    expect(view.symptoms).toEqual(['headache', 'fever'])
  })

  it('restates an existing case and completes it', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.intake(agent, { symptoms: ['headache', 'fever'] })
    const { view, changed } = ctx.medicalCase.intake(agent, { duration: '2 days', age: 25 })

    expect(changed).toBe(true)
    expect(view).toMatchObject({
      revision: 2,
      symptoms: ['headache', 'fever'],
      duration: '2 days',
      age: 25,
      missingFields: [],
    })
  })

  it('reports an unchanged restatement without spending a revision', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    const first = ctx.medicalCase.intake(agent, { symptoms: ['headache'], duration: '2 days', age: 25 })
    const again = ctx.medicalCase.intake(agent, { symptoms: ['headache'], duration: '2 days', age: 25 })

    expect(again.changed).toBe(false)
    expect(again.view.revision).toBe(first.view.revision)
    expect(caseEvents(agent)).toHaveLength(1)
  })
})

describe('MedicalCaseService patch semantics', () => {
  it('appends a symptom without losing the recorded ones', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.create(agent, { symptoms: ['headache', 'fever'] })
    const { view } = ctx.medicalCase.applyPatch(agent, { symptomsAdd: ['nausea'] })
    expect(view.symptoms).toEqual(['headache', 'fever', 'nausea'])
  })

  it('clears the entire missing list once the required facts arrive', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.intake(agent, { symptoms: ['headache', 'fever'] })
    const { view } = ctx.medicalCase.applyPatch(agent, { duration: '2 days', age: 25 })
    expect(view.missingFields).toEqual([])
  })

  it('does not append an event or move the revision for a no-op patch', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    const created = ctx.medicalCase.create(agent, { symptoms: ['headache'], duration: '2 days', age: 25 })
    const before = caseEvents(agent).length

    const { view, changed } = ctx.medicalCase.applyPatch(agent, { duration: '2 days' })
    expect(changed).toBe(false)
    expect(view.revision).toBe(created.view.revision)
    expect(view.updatedAt).toBe(created.view.updatedAt)
    expect(caseEvents(agent)).toHaveLength(before)
  })

  it('surfaces a rejected patch as a domain error, appending nothing', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.create(agent, { symptoms: ['headache'], duration: '2 days', age: 25 })
    expect(rejection(() => ctx.medicalCase.applyPatch(agent, { symptoms: [] })).code).toBe('CASE_INVALID_SYMPTOMS')
    expect(caseEvents(agent)).toHaveLength(1)
  })

  it('clamps a wall clock that steps backwards instead of publishing it', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(5_000)
      const created = ctx.medicalCase.create(agent, { symptoms: ['headache'] })
      vi.setSystemTime(1_000)
      const updated = ctx.medicalCase.applyPatch(agent, { age: 25 })
      expect(created.view.updatedAt).toBe(5_000)
      expect(updated.view.updatedAt).toBe(5_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MedicalCaseService reads the authoritative projection', () => {
  it('returns the latest state the session log folded to', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.intake(agent, { symptoms: ['headache'] })
    ctx.medicalCase.applyPatch(agent, { duration: '2 days' })
    ctx.medicalCase.applyPatch(agent, { age: 25 })

    const view = ctx.medicalCase.require(agent)
    expect(view).toMatchObject({ revision: 3, symptoms: ['headache'], duration: '2 days', age: 25, missingFields: [] })
  })

  it('keeps the projection host-only, so no client view is published for it', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.create(agent, { symptoms: ['headache'] })
    expect(ctx.sessionProjections.snapshot(agent.session).values).not.toHaveProperty('medicalCase')
  })

  it('derives missingFields on read, never from a persisted copy', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.create(agent, { symptoms: ['headache'] })

    const stored = ctx.sessionProjections.stateOf(agent.session, 'medicalCase')
    expect(stored?.current).not.toHaveProperty('missingFields')
  })
})

describe('MedicalCaseService session isolation', () => {
  it('gives each session its own case', async () => {
    const { ctx, open } = await harness()
    const sessionA = await open('session-a')
    const sessionB = await open('session-b')

    ctx.medicalCase.create(sessionA, { symptoms: ['headache'], duration: '2 days', age: 25 })
    ctx.medicalCase.create(sessionB, { symptoms: ['cough'], duration: '1 day', age: 60 })

    expect(ctx.medicalCase.require(sessionA).age).toBe(25)
    expect(ctx.medicalCase.require(sessionB).age).toBe(60)
    expect(ctx.medicalCase.require(sessionA).caseId).not.toBe(ctx.medicalCase.require(sessionB).caseId)
  })

  it('never leaks an update from one session into another', async () => {
    const { ctx, open } = await harness()
    const sessionA = await open('session-a')
    const sessionB = await open('session-b')
    ctx.medicalCase.create(sessionA, { symptoms: ['headache'], duration: '2 days', age: 25 })
    ctx.medicalCase.create(sessionB, { symptoms: ['cough'], duration: '1 day', age: 60 })

    ctx.medicalCase.applyPatch(sessionA, { age: 26 })

    expect(ctx.medicalCase.require(sessionA).age).toBe(26)
    expect(ctx.medicalCase.require(sessionB).age).toBe(60)
    expect(ctx.medicalCase.require(sessionB).revision).toBe(1)
  })
})

describe('MedicalCaseService durable record', () => {
  it('writes one full-state event per accepted mutation', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.intake(agent, { symptoms: ['headache'] })
    ctx.medicalCase.applyPatch(agent, { duration: '2 days' })

    const events = caseEvents(agent)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'medical/case-change',
      data: { kind: 'medical/case-change', version: 1, operation: 'create' },
    })
    // Each record carries the whole state, never a delta.
    expect(events[1]).toMatchObject({
      data: {
        operation: 'update',
        case: { revision: 2, symptoms: ['headache'], duration: '2 days', age: null },
      },
    })
  })

  it('never persists the derived missing-field report', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    ctx.medicalCase.intake(agent, { symptoms: ['headache'] })
    const payload = caseEvents(agent)[0]?.data
    expect(JSON.stringify(payload)).not.toContain('missingFields')
  })

  it('offers the same view to a caller reading the projection directly', async () => {
    const { ctx, open } = await harness()
    const agent = await open('session-a')
    const { view } = ctx.medicalCase.intake(agent, { symptoms: ['headache'], duration: '2 days', age: 25 })
    const stored = ctx.sessionProjections.stateOf(agent.session, 'medicalCase')
    expect(stored?.current).toEqual({
      caseId: view.caseId,
      revision: view.revision,
      symptoms: view.symptoms,
      duration: view.duration,
      age: view.age,
      additionalNotes: view.additionalNotes,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    } satisfies Omit<CaseView, 'missingFields'>)
  })
})
