---
description: "The session-backed medical image observation domain: structured directly-visible findings, image quality limits, and a monotonic per-attachment revision."
kind: "package-reference"
---

# @deepseek-ai/dsh-medical-image

English | [中文](README.zh.md)

## Summary

`ctx.medicalImage` owns what the model observed in the images a session carries. It is the second medical domain, and deliberately not the first: `dsh-medical-case` records what the patient reported, this records what the model saw. Every mutation appends a complete `medical/image-observation` event to the owning session log and reads the value back from a registry-driven projection, so persistence, resume, and fork inheritance come from the harness, not a second store.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

---

<a id="use-this-package"></a>
## Use this package

The domain is a host service. Mount it in the layer that owns the profile, and mount the tools that speak to it.

### Two domains, one session

```
Medical Consultation
├── Patient Report      → medicalCase  → medical/case-change
└── Model-observed Evidence → medicalImage → medical/image-observation
```

The two never write to each other. Nothing in this package imports the case domain, and no code path here can reach `CaseState`: a visible finding is evidence, and a finding is not something the patient said. `medical-image`'s own test suite asserts that recording an observation leaves the case record and the case event stream untouched.

### Authorization: the session is the authority

`observe` takes an attachment id and nothing else it trusts. The canonical `ImageAttachmentRef` — media type, byte length, width, height — is taken from the session's own user message, never from the caller, so a caller cannot assert metadata for an image the harness never admitted.

```
attachmentId
  → agent.session.deriveMessages()      (the model-visible transcript)
  → the first USER message carrying that attachment
  → the canonical ImageAttachmentRef     (persisted)
```

An id this session never carried is refused, and so is an id belonging to another session: both answer `IMAGE_ATTACHMENT_NOT_IN_SESSION`, because distinguishing them would report which ids exist elsewhere.

### Revision semantics

| Situation | Result |
| --- | --- |
| First observation of an attachment | one `observe` event, revision 1 |
| The same fields recorded again | **no event**, no revision change |
| A recorded field changes | one `update` event, revision + 1 |
| Several attachments in one session | one observation each, addressed by attachment |

The revision counts durable changes, not tool calls, so a restatement that records nothing new cannot inflate it.

### Reading

`list` returns every observation in first-observation order; `get` and `require` read one by attachment. There is deliberately no "current observation": a single slot would make the second image unreadable the moment a third arrived.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Source map

| File | Responsibility |
| --- | --- |
| `types.ts` | The pure vocabulary and the ONE home of the `medicalImage` projection-key declaration |
| `domain.ts` | The durable change payload and the stable rejection codes |
| `runtime.ts` | Version constant, the quality-issue union, the domain error |
| `observation.ts` | Pure normalization and the no-op comparison |
| `fold.ts` | Strict decoding and the replay fold |
| `index.ts` | `MedicalImageService`, the projection unit, and attachment resolution |
| — | No runtime invariant companion is published: the fold that validates the durable stream is the same fold the projection registry drives, so no second observation of the same relationship can diverge. |

### Why the event carries the whole observation

Every mutation writes the complete `MedicalImageObservation`, including the canonical attachment reference and the revision. A reader that folds only the latest event still holds the authoritative record, and a cold replay never needs the transcript: the durable stream alone answers what was observed, at which revision, for which image.

### Strict replay

`decodeMedicalImageChange` rejects anything it cannot interpret exactly: an unsupported version, an unknown operation, a blank or non-normalized string, a media type outside the admitted set, non-positive dimensions, a quality issue outside the union, issues out of canonical order or duplicated, and an update that precedes its own creation. The projection unit latches the first failure and reports it on every later read rather than skipping the record — a store that cannot read its own stream must not look like a store that recorded nothing.

### Where the clock is read

`Date.now()` is read once at the service boundary, and only there. The fold validates that an update never moves the mutation time backwards, which keeps replay deterministic without making the domain depend on a clock it does not own.

### Why the attachment walk lives in `dsh-llm`

Resolving an id walks nested tool-result content as well as top-level blocks, using `visitImageBlocks` from `@deepseek-ai/dsh-llm`. That module publishes the one recursive image walk the harness uses, so this consumer cannot diverge from the rest of the runtime on nesting depth.

<a id="further-exploration"></a>
## Further Exploration

- [Medical case domain](../medical-case/README.md) — the patient-reported half, and the pattern this package follows.
- [Attachment service](../../attachment/attachment/README.md) — `ImageAttachmentRef` and the durable image object.
- [LLM content helpers](../../llm/llm/README.md) — `visitImageBlocks`, image projections, and the text-only placeholder.
- [MedHarness runtime](../../../medharness/README.md) — the composition that mounts this domain.

<a id="model-experience"></a>
## Model Experience

None, as this package registers no model-visible content: it publishes a host service and one projection, and the tools that speak to it are separate packages. The projection is host-only because the folded value carries clinical free text and durable attachment references.

#### KV Cache effect

None. Nothing here enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One observation per attachment** — the attachment is the identity, so a second, differently-scoped observation of the same image replaces the first rather than sitting beside it. Several images work; several readings of one image do not yet.
- **No cross-image synthesis** — an observation describes one image. Nothing relates two images to each other, and nothing relates an observation to the case.
- **The quality union is closed** — five named limitations, versioned with the payload. A deployment that needs another one raises the payload version rather than sending free text.
- **No confidence, severity, or diagnosis** — by design, and enforced by the contract: there is no field for a clinical conclusion, and the tool schema names none.
- **Nothing is clustered or scored** — observations are recorded and read back; no aggregate, trend, or comparison exists yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`packages/core/**` is untouched by this package. Everything it needs — `AttachmentStore`, `ImageAttachmentRef`, `ImageBlock`, `Session.deriveMessages()`, `SessionProjectionRegistry` — already existed.

The authorization seam is `Session.deriveMessages()`, NOT `snapshotEvents()`. The synchronous history readers (`eventAt`, `snapshotEvents`, `ownEvents`) are deprecated for new callers by [the Agent Note](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md); the older `imageBlockIn` / `referencedImage` helpers in `packages/api/session-controller` are built on the deprecated reader and are not a model to copy.

`src/index.ts` is not a pure re-export module — it holds the service and the projection unit — so the per-file coverage gate applies to it in full.

</details>
