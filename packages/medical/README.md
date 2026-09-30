---
description: "The medical group map: a session-backed case domain and its model-facing tools for medical consultation and intake assistance, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/medical

English | [中文](README.zh.md)

## Summary

The medical group holds domain capabilities for medical consultation and intake assistance. Unlike the harness capability groups, these packages solve no part of the agent runtime: their subject is a case, not a codebase. The group ships a session-backed case domain plus five model-facing tools: three for the patient-reported case and two for what the model observed in an attached image. A case is intake-collection state: the domain records, updates, and replays the facts a user stated, reports what is still missing, and lets the agent ask instead of guess. Nothing diagnoses, prescribes, or assesses risk.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`medical-case`](medical-case/README.md) | One durable case per session: create, restate, patch, strict replay, and a monotonic revision | `ctx.medicalCase` |
| [`tool-medical-case-intake`](tool-medical-case-intake/README.md) | Records the case on first contact and reports the required fields still missing | registers on `ctx.tools` |
| [`tool-medical-case-update`](tool-medical-case-update/README.md) | Applies one incremental change to the recorded case, never clearing a field silently | registers on `ctx.tools` |
| [`tool-medical-case-get`](tool-medical-case-get/README.md) | Reads the authoritative case and the facts still missing, without changing either | registers on `ctx.tools` |
| [`medical-image`](medical-image/README.md) | One durable observation per attached image per session: record, update, strict replay, and the attachment authorization boundary | `ctx.medicalImage` |
| [`tool-medical-image-observe`](tool-medical-image-observe/README.md) | Records what the model directly saw in one image, with its quality limits and what could not be determined | registers on `ctx.tools` |
| [`tool-medical-image-get`](tool-medical-image-get/README.md) | Reads observations back, addressed by attachment, so a session holding several images keeps them apart | registers on `ctx.tools` |
| [`medical-eval`](medical-eval/README.md) | Golden-case replay, the pure evaluator, the failure taxonomy, and the report — test infrastructure that publishes no service | nothing (test infrastructure) |

-----

<a id="related-documentation"></a>
## Related documentation

- [MedHarness architecture](../../docs/medharness-architecture.md) — what the harness provides, what this group adds, and where the seam is.
- [MedHarness engineering design](../../docs/medharness-engineering-design.md) — the five problems this group solves, written as problem, solution, implementation, and payoff.
- [Medical case subsystem](../../docs/subsystems/medical-case.md) — the case state, its durable event, and the service API.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-case-intake) — the three schemas the model receives.
- [Same-session goal domain](../goal/README.md) — the sibling pattern this group follows: event-sourced per-session state.
- [Writing a tool](../../docs/cookbook/adding-a-tool.md) — the tool contract these packages follow.
- [Package groups](../README.md) — where this group sits among the harness capability groups.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The domain package deliberately does not import `dsh-agent-loop`: case state and policy compose from plugins, `Agent` verbs, and session events without giving the default loop implementation a privileged copy of them, which is the same reason the same-session goal domain was rejected. Persistence, resume, and fork inheritance all belong to the session log; the group ships no database and no hidden JSON store.

</details>
