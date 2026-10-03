---
description: "The MedHarness intake page for the dsh web client: the right Sidebar tab that shows the patient-reported record beside the model-observed image evidence, as two panels that never share an accent."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-medharness

English | [中文](README.zh.md)

## Summary

The MedHarness intake page: a right-Sidebar tab type that answers the two questions a consultation transcript makes hard to check — what have I actually told it, and what did it see in my photo. It registers a tab type, its copy, and its body, and nothing else: both values it draws are session projections the host already folds, so the browser contributes no data path of its own.

## Table of Contents

- [What it registers](#what-it-registers)
- [The two panels](#the-two-panels)
- [Where the data comes from](#where-the-data-comes-from)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

Three contributions, all through the public seats:

| Seat | What goes in |
|---|---|
| `ctx.sidebarRightTabs` | The `medharness` tab type, reached from the right Sidebar's guide |
| `sidebar.right.pane.tab` | The body, keyed by this package's id |
| `ctx.locale` | The `medharness` namespace dictionaries |

It contributes no Remote namespace, no store, and no host row. The node half is an empty `apply()`, which exists only so the plugin appears in the host tree the browser roster scans.

<a id="the-two-panels"></a>
## The two panels

**PATIENT REPORTED** draws the case the person stated: symptoms, duration, age, optional notes, the current revision, and a three-item completeness list. The completeness list is driven entirely by the host's `missingFields` — the browser never decides what is missing, so the indicator cannot disagree with the record it describes.

**MODEL OBSERVED** draws one card per attached image: the display name (or a positional fallback when the attachment carried none), the revision, the body region, the visible findings, the quality issues, and what the model could not determine. An unusable image is shown as a result — "this photo cannot be assessed reliably" is useful information, and it is why the person can take a better one.

The two panels never share an accent colour, and each section carries a `data-evidence` attribute naming which kind of evidence it holds. That is the design, not decoration: telling what the person said from what the model saw is the whole reason to show them side by side, and one merged list would destroy exactly that distinction. Neither panel has a conclusion row, because the domain has no diagnosis, severity, or risk field to put in one.

<a id="where-the-data-comes-from"></a>
## Where the data comes from

Both values are **session projections read through the framework's standard kit**:

```ts
const reported = useProjection('medicalCase')
const observed = useProjection('medicalImage')
```

The host folds each key from the session log and publishes the finished value; the client stores it and never folds anything. That is why a reload, a resume, and a second device all show the same page — and why this package has no data-fetching code, no store, and no refresh logic.

The two keys are declared by the domain packages (`dsh-medical-case/client`, `dsh-medical-image/client`), which also publish the `wire` face the host validates each value through.

<a id="model-experience"></a>
## Model Experience

None. This package contributes no tool, no prompt section, and no host behaviour; nothing it does can appear in a model request.

#### KV Cache effect

None. The package adds nothing to the request prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

**The page reads projections, not the transcript.** If a session's log predates the `wire` faces, the host publishes nothing for those keys and the page shows its loading line rather than an error. A session written before this phase therefore needs a fresh turn before it renders.

**No intake progress bar beyond the three required facts.** The completeness list mirrors `missingFields` exactly, so a deployment that adds a required field sees it appear without a code change, but there is no percentage or step indicator.

**No image thumbnails.** Each card names the image rather than rendering it. The attachment bytes are available to the client through the existing attachment pipeline, and a thumbnail renderer is a natural next step that this phase did not take.

**The tab is opened from the guide.** Nothing opens it automatically on session start; a deployment that wants it pinned by default needs a tab-navigation default this package does not own.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The reason this package is small is that the hard part was deliberately put elsewhere. Making the medical projections publish a `wire` face — rather than adding a Remote read API — means the browser receives finished values over the existing follow stream, so live updates, resume, and reload all work without a line of client code. The alternative would have needed a new RPC namespace, a polling or invalidation story, and a second place for the two domains' shapes to drift.

The components take their values as props and hold no state. That is what makes the reload case testable as an equality between two mounts rather than as a scenario.

</details>
