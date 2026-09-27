/**
 * Session-backed medical image observation domain: durable structured
 * observations of the images the model was shown, carried by the owning session
 * log, and the strict projection the registry drives on every committed event.
 *
 * The domain owns the contract only. Durability, resume, and fork inheritance
 * are the harness session log's business (`dsh-session`), and the per-session
 * fold cell is `dsh-session-projection`'s — this package adds no store of its
 * own, so an observation can never disagree with the log it lives in.
 *
 * ## What this domain is not
 *
 * It is not the case domain. `medical-case` records patient-reported facts;
 * this records model-observed evidence. A visible finding never becomes a
 * reported symptom, and nothing here can reach `CaseState`: the two domains own
 * different session events and neither imports the other. That separation is the
 * point of the phase, so it is enforced by the types rather than by convention.
 *
 * It also never calls a model. The VLM already looked at the image — that is why
 * the image was in the request — and this domain only records what the model
 * said it saw, validates it, and returns it as authoritative state.
 *
 * @module @deepseek-ai/dsh-medical-image
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { visitImageBlocks } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { applyMedicalImageEvent } from './fold.ts'
import type { MedicalImageFoldState } from './fold.ts'
import { recordsSameObservation, resolveObservationFields } from './observation.ts'
import { IMAGE_QUALITY_ISSUES, MEDICAL_IMAGE_OBSERVATION_VERSION, MedicalImageError } from './runtime.ts'
import type { MedicalImageChangeMeta } from './domain.ts'
import type {
  ImageObservationOperation,
  ImageObservationRequest,
  ImageObservationResult,
  MedicalImageObservation,
  MedicalImageProjectionState,
} from './types.ts'

// The pure type outlet (./types.ts, ONE home of the `medicalImage` projection-key
// declaration) is re-exported onto the package root so the emitted index.d.ts
// keeps the module edge, and aggregate programs consuming the declarations still
// receive the SessionProjectionStateMap merge.
export type * from './types.ts'
export type * from './domain.ts'
export { IMAGE_QUALITY_ISSUES, MEDICAL_IMAGE_OBSERVATION_VERSION, MedicalImageError } from './runtime.ts'
export {
  applyMedicalImageChange,
  applyMedicalImageEvent,
  decodeMedicalImageChange,
  emptyMedicalImageFoldState,
  foldMedicalImage,
  imageReplayError,
  sameAttachmentRef,
} from './fold.ts'
export type { MedicalImageFoldState } from './fold.ts'
export {
  normalizeImageQuality,
  normalizeObservationText,
  recordsSameObservation,
  requireObservationBodyRegion,
  resolveObservationFields,
} from './observation.ts'
export type { ResolvedObservationFields } from './observation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    medicalImage: MedicalImageService
  }
}

const imageAttachmentSchema = zod.object({
  attachmentId: zod.string().min(1),
  mediaType: zod.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: zod.number().int().positive(),
  width: zod.number().int().positive(),
  height: zod.number().int().positive(),
  name: zod.string().min(1).optional(),
  originalDimensions: zod.object({
    width: zod.number().int().positive(),
    height: zod.number().int().positive(),
  }).strict().optional(),
}).strict()

const imageObservationSchema = zod.object({
  attachment: imageAttachmentSchema,
  revision: zod.number().int().positive(),
  bodyRegion: zod.string().min(1).nullable(),
  findings: zod.array(zod.string().min(1)),
  quality: zod.object({
    usable: zod.boolean(),
    issues: zod.array(zod.enum(IMAGE_QUALITY_ISSUES)),
  }).strict(),
  uncertainty: zod.array(zod.string().min(1)),
  createdAt: zod.number(),
  updatedAt: zod.number(),
}).strict()

/**
 * Strict checkpoint schema for the `medicalImage` projection.
 *
 * Exported for its own test rather than for callers: the registry validates
 * persisted checkpoint rows through it, and a state carrying two observations of
 * one attachment is exactly the kind of corruption that check exists to refuse.
 */
export const medicalImageProjectionStateSchema: ZodType<MedicalImageProjectionState> = zod.object({
  observations: zod.array(imageObservationSchema),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  const ids = state.observations.map(observation => observation.attachment.attachmentId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'observations must be unique by attachment' })
  }
}) as unknown as ZodType<MedicalImageProjectionState>

/** Build the strict fold state from one checkpoint-safe projection state. */
function foldStateFromProjection(state: MedicalImageProjectionState): MedicalImageFoldState {
  return {
    observations: new Map(state.observations.map(observation => [String(observation.attachment.attachmentId), observation])),
  }
}

/** Convert strict fold state into checkpoint-safe projection state. */
function projectionStateFromFold(state: MedicalImageFoldState): MedicalImageProjectionState {
  return { observations: [...state.observations.values()], failure: null }
}

/**
 * Drive the strict image fold from one committed session event. A unit
 * uninterested in the event returns the same state reference, so the registry
 * performs no downstream work; the first malformed record latches a failure that
 * every later read reports instead of silently skipping it.
 * @param state - projection state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection state, or the same reference when it did not change.
 */
export function applyMedicalImageProjection(
  state: MedicalImageProjectionState,
  event: SessionEvent,
): MedicalImageProjectionState {
  if (state.failure !== null) return state
  if (event.type !== 'medical/image-observation') return state
  const folded = foldStateFromProjection(state)
  try {
    applyMedicalImageEvent(folded, event)
    return projectionStateFromFold(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- strict decoding throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `medical image replay failed at session event ${event.seq}: ${message}` }
  }
}

/**
 * The `medicalImage` projection unit: host-only, because the folded value carries
 * clinical free text and durable attachment references that no client wire
 * surface should carry.
 *
 * Bump {@link medicalImageProjectionDefinition.stateVersion} whenever the
 * serialized fields or the fold semantics change, so persisted checkpoint rows
 * from an older unit are discarded rather than forward-applied.
 */
export const medicalImageProjectionDefinition = {
  key: 'medicalImage',
  stateSchema: medicalImageProjectionStateSchema,
  init: (): MedicalImageProjectionState => ({ observations: [], failure: null }),
  apply: applyMedicalImageProjection,
  stateVersion: 1,
} satisfies ProjectionDefinition<'medicalImage', MedicalImageProjectionState>

/**
 * Find the canonical reference for one attachment among derived messages.
 *
 * This is the authorization seam. The reference that gets persisted is never the
 * caller's: it is the one the session's own message carried, so a caller cannot
 * assert a media type, a byte length, or dimensions the harness never admitted.
 *
 * The scan is limited to USER messages because that is the only role an image can
 * occupy — the production adapters declare text-only output, so a model cannot
 * put an image into the transcript. It walks nested tool-result content as well
 * as top-level blocks, using the one recursive image walk `dsh-llm` publishes, so
 * this consumer cannot diverge from the harness on nesting depth.
 *
 * When the same attachment occurs more than once, the FIRST occurrence in
 * derived-message order wins. That is deterministic, and it cannot change what
 * gets stored: `attachmentId` is content-addressed, so every occurrence of one id
 * describes the same immutable object and the same reference.
 * @param messages - the session's derived model-visible history.
 * @param attachmentId - the id a caller claims it saw.
 * @returns the canonical reference, or undefined when this session never carried it.
 */
export function canonicalImageAttachment(
  messages: readonly Message[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const matches: ImageAttachmentRef[] = []
    visitImageBlocks(message.content, (block) => {
      if (String(block.attachment.attachmentId) === attachmentId) matches.push(block.attachment)
    })
    if (matches.length > 0) return matches[0]
  }
  return undefined
}

/**
 * The medical image service (`ctx.medicalImage`), backed exclusively by the
 * owning session log. Every mutation appends a full-state
 * `medical/image-observation` event and returns the resulting authoritative
 * observation; a restatement that changes no recorded field appends no event and
 * keeps the revision.
 *
 * The service never reads image bytes and never calls a model. Authorization is
 * answered from the session's derived transcript, which is the same surface the
 * model was shown: a caller can only cite an image it could actually have seen.
 */
export class MedicalImageService extends Service {
  static inject = ['agents', 'sessionProjections']

  /**
   * @param ctx - context carrying the agent registry and the projection registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'medicalImage')
    ctx.sessionProjections.register(medicalImageProjectionDefinition)
  }

  /**
   * List every observation recorded for one exact live agent, in first-observation order.
   * @param agent - owning live agent.
   * @returns a fresh array; empty when nothing has been observed.
   * @throws {@link MedicalImageError} when the agent is not the registry's live instance.
   */
  list(agent: Agent): readonly MedicalImageObservation[] {
    this.assertLive(agent)
    return this.observations(agent.session)
  }

  /**
   * Read one attachment's observation.
   * @param agent - owning live agent.
   * @param attachmentId - the attachment to read.
   * @returns a fresh view, or `undefined` when this session has not observed it.
   * @throws {@link MedicalImageError} when the agent is not live or the stream is invalid.
   */
  get(agent: Agent, attachmentId: string): MedicalImageObservation | undefined {
    this.assertLive(agent)
    return this.observations(agent.session)
      .find(observation => String(observation.attachment.attachmentId) === attachmentId)
  }

  /**
   * Read one attachment's observation, failing when this session has none.
   * @param agent - owning live agent.
   * @param attachmentId - the attachment to read.
   * @returns a fresh view.
   * @throws {@link MedicalImageError} when nothing has been observed for it.
   */
  require(agent: Agent, attachmentId: string): MedicalImageObservation {
    const found = this.get(agent, attachmentId)
    if (found === undefined) {
      throw new MedicalImageError(
        `this session has no observation for attachment ${JSON.stringify(attachmentId)}`,
        'IMAGE_OBSERVATION_NOT_FOUND',
      )
    }
    return found
  }

  /**
   * Record what the model saw in one image the session already holds.
   *
   * The request is a FULL SNAPSHOT: every field is present, and each accepted call
   * declares the whole current observation for that attachment. There is no
   * "preserve the previous value" behaviour — an omitted field never reaches here,
   * because the published schema requires it — so a restatement cannot silently
   * drop a finding the caller forgot to repeat.
   *
   * The canonical reference comes from the session, never from the request: the
   * request carries only the attachment id, and a media type, byte length, or
   * dimension it may also have sent is ignored. An id this session never carried
   * is refused with {@link ImageErrorCode.IMAGE_ATTACHMENT_NOT_IN_SESSION}, which
   * is also the answer for another session's attachment — naming the difference
   * would report which ids exist elsewhere.
   *
   * A restatement that records nothing new is a no-op: no event, no revision
   * change. Any other restatement of the same attachment advances it by one
   * revision, so the revision counts durable changes rather than tool calls. The
   * attachment itself is immutable across an update; the fold refuses a record
   * that rewrites it.
   * @param agent - owning live agent.
   * @param request - the model-supplied full snapshot.
   * @returns the authoritative observation and whether it changed.
   * @throws {@link MedicalImageError} when the agent is not live, the attachment is
   * not in this session, or a field cannot be represented durably.
   */
  observe(agent: Agent, request: ImageObservationRequest): ImageObservationResult {
    this.assertLive(agent)
    const attachment = canonicalImageAttachment(agent.session.deriveMessages(), request.attachmentId)
    if (attachment === undefined) {
      throw new MedicalImageError(
        `this session has no user image with attachment ${JSON.stringify(request.attachmentId)}; `
        + 'observe an image the user actually attached to this conversation',
        'IMAGE_ATTACHMENT_NOT_IN_SESSION',
      )
    }
    const fields = resolveObservationFields(request)
    const current = this.observations(agent.session)
      .find(observation => String(observation.attachment.attachmentId) === request.attachmentId)
    const now = Date.now()
    if (current === undefined) {
      return this.commit(agent, 'observe', { attachment, revision: 1, ...fields, createdAt: now, updatedAt: now })
    }
    if (recordsSameObservation(current, fields)) return { view: current, changed: false }
    return this.commit(agent, 'update', {
      attachment,
      revision: current.revision + 1,
      ...fields,
      createdAt: current.createdAt,
      updatedAt: now,
    })
  }

  /** Reject callers that are not the exact instance this registry hosts. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new MedicalImageError(`agent "${agent.id}" is not live in this registry`, 'IMAGE_AGENT_NOT_LIVE')
    }
  }

  /** Read the current durable projection maintained by the registry. */
  private observations(session: Session): readonly MedicalImageObservation[] {
    const state = this.ctx.sessionProjections.stateOf(session, 'medicalImage')
    /* v8 ignore next -- static inject requires the projection registry before this service activates */
    if (state === undefined) throw new Error('medicalImage projection is not registered')
    if (state.failure !== null) throw new MedicalImageError(state.failure, 'IMAGE_STREAM_INVALID')
    return state.observations
  }

  /**
   * Append one durable change and return the state the fold derived from it, so a
   * producer/fold disagreement surfaces at the mutation that caused it rather than
   * at a later read.
   */
  private commit(
    agent: Agent,
    operation: ImageObservationOperation,
    next: MedicalImageObservation,
  ): ImageObservationResult {
    const change: MedicalImageChangeMeta = {
      kind: 'medical/image-observation',
      version: MEDICAL_IMAGE_OBSERVATION_VERSION,
      operation,
      observation: next,
    }
    agent.session.append('medical/image-observation', change)
    const committed = this.observations(agent.session)
      .find(observation => String(observation.attachment.attachmentId) === String(next.attachment.attachmentId))
    /* v8 ignore next -- the change just committed is the latest record for this attachment */
    if (committed === undefined) throw new Error('medical image observation committed without establishing one')
    return { view: committed, changed: true }
  }
}

export default MedicalImageService
