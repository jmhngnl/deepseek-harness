/**
 * The deterministic runner: replay golden cases through the real agent loop.
 *
 * What the runner owns is the seam between a case and a runtime, and it owns
 * as little of it as possible. It builds no services, registers no tools, and
 * knows no model: the caller supplies one isolated harness per case, so the
 * composition under test is the composition that ships rather than a
 * re-mounting of it.
 *
 * Isolation is per case rather than per turn. A harness lives for exactly one
 * case and is disposed after it, so no golden case can inherit another's case
 * state, and no runner ever keeps a map from session to state — the domain
 * already owns that and a second copy could only disagree with it.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { evaluateCase } from './evaluate.ts'
import { observeTurn } from './observe.ts'
import type { GoldenCase, GoldenCaseRun, ObservedTurn } from './types.ts'

/** One golden case's runtime, isolated for the whole of that case. */
export interface GoldenCaseHarness {
  /** Context whose lifetime covers exactly this case. */
  readonly ctx: Context
  /** Agent the case is replayed through, with its own fresh session. */
  readonly agent: Agent
}

/** Options every case in one run shares. */
export interface GoldenRunOptions {
  /** Wall-clock ceiling for one turn, in milliseconds. */
  readonly turnTimeoutMs?: number
}

/** A turn that has not settled in two minutes has stopped being a measurement of routing. */
const DEFAULT_TURN_TIMEOUT_MS = 120_000

/**
 * Replay golden cases through real agent loops.
 *
 * The caller's `setup` decides what a case runs against — a scripted adapter on
 * the real services for a deterministic run, or a live model route for a
 * benchmark — and this function never learns which. What it guarantees is that
 * each case gets its own harness, its own session, and one observation per
 * turn, whatever the model does.
 * @param cases - the cases to replay, in order.
 * @param setup - builds one isolated harness for one case.
 * @param options - shared bounds applied to every case.
 * @returns one evaluation and wall-clock measurement per case, in case order.
 */
export async function runGoldenCases(
  cases: readonly GoldenCase[],
  setup: (golden: GoldenCase) => Promise<GoldenCaseHarness> | GoldenCaseHarness,
  options: GoldenRunOptions = {},
): Promise<GoldenCaseRun[]> {
  const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const runs: GoldenCaseRun[] = []
  for (const golden of cases) {
    runs.push(await runGoldenCase(golden, setup, timeoutMs))
  }
  return runs
}

/** Replay one case against one harness, disposing the harness however it ends. */
async function runGoldenCase(
  golden: GoldenCase,
  setup: (golden: GoldenCase) => Promise<GoldenCaseHarness> | GoldenCaseHarness,
  turnTimeoutMs: number,
): Promise<GoldenCaseRun> {
  const harness = await setup(golden)
  const startedMs = Date.now()
  try {
    const committed = collectCommitted(harness.agent)
    const observed: ObservedTurn[] = []
    for (const [index, turn] of golden.turns.entries()) {
      // Only the events this turn commits are its own: the collector is
      // drained before the message is admitted, so a turn's observation cannot
      // inherit the previous turn's calls or its case record.
      committed.take()
      const timedOut = await driveTurn(harness.agent, turn.user, turnTimeoutMs)
      observed.push(observeTurn({
        turnIndex: index,
        user: turn.user,
        events: committed.take(),
        caseState: harness.ctx.medicalCase.get(harness.agent) ?? null,
        timedOut,
      }))
    }
    return {
      golden,
      evaluation: evaluateCase({ golden, observed, sessionId: harness.agent.session.id }),
      latencyMs: Date.now() - startedMs,
    }
  } finally {
    await harness.ctx.fiber.dispose()
  }
}

/**
 * Take the events one agent's session commits, as they commit.
 *
 * The listener is registered on the agent's own context, which the harness
 * scope-filters to the sessions entered through it, so no other session in the
 * same composition can be mistaken for this case's. The alternative —
 * reading the session log back by sequence — is a synchronous history read,
 * which the session package deprecates for new callers and which this runner
 * does not need: a turn's events are exactly those committed while it ran.
 */
function collectCommitted(agent: Agent): { take: () => SessionEvent[] } {
  const pending: SessionEvent[] = []
  agent.ctx.on('session/event', (_session: Session, event: SessionEvent) => {
    pending.push(event)
  })
  return { take: () => pending.splice(0) }
}

/**
 * Send one user message and wait for the loop to settle.
 *
 * The ceiling is enforced by cancelling the agent rather than by abandoning the
 * wait: the turn then converges to idle and closes itself in the log, so a
 * hung turn still produces the `turn/end` its observation is read from and the
 * harness can still be disposed.
 */
async function driveTurn(agent: Agent, user: string, timeoutMs: number): Promise<boolean> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }))
  let timedOut = false
  const ceiling = setTimeout(() => {
    timedOut = true
    agent.cancel({ kind: 'user' })
  }, timeoutMs)
  try {
    await agent.whenIdle()
  } finally {
    clearTimeout(ceiling)
  }
  return timedOut
}
