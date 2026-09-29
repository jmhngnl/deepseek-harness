/**
 * Runner coverage: the shipped roster replayed through real agent loops.
 *
 * Only the model is scripted. The tool registry, the session, the projection
 * registry, the case domain, and tool execution are the shipped
 * implementations, so a case that passes here passed against the runtime
 * rather than against a re-mounting of it. Assertions read the durable case
 * the domain derived — never the assistant's text — because a conversation
 * that says "recorded" and a case holding no symptoms can disagree, and only
 * one of them is evidence.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { LlmError, ToolCallId, visitImageBlocks } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import MedicalImageService from '@deepseek-ai/dsh-medical-image'
import { loadGoldenCases, runGoldenCases } from '../src/index.ts'
import type { GoldenCase, GoldenCaseHarness } from '../src/index.ts'
import { MedicalCaseService } from '@deepseek-ai/dsh-medical-case'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolMedicalCaseGet from '@deepseek-ai/dsh-tool-medical-case-get'
import * as ToolMedicalCaseIntake from '@deepseek-ai/dsh-tool-medical-case-intake'
import * as ToolMedicalCaseUpdate from '@deepseek-ai/dsh-tool-medical-case-update'
import * as ToolMedicalImageGet from '@deepseek-ai/dsh-tool-medical-image-get'
import * as ToolMedicalImageObserve from '@deepseek-ai/dsh-tool-medical-image-observe'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** The directory the shipped roster lives in. */
const ROSTER = fileURLToPath(new URL('../golden/', import.meta.url))

/** Provider route every scripted adapter is registered under. */
const PROVIDER = 'mock'

/**
 * Harness homes this suite created, removed when it ends.
 *
 * The attachment service is given its own root per case rather than the real
 * `$DSH_HOME`, so a deterministic run cannot write into a user's attachment
 * store and cannot inherit one either.
 */
const HARNESS_HOMES: string[] = []

afterAll(() => {
  for (const home of HARNESS_HOMES.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A scripted model call, or a marker that the turn never settles. */
type ScriptEntry = StreamChunk[] | 'hang' | (() => never) | ((options: GenerateOptions) => StreamChunk[])

/** One case's runtime as the runner receives it. */
interface Built {
  readonly harness: GoldenCaseHarness
  readonly adapter: MockAdapter
}

/** Mount the shipped services and one scripted model under a context of this case's own. */
async function build(caseId: string, script: ScriptEntry[]): Promise<Built> {
  const ctx = new Context()
  const home = mkdtempSync(join(tmpdir(), 'medharness-eval-'))
  HARNESS_HOMES.push(home)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MedicalCaseService)
  await ctx.plugin(MedicalImageService)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(ToolMedicalCaseIntake)
  await ctx.plugin(ToolMedicalCaseUpdate)
  await ctx.plugin(ToolMedicalCaseGet)
  await ctx.plugin(ToolMedicalImageObserve)
  await ctx.plugin(ToolMedicalImageGet)
  // The adapter consumes the script it is handed, so each case gets its own copy.
  const adapter = new MockAdapter([...script])
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`golden-${caseId}`), { provider: PROVIDER, model: 'mock' })
  return { harness: { ctx, agent }, adapter }
}

/**
 * The attachment ids a request carries, in message order.
 *
 * This is what a model reads beside each image: the harness puts the canonical
 * id in the request, and a scripted turn has to answer with the same id. Nothing
 * here computes a digest — the ids come from admission, through the request.
 */
function requestImageIds(options: GenerateOptions): string[] {
  const ids: string[] = []
  for (const message of options.messages) {
    visitImageBlocks(message.content, (block) => { ids.push(String(block.attachment.attachmentId)) })
  }
  return ids
}

/** One COMPLETE observation snapshot, as the tool requires it. */
function snapshot(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { bodyRegion: null, findings: [], usable: true, qualityIssues: [], uncertainty: [], ...fields }
}

/** A model call that observes the image at one position in the request. */
function observeImage(
  position: number,
  fields: Record<string, unknown>,
  callId: string,
): (options: GenerateOptions) => StreamChunk[] {
  return options => toolCallResponse(callId, 'medical_image_observe', {
    attachmentId: requestImageIds(options)[position],
    ...snapshot(fields),
  })
}

/** A model call that reads back the image at one position in the request. */
function getImage(position: number, callId: string): (options: GenerateOptions) => StreamChunk[] {
  return options => toolCallResponse(callId, 'medical_image_get', {
    attachmentId: requestImageIds(options)[position],
  })
}

/** One shipped case, which the roster is expected to hold. */
function rosterCase(id: string): GoldenCase {
  const found = loadGoldenCases(ROSTER).find(golden => golden.id === id)
  if (found === undefined) throw new Error(`the roster has no case ${id}`)
  return found
}

/** A model call whose tool arguments are whatever the model emitted, verbatim. */
function rawCall(callId: string, name: string, rawArguments: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name, argumentsDelta: rawArguments },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: rawArguments },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A model call that reports no token usage, which is how an unmetered route answers. */
function unmeasuredText(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * What the model says for each case, as the contract documents it.
 *
 * Each turn is two calls: the tool call the case is about, then the text that
 * ends the turn. Anything else — a second tool call, a request the script does
 * not have — fails the run, which is how a case detects that the loop needed
 * more from the model than the case anticipated.
 */
const SCRIPTS: Record<string, ScriptEntry[]> = {
  'intake-first-contact-two-symptoms': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'] }),
    textResponse('症状持续多久了？您多大年龄？'),
  ],
  'intake-complete-first-contact': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
  ],
  'update-completes-the-record': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'] }),
    textResponse('持续多久了？您多大年龄？'),
    toolCallResponse('c2', 'medical_case_update', { duration: '两天', age: 25 }),
    textResponse('已补全。'),
  ],
  'update-adds-a-symptom': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_update', { symptomsAdd: ['恶心'] }),
    textResponse('已添加。'),
  ],
  'update-removes-a-corrected-symptom': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_update', { symptomsRemove: ['发烧'] }),
    textResponse('已更正。'),
  ],
  'update-corrects-the-age': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_update', { age: 26 }),
    textResponse('已更正。'),
  ],
  'get-reads-without-changing': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    toolCallResponse('c2', 'medical_case_get', {}),
    textResponse('记录完整。'),
  ],
  'intake-restatement-writes-nothing': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], age: 25 }),
    textResponse('还需要持续时间和年龄。'),
    toolCallResponse('c2', 'medical_case_intake', { symptoms: ['头疼', '发烧'], age: 25 }),
    textResponse('记录未变。'),
  ],
  // ── The image cases ──────────────────────────────────────────────────────
  //
  // Every image turn answers with the attachment id the REQUEST carried, which
  // is what a real model does: it reads the id beside the image. No script
  // computes a digest, and none could — admission mints it.
  'image-observe-single-usable': [
    observeImage(0, { bodyRegion: 'forearm', findings: ['red patch'] }, 'c1'),
    textResponse('已记录观察到的情况。'),
  ],
  'image-observe-unusable-image': [
    observeImage(0, {
      usable: false,
      findings: [],
      qualityIssues: ['blur', 'poor_lighting'],
      uncertainty: ['no resolvable structure'],
    }, 'c1'),
    textResponse('这张照片看不清，能再拍一张吗？'),
  ],
  'image-observe-restatement-is-a-noop': [
    observeImage(0, { bodyRegion: 'forearm', findings: ['red patch'] }, 'c1'),
    textResponse('已记录。'),
    // The identical full snapshot, submitted again.
    observeImage(0, { bodyRegion: 'forearm', findings: ['red patch'] }, 'c2'),
    textResponse('已复核，记录未变。'),
  ],
  'image-observe-update-advances-revision': [
    observeImage(0, { findings: ['red patch'] }, 'c1'),
    textResponse('已记录。'),
    observeImage(0, { findings: ['red patch', 'scaling at the border'] }, 'c2'),
    textResponse('已更新。'),
  ],
  'image-observe-two-images': [
    observeImage(0, { findings: ['red patch'] }, 'c1'),
    observeImage(1, { findings: ['blue square'] }, 'c2'),
    textResponse('两张都记下了。'),
    getImage(1, 'c3'),
    textResponse('第二张还在记录里。'),
  ],
  'image-observe-keeps-the-case-untouched': [
    toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
    textResponse('已记录。'),
    observeImage(0, { findings: ['red patch'] }, 'c2'),
    textResponse('图片观察也已记录。'),
  ],
  'image-live-smoke-visible-patch': [
    observeImage(0, { bodyRegion: 'forearm', findings: ['red disc on a light background'] }, 'c1'),
    textResponse('已记录观察到的情况。'),
  ],
}

/** Replay the shipped roster, capturing each case's adapter and session. */
async function replayRoster(): Promise<{
  runs: Awaited<ReturnType<typeof runGoldenCases>>
  adapters: Map<string, MockAdapter>
  sessions: string[]
}> {
  const adapters = new Map<string, MockAdapter>()
  const sessions: string[] = []
  const runs = await runGoldenCases(loadGoldenCases(ROSTER), async (golden) => {
    const script = SCRIPTS[golden.id]
    if (script === undefined) throw new Error(`the roster has no script for ${golden.id}`)
    const built = await build(golden.id, script)
    adapters.set(golden.id, built.adapter)
    sessions.push(built.harness.agent.session.id)
    return built.harness
  })
  return { runs, adapters, sessions }
}

describe('replaying the shipped roster', () => {
  it('passes every case', async () => {
    const { runs } = await replayRoster()

    const reported = runs.flatMap(run => run.evaluation.failures.map(failure =>
      `${run.evaluation.id} turn ${String(failure.turnIndex)}: ${failure.failureType} — ${failure.detail}`))

    expect(reported).toEqual([])
    expect(runs).toHaveLength(15)
    expect(runs.every(run => run.evaluation.passed)).toBe(true)
  })

  it('gives every case a session, and every recorded case an identity, of its own', async () => {
    const { runs, sessions } = await replayRoster()

    expect(new Set(sessions).size).toBe(runs.length)
    // An image-only case records no case, so only the cases that opened one
    // have an identity to compare — and no two of those may share it.
    const identities = runs
      .map(run => run.evaluation.turns.at(-1)?.caseState?.caseId)
      .filter(identity => identity !== undefined)
    expect(identities.length).toBeGreaterThan(0)
    expect(new Set(identities).size).toBe(identities.length)
  })

  it('asks the model for exactly the calls each case scripts', async () => {
    const { runs, adapters } = await replayRoster()

    for (const run of runs) {
      // One model call per tool call the case scripts, plus the text that ends
      // the turn. More would mean the loop needed a step the case did not
      // anticipate.
      const expected = run.golden.turns
        .reduce((total, turn) => total + turn.expect.toolRouting.calls.length + 1, 0)
      expect(adapters.get(run.evaluation.id)?.requests, run.evaluation.id).toHaveLength(expected)
    }
  })

  it('measures each case', async () => {
    const { runs } = await replayRoster()
    expect(runs.every(run => Number.isFinite(run.latencyMs))).toBe(true)
  })

  it('leaves the revision and the log alone for a read and for a restatement', async () => {
    const { runs } = await replayRoster()
    const read = runs.find(run => run.evaluation.id === 'get-reads-without-changing')
    const restatement = runs.find(run => run.evaluation.id === 'intake-restatement-writes-nothing')

    // The expectations these cases carry assert `changed: false` and
    // `eventCountDelta: 0`, so a passing turn is the proof that no
    // `medical/case-change` record was appended for it.
    expect(read?.evaluation.turns[1]?.toolCalls).toEqual(['medical_case_get'])
    expect(read?.evaluation.turns[1]?.caseState?.revision).toBe(1)
    expect(restatement?.evaluation.turns[1]?.toolCalls).toEqual(['medical_case_intake'])
    expect(restatement?.evaluation.turns[1]?.caseState?.revision).toBe(1)
  })

  it('advances the revision the case that writes twice expects', async () => {
    const { runs } = await replayRoster()
    const completing = runs.find(run => run.evaluation.id === 'update-completes-the-record')

    expect(completing?.evaluation.turns.map(turn => turn.caseState?.revision)).toEqual([1, 2])
    expect(completing?.evaluation.turns[1]?.caseState?.missingFields).toEqual([])
  })
})

describe('a case that regresses', () => {
  it('classifies the regression instead of passing it', async () => {
    const runs = await runGoldenCases([rosterCase('get-reads-without-changing')], async () => (await build('regression', [
      toolCallResponse('c1', 'medical_case_intake', { symptoms: ['头疼', '发烧'], duration: '两天', age: 25 }),
      textResponse('已记录。'),
      // The turn asked what the record holds and the model wrote to it instead.
      toolCallResponse('c2', 'medical_case_update', { age: 30 }),
      textResponse('已更新。'),
    ])).harness)

    const evaluation = runs[0]?.evaluation
    expect(evaluation?.passed).toBe(false)
    expect(new Set(evaluation?.failures.map(failure => failure.failureType)))
      .toEqual(new Set(['WRONG_TOOL', 'CASE_STATE_MISMATCH', 'REVISION_MISMATCH', 'UNEXPECTED_CASE_MUTATION']))

    const wrong = evaluation?.failures.find(failure => failure.failureType === 'WRONG_TOOL')
    expect(wrong?.goldenCaseId).toBe('get-reads-without-changing')
    expect(wrong?.turnIndex).toBe(1)
    expect(wrong?.evidence.toolResultSeqs).toHaveLength(1)
    expect(wrong?.evidence.caseEventSeqs).toHaveLength(1)
  })
})

describe('a turn that never settles', () => {
  it('cancels it at the ceiling and reports the timeout', async () => {
    const runs = await runGoldenCases(
      [rosterCase('intake-first-contact-two-symptoms')],
      async () => (await build('timeout', ['hang'])).harness,
      { turnTimeoutMs: 150 },
    )

    expect(runs[0]?.evaluation.failures.map(failure => failure.failureType)).toEqual(['SESSION_TIMEOUT'])
    expect(runs[0]?.evaluation.turns[0]?.caseState).toBeNull()
  })
})

describe('a model call that fails', () => {
  it('reports the fault rather than an assertion the partial turn would have failed anyway', async () => {
    let adapter: MockAdapter | undefined
    const runs = await runGoldenCases(
      [rosterCase('intake-first-contact-two-symptoms')],
      async () => {
        const built = await build('request-failure', [
          () => { throw new LlmError('the provider refused the request', 'INVALID_REQUEST') },
        ])
        adapter = built.adapter
        return built.harness
      },
    )

    expect(runs[0]?.evaluation.failures.map(failure => failure.failureType)).toEqual(['RUNTIME_ERROR'])
    expect(runs[0]?.evaluation.failures[0]?.detail).toContain('INVALID_REQUEST')
    expect(adapter?.requests).toHaveLength(1)
  })
})

describe('the harness a caller supplies', () => {
  it('may be built before the run rather than by a factory', async () => {
    const built = await build('prebuilt', SCRIPTS['intake-complete-first-contact'] ?? [])

    const runs = await runGoldenCases([rosterCase('intake-complete-first-contact')], () => built.harness)

    expect(runs[0]?.evaluation.passed).toBe(true)
  })
})

describe('a model that emits arguments the harness cannot read', () => {
  it('reports an argument fault rather than aborting the run', async () => {
    const unreadable: readonly (readonly [label: string, raw: string])[] = [
      ['arguments that are not JSON', '{"symptoms":'],
      ['arguments JSON cannot carry', '{"symptoms": 1e999}'],
    ]

    for (const [index, [label, raw]] of unreadable.entries()) {
      const runs = await runGoldenCases(
        [rosterCase('intake-first-contact-two-symptoms')],
        async () => (await build(`unreadable-${String(index)}`, [
          rawCall('c1', 'medical_case_intake', raw),
          textResponse('已记录。'),
        ])).harness,
      )

      const types = runs[0]?.evaluation.failures.map(failure => failure.failureType) ?? []
      expect(types, label).toContain('ARGUMENT_EXTRACTION_ERROR')
    }
  })
})

describe('a route that measures nothing', () => {
  it('reports usage as absent rather than as zero', async () => {
    const runs = await runGoldenCases(
      [rosterCase('intake-complete-first-contact')],
      async () => (await build('unmeasured', [
        rawCall('c1', 'medical_case_intake', JSON.stringify({ symptoms: ['头疼', '发烧'], duration: '两天', age: 25 })),
        unmeasuredText('已记录。'),
      ])).harness,
    )

    expect(runs[0]?.evaluation.passed).toBe(true)
    expect(runs[0]?.evaluation.turns[0]?.usage).toBeNull()
  })
})

// ── The image path ─────────────────────────────────────────────────────────

/** The image blocks one request carried, in message order. */
function requestImageBlocks(options: GenerateOptions): ImageBlock[] {
  const blocks: ImageBlock[] = []
  for (const message of options.messages) {
    visitImageBlocks(message.content, (block) => { blocks.push(block) })
  }
  return blocks
}

/** One image case's runtime and the adapter that served it. */
async function replayOne(id: string, script: ScriptEntry[]): Promise<{
  run: Awaited<ReturnType<typeof runGoldenCases>>[number]
  adapter: MockAdapter
}> {
  let adapter: MockAdapter | undefined
  const runs = await runGoldenCases([rosterCase(id)], async () => {
    const built = await build(id, script)
    adapter = built.adapter
    return built.harness
  })
  const [run] = runs
  if (run === undefined || adapter === undefined) throw new Error(`replaying ${id} produced no run`)
  return { run, adapter }
}

describe('the image a golden case attaches', () => {
  it('reaches the model as a real ImageBlock carrying an admitted reference', async () => {
    const { adapter } = await replayOne('image-observe-single-usable', SCRIPTS['image-observe-single-usable'] ?? [])

    const [block] = requestImageBlocks(adapter.requests[0] as GenerateOptions)
    expect(block?.type).toBe('image')
    // The reference is admission's, not this suite's: a digest, a media type, and
    // intrinsic dimensions the fixture really has.
    expect(String(block?.attachment.attachmentId)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(block?.attachment.mediaType).toBe('image/png')
    expect(block?.attachment.width).toBe(64)
    expect(block?.attachment.height).toBe(64)
    expect(block?.attachment.bytes).toBeGreaterThan(0)
  })

  it('carries the image and the text in ONE user message', async () => {
    const { adapter } = await replayOne('image-observe-single-usable', SCRIPTS['image-observe-single-usable'] ?? [])

    const carrying = (adapter.requests[0] as GenerateOptions).messages
      .filter(message => message.content.some(block => block.type === 'image'))
    expect(carrying).toHaveLength(1)
    expect(carrying[0]?.role).toBe('user')
    expect(carrying[0]?.content[0]).toEqual({ type: 'text', text: '我拍了一张照片，你看看' })
  })

  it('gives each fixture a neutral display name, so the name cannot hint at the content', async () => {
    const { adapter } = await replayOne('image-observe-single-usable', SCRIPTS['image-observe-single-usable'] ?? [])

    const [block] = requestImageBlocks(adapter.requests[0] as GenerateOptions)
    // The display name is positional, not descriptive: an observation case must
    // be decided on what the model can see, not on what the file is called.
    expect(block?.attachment.name).toBe('image-1.png')
    expect(block?.attachment.name).not.toContain('synthetic')
    expect(block?.attachment.name).not.toContain('visible-patch')
  })

  it('numbers two images rather than naming them after their fixtures', async () => {
    const { adapter } = await replayOne('image-observe-two-images', SCRIPTS['image-observe-two-images'] ?? [])

    const blocks = requestImageBlocks(adapter.requests[0] as GenerateOptions)
    expect(blocks.map(block => block.attachment.name)).toEqual(['image-1.png', 'image-2.png'])
  })

  it('resolves the golden image key to the attachment admission minted', async () => {
    const { run, adapter } = await replayOne(
      'image-observe-restatement-is-a-noop',
      SCRIPTS['image-observe-restatement-is-a-noop'] ?? [],
    )

    const [requested] = requestImageBlocks(adapter.requests[0] as GenerateOptions)
    for (const turn of run.evaluation.turns) {
      const [stored] = turn.imageObservations
      expect(stored?.imageKey).toBe('image-1')
      expect(stored?.attachmentId).toBe(String(requested?.attachment.attachmentId))
    }
  })

  it('keeps two images apart, in the order the case named them', async () => {
    const { run, adapter } = await replayOne('image-observe-two-images', SCRIPTS['image-observe-two-images'] ?? [])

    const requested = requestImageBlocks(adapter.requests[0] as GenerateOptions)
    expect(requested).toHaveLength(2)
    const [first, second] = requested
    expect(String(first?.attachment.attachmentId)).not.toBe(String(second?.attachment.attachmentId))

    const stored = run.evaluation.turns[0]?.imageObservations ?? []
    expect(stored.map(observation => observation.imageKey)).toEqual(['image-1', 'image-2'])
    expect(stored.map(observation => observation.attachmentId)).toEqual([
      String(first?.attachment.attachmentId),
      String(second?.attachment.attachmentId),
    ])
    // The second image is not lost behind the first: a single-slot store would
    // have replaced it, and this is the case that says so.
    expect(stored[1]?.findings).toEqual(['blue square'])
  })

  it('reads back the image the read call addressed', async () => {
    const { run } = await replayOne('image-observe-two-images', SCRIPTS['image-observe-two-images'] ?? [])

    // The case's second turn calls `medical_image_get` with the SECOND image's
    // id, and the turn leaves both observations standing.
    expect(run.evaluation.turns[1]?.toolCalls).toEqual(['medical_image_get'])
    expect(run.evaluation.turns[1]?.imageObservations.map(observation => observation.imageKey))
      .toEqual(['image-1', 'image-2'])
    expect(run.evaluation.passed).toBe(true)
  })

  it('records the image events with the session sequences that evidence them', async () => {
    const { run } = await replayOne('image-observe-single-usable', SCRIPTS['image-observe-single-usable'] ?? [])

    const [failureFree] = run.evaluation.turns[0]?.results ?? []
    expect(failureFree?.evidence.imageEventSeqs).toHaveLength(1)
  })

  it('appends no case record when a turn only observes an image', async () => {
    const { run } = await replayOne(
      'image-observe-keeps-the-case-untouched',
      SCRIPTS['image-observe-keeps-the-case-untouched'] ?? [],
    )

    const [before, after] = run.evaluation.turns
    expect(after?.caseState).toEqual(before?.caseState)
    expect(after?.caseState?.revision).toBe(1)
    expect(after?.imageObservations).toHaveLength(1)
    expect(run.evaluation.passed).toBe(true)
  })

  it('refuses a case with images when the harness mounts no attachment service', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(MedicalCaseService)
    const agent = await ctx.agentLoop.create(SessionId('no-attachments'), { provider: PROVIDER, model: 'mock' })

    await expect(runGoldenCases(
      [rosterCase('image-observe-single-usable')],
      () => ({ ctx, agent }),
    )).rejects.toThrow(/mounts no attachment service/)

    await ctx.fiber.dispose()
  })

  it('runs a text-only case on a harness that mounts no image domain', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(MedicalCaseService)
    await ctx.plugin(ToolMedicalCaseIntake)
    await ctx.plugin(ToolMedicalCaseUpdate)
    await ctx.plugin(ToolMedicalCaseGet)
    const adapter = new MockAdapter([...(SCRIPTS['intake-complete-first-contact'] ?? [])])
    ctx.llm.registerAdapter([PROVIDER], adapter)
    const agent = await ctx.agentLoop.create(SessionId('text-only'), { provider: PROVIDER, model: 'mock' })

    // A composition without the image domain is a legitimate text-only runtime,
    // so the runner reports no image rather than failing the case.
    const runs = await runGoldenCases([rosterCase('intake-complete-first-contact')], () => ({ ctx, agent }))

    expect(runs[0]?.evaluation.passed).toBe(true)
    expect(runs[0]?.evaluation.turns[0]?.imageObservations).toEqual([])
  })
})
