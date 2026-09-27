---
description: "The model-facing medical_image_observe tool: records the directly visible properties of one session image, with its quality limits and what could not be determined."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-image-observe

English | [中文](README.zh.md)

## Summary

`medical_image_observe` records what the model can DIRECTLY SEE in an image the user attached to the conversation. The model has already looked at the image — that is why the image was in its request — so the tool does not read the image, does not call a model, and does not re-derive anything from the bytes. It takes the model's structured account, hands it to `ctx.medicalImage`, and returns the authoritative observation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

---

<a id="use-this-package"></a>
## Use this package

Mount it beside the image domain, in a profile that governs tools per agent or per host.

```yaml
- id: medical-image
  name: '@deepseek-ai/dsh-medical-image'
- id: tool-medical-image-observe
  name: '@deepseek-ai/dsh-tool-medical-image-observe'
```

### What the model supplies

| Parameter | Required | Meaning |
| --- | --- | --- |
| `attachmentId` | yes | The id shown beside the image. Resolved against this session. |
| `usable` | yes | Whether any part of the image could be described. |
| `bodyRegion` | no | The region the image shows, as the model would describe it. |
| `findings` | no | Directly visible findings, one short phrase each. |
| `qualityIssues` | no | `blur`, `poor_lighting`, `occlusion`, `too_distant`, `unable_to_assess`. |
| `uncertainty` | no | What could not be determined from this image. |

There is no parameter for a media type, a byte length, or dimensions, and no parameter for a diagnosis, a disease, a treatment, a medication, a risk, or a confidence. The first group is the harness's to know; the second is not this tool's to record.

### What the harness does with it

The attachment id is resolved against the session's own derived transcript, and the persisted reference is the session's canonical `ImageAttachmentRef`. An id that was never attached here — including one belonging to another session — is refused with `IMAGE_ATTACHMENT_NOT_IN_SESSION`.

A submission that records nothing new appends no event and keeps the revision. Any other submission for the same attachment advances it by one revision.

### The visible-evidence boundary

The tool description states it, because that is where a model reads it immediately before calling:

- record only directly visible properties — colour, shape, size, distribution, surface appearance, swelling, discoloration;
- state image limitations and what could not be determined;
- set `usable` to false and say why rather than guessing when the image cannot be assessed;
- state no diagnosis, disease, treatment, medication, or risk judgement;
- never restate a finding as a patient-reported symptom.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin identity, the parameter schema, the output schema, and the rendering |
| — | No runtime invariant companion is published: the tool owns no lifecycle stream and appends no session event of its own, so there is no independent observation to reconcile. |

<a id="further-exploration"></a>
## Further Exploration

- [Medical image domain](../medical-image/README.md) — the service, the event, and the authorization rule.
- [Case intake tool](../tool-medical-case-intake/README.md) — the patient-reported half, and the pattern this tool follows.

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`medical_image_observe` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-image-observe): six parameters, two of them required, and a description that carries the visible-evidence boundary — record only directly visible properties, state quality limits and what could not be determined, and never state a diagnosis, a treatment, or a risk. A restatement that records nothing new returns the same record with `changed: false`, so the model can tell that nothing new was recorded.

#### Token effect

Fixed schema cost on every request where the tool is visible. It is the largest of the five medical tools, because its parameter descriptions carry the observation vocabulary.

#### KV Cache effect

Prefix-stable while the definition and its visibility are unchanged. Registering, disposing, or restricting the tool may invalidate reuse from this schema onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One observation per attachment** — a second observation of the same image replaces the first rather than sitting beside it.
- **Findings are free text** — a finding is recorded in the model's own words, so two runs can describe the same appearance differently. Nothing normalizes phrasing.
- **No confidence, and none wanted** — the contract has no field for it, and this phase does not add pseudo-precision.
- **The model must have seen the image** — the tool cannot describe an image the model was not shown, and it deliberately does not try: there is no second VLM call behind it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The tool holds no logic beyond argument marshalling. Validation, normalization, authorization, and persistence all live in `@deepseek-ai/dsh-medical-image`, so the rules are testable without a tool registry and cannot drift between the two entry points.

`qualityIssues` is constrained by the published schema AND validated again in the domain. The schema is the model-facing gate; the domain check is what a caller bypassing the tool still meets.

</details>
