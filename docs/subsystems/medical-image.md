# Medical image observation

English | [中文](medical-image.zh.md)

The model-observed half of a medical consultation. A session's patient-reported facts live in the [medical intake case](medical-case.md); what the model could see in an attached image lives here. The two are separate domains on purpose: a visible finding is evidence, not a statement the patient made, and nothing in this domain can reach a case field.

The domain stores nothing of its own. Every observation is a durable `medical/image-observation` session event, and the current value is a projection over those events, so persistence, resume, and fork inheritance come from the session log rather than a second store.

## Identity and lifecycle

An observation is identified by its attachment. `ImageAttachmentRef.attachmentId` is content-addressed, so one image can never be observed under two identities, and a second id field would only be a second key to keep consistent. Several images in one session are several observations, each addressed by its own attachment.

A session may hold many observations. There is deliberately no single "current" observation: a one-slot store would make the second image unreadable the moment a third arrived.

The observation itself is immutable. A restatement that records nothing new appends no event; a restatement that changes a recorded field appends one and advances the revision.

## Durable state

Every mutation writes the complete observation, never a patch:

| Field | Meaning |
| --- | --- |
| `attachment` | The canonical `ImageAttachmentRef`, taken from the session's own user message |
| `revision` | Positive; 1 on the first observation of this attachment |
| `bodyRegion` | The region the image shows, as the observer phrased it, or null |
| `findings` | Directly visible findings, in first-seen order, without duplicates |
| `quality` | Whether the image could be described, and the limitations that bounded it |
| `uncertainty` | What the observer could not determine from this image |
| `createdAt` / `updatedAt` | Epoch milliseconds of the first and latest observation |

There is no confidence, no severity, and no diagnosis. The contract has no field for a clinical conclusion, and the tool that produces observations names none.

The quality union is closed — `blur`, `poor_lighting`, `occlusion`, `too_distant`, `unable_to_assess` — and the issues are stored in canonical order. A deployment needing another limitation raises the payload version rather than sending free text, so two runs that record the same limitation are comparable.

## Authorization

The canonical reference is never supplied by the caller. `observe` takes an attachment id, resolves it against the session's derived model-visible transcript, and persists the reference the session's own message carried.

An id the session never carried is refused, and so is an id belonging to another session: both answer `IMAGE_ATTACHMENT_NOT_IN_SESSION`, because distinguishing them would report which ids exist elsewhere. When one attachment occurs more than once, the first occurrence in derived-message order wins; that is deterministic and cannot change the stored value, because every occurrence of a content-addressed id describes the same immutable object.

## Service behavior

[`MedicalImageService`](../../packages/medical/medical-image/src/index.ts) accepts only the exact live `Agent` object registered under its id, reads the strict replay result from the `medicalImage` projection on `ctx.sessionProjections`, and appends complete `medical/image-observation` session events. It never reads image bytes and never calls a model: the VLM has already looked at the image, which is why the image was in its request.

Failures are loud from two directions. Strict decoding rejects any malformed or inconsistent record and latches the failure into the projection state, so later reads report the same durable fault instead of silently skipping it. The domain boundary rejects invalid requests with stable error codes. The package [README](../../packages/medical/medical-image/README.md) defines the callable API and the model-facing conventions.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmedicalimage--medicalimageservice"></a>

### `ctx.medicalImage` — `MedicalImageService`

The medical image service (`ctx.medicalImage`), backed exclusively by the owning session log. Every mutation appends a full-state `medical/image-observation` event and returns the resulting authoritative observation; a restatement that changes no recorded field appends no event and keeps the revision.

The service never reads image bytes and never calls a model. Authorization is answered from the session's derived transcript, which is the same surface the model was shown: a caller can only cite an image it could actually have seen.

```ts cordis-catalog
/**
 * List every observation recorded for one exact live agent, in first-observation order.
 * @param agent - owning live agent.
 * @returns a fresh array; empty when nothing has been observed.
 * @throws {@link MedicalImageError} when the agent is not the registry's live instance.
 */
list(agent: Agent): readonly MedicalImageObservation[]

/**
 * Read one attachment's observation.
 * @param agent - owning live agent.
 * @param attachmentId - the attachment to read.
 * @returns a fresh view, or `undefined` when this session has not observed it.
 * @throws {@link MedicalImageError} when the agent is not live or the stream is invalid.
 */
get(agent: Agent, attachmentId: string): MedicalImageObservation | undefined

/**
 * Read one attachment's observation, failing when this session has none.
 * @param agent - owning live agent.
 * @param attachmentId - the attachment to read.
 * @returns a fresh view.
 * @throws {@link MedicalImageError} when nothing has been observed for it.
 */
require(agent: Agent, attachmentId: string): MedicalImageObservation

/**
 * Record what the model saw in one image the session already holds.
 *
 * The canonical reference comes from the session, never from the request: the
 * request carries only the attachment id, and a media type, byte length, or
 * dimension it may also have sent is ignored. An id this session never carried
 * is refused with {@link ImageErrorCodes.IMAGE_ATTACHMENT_NOT_IN_SESSION},
 * which is also the answer for another session's attachment — naming the
 * difference would report which ids exist elsewhere.
 *
 * A restatement that records nothing new is a no-op: no event, no revision
 * change. Any other restatement of the same attachment advances it by one
 * revision, so the revision counts durable changes rather than tool calls.
 * @param agent - owning live agent.
 * @param request - the model-supplied observation.
 * @returns the authoritative observation and whether it changed.
 * @throws {@link MedicalImageError} when the agent is not live, the attachment is
 * not in this session, or a field cannot be represented durably.
 */
observe(agent: Agent, request: ImageObservationRequest): ImageObservationResult
```

Types: [Agent](core.md)

Source: [`packages/medical/medical-image/src/index.ts`](../../packages/medical/medical-image/src/index.ts)
<!-- END GENERATED cordis-surface -->
