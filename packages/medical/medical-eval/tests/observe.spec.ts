/**
 * Observer coverage: the shape a turn is projected into.
 *
 * These drive events directly rather than through an agent, because the cases
 * they pin are log shapes the runner does not produce — a turn whose boundaries
 * are incomplete, a turn with no events at all. `observeTurn` is the seam
 * between the runtime and the evaluator and is public, so what it does with an
 * event slice that does not form a turn is part of its contract rather than an
 * internal detail.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { observeTurn } from '../src/index.ts'

/** A turn that opened at 1,000 ms. */
const OPENED: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } }

/** Its successful closure 500 ms later. */
const COMPLETED: SessionEvent = {
  type: 'turn/end',
  seq: SessionSeq(1),
  time: 1_500,
  data: { turn: 1, reason: { kind: 'completed' } },
}

/** Its closure as a failed turn. */
const FAILED: SessionEvent = {
  type: 'turn/end',
  seq: SessionSeq(1),
  time: 1_500,
  data: {
    turn: 1,
    reason: { kind: 'error', error: { message: 'the provider refused the request', code: 'REQUEST_FAILED' } },
  },
}

describe('observing a turn', () => {
  it('carries the identity the runner gives it', () => {
    const observed = observeTurn({ turnIndex: 2, user: '我头疼', events: [], caseState: null, timedOut: true })

    expect(observed.turnIndex).toBe(2)
    expect(observed.user).toBe('我头疼')
    expect(observed.timedOut).toBe(true)
    expect(observed.caseState).toBeNull()
  })

  it('reports nothing observed for a turn with no events', () => {
    const observed = observeTurn({ turnIndex: 0, user: '我头疼', events: [], caseState: null })

    expect(observed.toolCalls).toEqual([])
    expect(observed.toolResults).toEqual([])
    expect(observed.caseEvents).toEqual([])
    expect(observed.usage).toBeNull()
    expect(observed.timing).toBeNull()
    expect(observed.runtimeError).toBeNull()
    expect(observed.timedOut).toBe(false)
  })

  it('reports no span for a turn whose boundaries are incomplete', () => {
    const opened = observeTurn({ turnIndex: 0, user: '我头疼', events: [OPENED], caseState: null })

    expect(opened.timing).toBeNull()
  })

  it('measures the span its own boundaries describe', () => {
    const observed = observeTurn({ turnIndex: 0, user: '我头疼', events: [OPENED, COMPLETED], caseState: null })

    expect(observed.timing).toEqual({ startMs: 1_000, endMs: 1_500, wallClockMs: 500 })
    expect(observed.runtimeError).toBeNull()
  })

  it('reads a runtime fault from the turn that closed as failed', () => {
    const observed = observeTurn({ turnIndex: 0, user: '我头疼', events: [OPENED, FAILED], caseState: null })

    expect(observed.runtimeError).toEqual({
      name: 'REQUEST_FAILED',
      message: 'the provider refused the request',
    })
  })
})
