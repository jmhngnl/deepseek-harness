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
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { MedicalImageObservation } from '@deepseek-ai/dsh-medical-image'
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

// ── The image projection ───────────────────────────────────────────────────

/** One authoritative observation, as the domain publishes it. */
function storedObservation(attachmentId: string, revision = 1): MedicalImageObservation {
  return {
    attachment: {
      attachmentId: AttachmentId(attachmentId),
      mediaType: 'image/png',
      bytes: 2_048,
      width: 64,
      height: 64,
      name: 'fixture.png',
    },
    revision,
    bodyRegion: 'forearm',
    findings: ['red patch'],
    quality: { usable: true, issues: ['blur'] },
    uncertainty: ['depth unclear'],
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

/** One durable image record, as the domain appends it. */
function imageEvent(attachmentId: string, operation: 'observe' | 'update', revision: number, seq: number): SessionEvent {
  return {
    type: 'medical/image-observation',
    seq: SessionSeq(seq),
    time: 1_200,
    data: {
      kind: 'medical/image-observation',
      version: 1,
      operation,
      observation: storedObservation(attachmentId, revision),
    },
  }
}

const KEY_ONE = `sha256:${'a'.repeat(64)}`
const KEY_TWO = `sha256:${'b'.repeat(64)}`

describe('projecting the image dimension of a turn', () => {
  it('names an observation and an event by the case key the runner resolved', () => {
    const observed = observeTurn({
      turnIndex: 0,
      user: '看一下',
      events: [imageEvent(KEY_ONE, 'observe', 1, 5)],
      caseState: null,
      images: [{ imageKey: 'image-1', attachmentId: KEY_ONE }],
      imageObservations: [storedObservation(KEY_ONE)],
    })

    expect(observed.imageObservations).toEqual([{
      imageKey: 'image-1',
      attachmentId: KEY_ONE,
      revision: 1,
      bodyRegion: 'forearm',
      findings: ['red patch'],
      usable: true,
      qualityIssues: ['blur'],
      uncertainty: ['depth unclear'],
    }])
    expect(observed.imageEvents).toEqual([{
      imageKey: 'image-1',
      attachmentId: KEY_ONE,
      operation: 'observe',
      revision: 1,
      eventSeq: 5,
    }])
  })

  it('keeps two images apart by their own keys', () => {
    const observed = observeTurn({
      turnIndex: 0,
      user: '两张',
      events: [imageEvent(KEY_ONE, 'observe', 1, 5), imageEvent(KEY_TWO, 'observe', 1, 6)],
      caseState: null,
      images: [
        { imageKey: 'image-1', attachmentId: KEY_ONE },
        { imageKey: 'image-2', attachmentId: KEY_TWO },
      ],
      imageObservations: [storedObservation(KEY_ONE), storedObservation(KEY_TWO)],
    })

    expect(observed.imageObservations.map(entry => entry.imageKey)).toEqual(['image-1', 'image-2'])
    expect(observed.imageEvents.map(entry => entry.imageKey)).toEqual(['image-1', 'image-2'])
  })

  it('reports an attachment this case never admitted with no key rather than guessing one', () => {
    const observed = observeTurn({
      turnIndex: 0,
      user: '看一下',
      events: [imageEvent(KEY_TWO, 'observe', 1, 5)],
      caseState: null,
      images: [{ imageKey: 'image-1', attachmentId: KEY_ONE }],
      imageObservations: [storedObservation(KEY_TWO)],
    })

    expect(observed.imageObservations[0]?.imageKey).toBeNull()
    expect(observed.imageEvents[0]?.imageKey).toBeNull()
  })

  it('reports no image at all for a turn whose harness mounted no image domain', () => {
    const observed = observeTurn({ turnIndex: 0, user: '我头疼', events: [], caseState: null })

    expect(observed.imageObservations).toEqual([])
    expect(observed.imageEvents).toEqual([])
  })

  it('keeps the first key when one attachment was admitted under two', () => {
    const observed = observeTurn({
      turnIndex: 0,
      user: '同一张',
      events: [],
      caseState: null,
      images: [
        { imageKey: 'image-1', attachmentId: KEY_ONE },
        { imageKey: 'again', attachmentId: KEY_ONE },
      ],
      imageObservations: [storedObservation(KEY_ONE)],
    })

    expect(observed.imageObservations[0]?.imageKey).toBe('image-1')
  })
})
