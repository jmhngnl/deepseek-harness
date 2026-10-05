/**
 * The scripted adapter's own contract.
 *
 * These cases exist because the adapter is the ONLY stand-in in a populated
 * end-to-end run: if it silently served a wrong script, or fell through to a
 * real provider when it ran out, the end-to-end case would pass for the wrong
 * reason. So the failures it must produce loudly are asserted here, where the
 * assertion can name them.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ScriptedAdapter, apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** A request shape the adapter only reads for cancellation. */
function options(): GenerateOptions {
  return { messages: [], signal: undefined } as unknown as GenerateOptions
}

/** Drain a stream into a list. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const CONFIG: Config = { provider: 'test-route', model: 'test-model', steps: [] }

describe('ScriptedAdapter', () => {
  it('streams a text step as deltas and a closing block', async () => {
    const adapter = new ScriptedAdapter({ ...CONFIG, steps: [{ text: 'hi' }] })
    const chunks = await collect(adapter.stream(options()))
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('streams a tool call whose arguments arrive as deltas', async () => {
    const adapter = new ScriptedAdapter({
      ...CONFIG,
      steps: [{ tool: 'medical_case_intake', args: { symptoms: ['头疼'], duration: '两天' } }],
    })
    const chunks = await collect(adapter.stream(options()))
    // The final block is the whole call, and the deltas before it reconstruct
    // the same JSON — the shape a real provider produces.
    const block = chunks.find(chunk => chunk.type === 'block-end')
    expect(block).toMatchObject({
      block: { type: 'tool-call', name: 'medical_case_intake' },
    })
    const deltas = chunks
      .filter(chunk => chunk.type === 'tool-call-delta')
      .map(chunk => (chunk as { argumentsDelta: string }).argumentsDelta)
      .join('')
    expect(JSON.parse(deltas)).toEqual({ symptoms: ['头疼'], duration: '两天' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('serves the next step on the next call, which is what follows a tool result', async () => {
    const adapter = new ScriptedAdapter({
      ...CONFIG,
      steps: [{ tool: 'a', args: {} }, { text: 'and then' }],
    })
    await collect(adapter.stream(options()))
    const second = await collect(adapter.stream(options()))
    // There is no way to reach the second entry except by making a second call,
    // which is exactly the round trip a tool result forces.
    expect(second.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(adapter.requests).toHaveLength(2)
  })

  it('fails loudly when the script is exhausted', async () => {
    const adapter = new ScriptedAdapter({ ...CONFIG, steps: [{ text: 'only' }] })
    await collect(adapter.stream(options()))
    // An empty response would look like a model with nothing to say; a run that
    // needs another turn must be told the script is short.
    await expect(collect(adapter.stream(options()))).rejects.toThrow(/script exhausted/)
  })

  it('reports the route it was configured for', async () => {
    const adapter = new ScriptedAdapter(CONFIG)
    await expect(adapter.resolveModel('test-route', 'test-model'))
      .resolves.toMatchObject({ provider: 'test-route', id: 'test-model' })
  })
})

describe('llm-scripted plugin', () => {
  it('registers its route and releases it on disposal', async () => {
    const ctx = new Context()
    const registerAdapter = vi.fn((_routes: string[], _adapter: unknown) => () => {})
    ctx.provide('llm', { registerAdapter } as never)

    const fiber = ctx.plugin({ inject: ['llm'], apply }, { ...CONFIG, steps: [{ text: 'x' }] })
    await fiber.await()
    expect(registerAdapter).toHaveBeenCalledTimes(1)
    // The route list is the binding: a different provider must not be answered
    // by this adapter, which is what keeps a stray real call from being served.
    expect(registerAdapter.mock.calls[0]?.[0]).toEqual(['test-route'])

    await fiber.dispose()
  })
})

/** A request carrying the given image attachment ids, in message order. */
function requestWithImages(...ids: string[]): GenerateOptions {
  return {
    messages: [{ role: 'user', content: ids.map(id => ({
      type: 'image',
      attachment: { attachmentId: id, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    })) }],
    signal: undefined,
  } as unknown as GenerateOptions
}

/** The arguments of the first tool call in a drained stream. */
function callArgs(chunks: StreamChunk[]): Record<string, unknown> {
  const block = chunks.find(chunk => chunk.type === 'block-end') as { block: { arguments: string } }
  return JSON.parse(block.block.arguments) as Record<string, unknown>
}

describe('request-derived attachment ids', () => {
  const TOKEN = '$latestImageAttachmentId'

  it('replaces a top-level value that is exactly the token', async () => {
    const adapter = new ScriptedAdapter({ ...CONFIG, steps: [{ tool: 't', args: { attachmentId: TOKEN } }] })
    const args = callArgs(await collect(adapter.stream(requestWithImages('sha256:aaa'))))
    expect(args).toEqual({ attachmentId: 'sha256:aaa' })
  })

  it('replaces the token nested in objects and arrays', async () => {
    const adapter = new ScriptedAdapter({
      ...CONFIG,
      steps: [{ tool: 't', args: { outer: { id: TOKEN }, list: [1, TOKEN, 'kept'] } }],
    })
    const args = callArgs(await collect(adapter.stream(requestWithImages('sha256:bbb'))))
    expect(args).toEqual({ outer: { id: 'sha256:bbb' }, list: [1, 'sha256:bbb', 'kept'] })
  })

  it('takes the LAST image when the request carries several', async () => {
    const adapter = new ScriptedAdapter({ ...CONFIG, steps: [{ tool: 't', args: { attachmentId: TOKEN } }] })
    const args = callArgs(await collect(adapter.stream(requestWithImages('sha256:first', 'sha256:last'))))
    expect(args).toEqual({ attachmentId: 'sha256:last' })
  })

  it('fails loudly when the token is present and no image is', async () => {
    const adapter = new ScriptedAdapter({ ...CONFIG, steps: [{ tool: 't', args: { attachmentId: TOKEN } }] })
    // An empty string or a null would let the tool be called with a value that
    // was never an attachment, and the domain would reject it for the wrong
    // reason. The script is wrong; say so.
    await expect(collect(adapter.stream(options()))).rejects.toThrow(/requires an image block/)
  })

  it('does not rewrite a string that merely contains the token', async () => {
    const adapter = new ScriptedAdapter({
      ...CONFIG,
      steps: [{ tool: 't', args: { note: `prefix-${TOKEN}` } }],
    })
    const args = callArgs(await collect(adapter.stream(requestWithImages('sha256:ccc'))))
    expect(args).toEqual({ note: `prefix-${TOKEN}` })
  })

  it('leaves arguments without the token byte-for-byte alone', async () => {
    const args = { symptoms: ['头疼'], duration: '两天' }
    const adapter = new ScriptedAdapter({ ...CONFIG, steps: [{ tool: 't', args }] })
    // No image in the request either: a script that never mentions the token
    // must not start requiring one.
    expect(callArgs(await collect(adapter.stream(options())))).toEqual(args)
  })
})
