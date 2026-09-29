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
 * An image turn takes the same path a real one does. The runner reads the
 * fixture bytes, hands them to `ctx.attachments.admitPromptContent`, and puts
 * the canonical references it gets back into the same user message as the text.
 * It never mints an id, hashes bytes, or guesses a dimension: admission is the
 * only thing that produces an `ImageAttachmentRef`, so a golden case exercises
 * the integration rather than a description of it.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// Empty type imports carry the `ctx.attachments` and `ctx.medicalImage` Context merges this runner reads.
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-medical-image'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { evaluateCase } from './evaluate.ts'
import { loadImageFixture } from './fixtures.ts'
import { observeTurn } from './observe.ts'
import type { AdmittedImage } from './observe.ts'
import type { GoldenCase, GoldenCaseRun, GoldenImageInput, ObservedTurn } from './types.ts'

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
    // Every image this case admitted, so an expectation can name an attachment
    // by the key the case wrote rather than by the digest admission minted.
    const admitted: AdmittedImage[] = []
    for (const [index, turn] of golden.turns.entries()) {
      // Only the events this turn commits are its own: the collector is
      // drained before the message is admitted, so a turn's observation cannot
      // inherit the previous turn's calls or its case record.
      committed.take()
      const content = await turnContent(harness.ctx, turn.user, turn.images ?? [], admitted)
      const timedOut = await driveTurn(harness.agent, content, turnTimeoutMs)
      observed.push(observeTurn({
        turnIndex: index,
        user: turn.user,
        events: committed.take(),
        caseState: harness.ctx.medicalCase.get(harness.agent) ?? null,
        images: admitted,
        // A harness that mounts no image domain has nothing to observe, which is
        // a legitimate text-only composition rather than an error: the runner
        // builds no services, so what exists is the caller's decision.
        imageObservations: harness.ctx.get('medicalImage')?.list(harness.agent) ?? [],
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
 * Build one turn's message content, admitting every image through the real
 * attachment service.
 *
 * The text comes first and the images follow in the order the case names them,
 * which is the order a Host prompt uses. Admission is sequential so a failure
 * names the image that caused it, and the canonical reference — not the bytes,
 * not a digest this runner computed — is what enters the message.
 * @param ctx - the case's context, carrying the attachment service.
 * @param user - the turn's user text.
 * @param images - the synthetic images this turn attaches, in order.
 * @param admitted - the case's running key-to-attachment record, appended to.
 * @returns the content blocks of one user message.
 */
async function turnContent(
  ctx: Context,
  user: string,
  images: readonly GoldenImageInput[],
  admitted: AdmittedImage[],
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [{ type: 'text', text: user }]
  if (images.length === 0) return content
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new Error(
      'this harness mounts no attachment service, so a golden image cannot be admitted;'
      + ' a case with images needs the composition that serves them',
    )
  }
  for (const [position, image] of images.entries()) {
    const fixture = loadImageFixture(image.fixture)
    const [part] = await attachments.admitPromptContent([{
      type: 'image',
      mediaType: fixture.mediaType,
      data: Buffer.from(fixture.bytes).toString('base64'),
      // Deliberately neutral. The fixture id is a registry id, not a description,
      // and naming the file after it would hand the model a hint about what the
      // image shows — which is exactly what an observation case must not rely on.
      name: `image-${String(position + 1)}.png`,
    }])
    /* v8 ignore next -- admission returns one part per submitted part by contract */
    if (part === undefined || part.type !== 'image') {
      throw new Error(`attaching ${fixture.id} produced no image reference`)
    }
    const attachment: ImageAttachmentRef = part.attachment
    admitted.push({ imageKey: image.key, attachmentId: String(attachment.attachmentId) })
    content.push({ type: 'image', attachment })
  }
  return content
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
async function driveTurn(agent: Agent, content: readonly ContentBlock[], timeoutMs: number): Promise<boolean> {
  agent.followup(createUserMessage({ content: [...content], source: { kind: 'user' } }))
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
