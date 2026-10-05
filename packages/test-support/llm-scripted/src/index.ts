/**
 * A scripted model, for end-to-end runs that need a real runtime and no
 * provider.
 *
 * The harness's own replay plugin reconstructs model output from a recorded
 * session, which is the right tool when a recording exists. This one serves a
 * script written by hand, which is the right tool when the point is to drive a
 * runtime nobody has recorded yet: an end-to-end case can now exercise the real
 * agent loop, the real tool registry, and the real domain, with the model — and
 * only the model — standing in.
 *
 * The script is plain data rather than code, so a profile patch can carry it.
 * Nothing here knows about tools, sessions, or domains: it emits the stream
 * vocabulary and lets everything downstream be real.
 *
 * @module @deepseek-ai/dsh-llm-scripted
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, visitImageBlocks } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** One scripted model call: a line of text, or one tool call. */
export type ScriptStep =
  | { readonly text: string }
  | {
    /** Tool name the model "decides" to call. */
    readonly tool: string
    /** Arguments, exactly as the real tool schema expects them. */
    readonly args: Record<string, unknown>
    /** Optional text streamed before the call, as a real model often does. */
    readonly text?: string
  }

/** Plugin configuration: the route to serve, and the script to serve on it. */
export interface Config {
  /** Provider route this adapter answers. Any other route stays unresolved. */
  readonly provider: string
  /** Model id reported for the route; the agent's selection must name it. */
  readonly model: string
  /** Responses in call order. One entry is consumed per model call. */
  readonly steps: readonly ScriptStep[]
  /** Optional reasoning-effort levels to advertise; usually omitted. */
  readonly reasoningEfforts?: Record<string, string | null>
}

/** Stable Cordis plugin name. */
export const name = 'llm-scripted'

/** The runtime this adapter needs. */
export const inject = ['llm']

/**
 * The one request-derived token this adapter understands.
 *
 * A script is data, so it cannot call the request. This token is the whole
 * bridge: a value that IS this string is replaced by the canonical attachment
 * id of the newest image in the request. Nothing about it is medical — it names
 * an attachment, and a tool that takes an attachment id is not necessarily a
 * medical one.
 */
export const LATEST_IMAGE_ATTACHMENT_ID = '$latestImageAttachmentId'

/**
 * The newest image occurrence across a request, or undefined when there is none.
 *
 * Read through the shared visitor rather than by walking the block union here:
 * it already knows that images can sit inside tool results, and a second
 * traversal would be a second place for that knowledge to live.
 * @param options - the request being answered.
 * @returns the canonical attachment id, or undefined.
 */
function latestImageAttachmentId(options: GenerateOptions): string | undefined {
  let latest: string | undefined
  for (const message of options.messages) {
    visitImageBlocks(message.content, (block) => {
      latest = String(block.attachment.attachmentId)
    })
  }
  return latest
}

/**
 * Replace every value that IS the token, anywhere in the arguments.
 *
 * Exact match only: a value that merely contains the token is left alone, so
 * the substitution can never quietly rewrite a string somebody meant literally.
 * Object keys are never touched.
 * @param value - the scripted argument value.
 * @param resolved - the attachment id to substitute, or undefined when the
 *   request carries no image.
 * @returns the value with the token replaced.
 * @throws when the token is present and there is nothing to substitute.
 */
function substitute(value: unknown, resolved: string | undefined): unknown {
  if (value === LATEST_IMAGE_ATTACHMENT_ID) {
    if (resolved === undefined) {
      throw new Error(
        `llm-scripted: ${LATEST_IMAGE_ATTACHMENT_ID} requires an image block in the request`,
      )
    }
    return resolved
  }
  if (Array.isArray(value)) return value.map(entry => substitute(entry, resolved))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = substitute(entry, resolved)
    return out
  }
  return value
}

/** Substitute the request-derived tokens in one scripted call's arguments. */
function resolveArgs(args: Record<string, unknown>, options: GenerateOptions): Record<string, unknown> {
  // The request is only read when a token is actually present, so a script that
  // uses none behaves exactly as it did before this existed.
  const needsImage = JSON.stringify(args).includes(LATEST_IMAGE_ATTACHMENT_ID)
  const resolved = needsImage ? latestImageAttachmentId(options) : undefined
  return substitute(args, resolved) as Record<string, unknown>
}
/** Stream one line of text, then stop. */
function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Stream one tool call, optionally preceded by text.
 *
 * The arguments travel as deltas and then as the whole block, which is the
 * shape a real provider produces; a consumer that only read the final block
 * would pass here and fail against a real model.
 */
function toolChunks(callId: string, tool: string, args: Record<string, unknown>, text?: string): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let index = 0
  if (text !== undefined && text !== '') {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  const split = Math.min(5, argumentsJson.length)
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name: tool, argumentsDelta: argumentsJson.slice(0, split) },
    ...argumentsJson.length > split
      ? [{ type: 'tool-call-delta' as const, index, id, argumentsDelta: argumentsJson.slice(split) }]
      : [],
    { type: 'block-end', index, block: { type: 'tool-call', id, name: tool, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/**
 * The scripted adapter.
 *
 * It holds one queue and consumes one entry per call, which is what makes the
 * script follow the real loop: the tool result comes back as an ordinary
 * message, the loop asks again, and the next entry answers. Nothing here can
 * skip that round trip, because there is no other way to reach the next entry.
 */
export class ScriptedAdapter extends LlmAdapter {
  /** Every request served, in order — the case can assert on what the model saw. */
  readonly requests: GenerateOptions[] = []
  private readonly remaining: ScriptStep[]

  /**
   * @param config - the route to serve and the script to serve on it.
   */
  constructor(config: Config) {
    super()
    this.remaining = [...config.steps]
  }

  /**
   * Describe the route. A model the agent did not select never reaches here:
   * `registerAdapter` binds the provider, and the agent's own selection names
   * the model, so a mismatch fails before a stream is opened.
   * @param provider - the route being described.
   * @param model - the model id requested.
   * @returns the resolved model info.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Serve the next script entry.
   * @param options - the request being answered.
   * @returns the scripted chunks.
   * @throws when the script is exhausted, so a run that needs more turns fails
   *   loudly instead of silently producing an empty response.
   */
  // The interface is an async iterable and the script is synchronous; awaiting
  // something invented here would be noise, not backpressure.
  // oxlint-disable-next-line typescript/require-await -- see above.
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.remaining.shift()
    if (step === undefined) {
      throw new Error(
        `llm-scripted: script exhausted after ${this.requests.length} call(s); `
        + 'add another step or shorten the scenario',
      )
    }
    const chunks = 'text' in step
      ? textChunks(step.text)
      : toolChunks(`scripted-${this.requests.length}`, step.tool, resolveArgs(step.args, options), step.text)
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/**
 * Register the scripted route.
 * @param ctx - the context whose LLM runtime receives the adapter.
 * @param config - the route and script.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(
    () => ctx.llm.registerAdapter([config.provider], new ScriptedAdapter(config)),
    `llm-scripted: ${config.provider}`,
  )
}
