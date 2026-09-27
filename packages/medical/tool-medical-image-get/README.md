---
description: "The model-facing medical_image_get tool: reads the authoritative image observations a session has already recorded, addressed by attachment."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-image-get

English | [中文](README.zh.md)

## Summary

`medical_image_get` reads the image observations this session has already recorded. This is the explicit read path: observations are durable session state that survives resume and fork, so an agent that needs them asks for them here rather than relying on its conversation history to remember what it saw.

The read is addressed by attachment, never by recency. A session may hold several images, and an API that returned only the most recent one would make the second image unreadable the moment a third arrived.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

---

<a id="use-this-package"></a>
## Use this package

Mount it beside the image domain and the observation tool.

```yaml
- id: tool-medical-image-get
  name: '@deepseek-ai/dsh-tool-medical-image-get'
```

### Parameters

| Parameter | Required | Meaning |
| --- | --- | --- |
| `attachmentId` | no | Read one attachment. Omit to list every image observed in this conversation. |

### Results

The result is always a list, so one call shape covers both readings. Naming an attachment this session has no observation for fails with `IMAGE_OBSERVATION_NOT_FOUND` rather than returning an empty list, which would be indistinguishable from "nothing was ever observed".

Reading changes nothing: no event is appended and no revision moves.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin identity, the optional parameter root, the list output schema, and the rendering |
| — | No runtime invariant companion is published: the tool only reads a projection and appends nothing, so there is no independent observation to reconcile. |

<a id="further-exploration"></a>
## Further Exploration

- [Medical image domain](../medical-image/README.md) — the service, the event, and the authorization rule.
- [Observation tool](../tool-medical-image-observe/README.md) — the write path this reads back.
- [Case read tool](../tool-medical-case-get/README.md) — the same read pattern for the patient-reported half.

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`medical_image_get` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-image-get): one optional `attachmentId` and a list output schema, so one call shape covers both reading one image and listing every observed image.

#### Token effect

Fixed schema cost on every request where the tool is visible; it is the smaller of the two image tools, because it declares a single optional parameter.

#### KV Cache effect

Prefix-stable while the definition and its visibility are unchanged. Registering, disposing, or restricting the tool may invalidate reuse from this schema onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No filtering beyond the attachment id** — there is no query by body region, by usability, or by revision.
- **No history of an observation** — the read returns the current revision. Earlier revisions stay in the session log but are not reachable through this tool.
- **Nothing crosses sessions** — the tool reads only the calling session, and an attachment from another session is simply absent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The list shape is deliberate. A "get the latest observation" tool would read more simply and would silently drop every earlier image, which is exactly the failure mode this phase's multi-image requirement exists to prevent.

</details>
