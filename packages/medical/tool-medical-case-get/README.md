---
description: "The model-facing medical_case_get tool, which reads the session's authoritative case record without changing it."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-case-get

English | [中文](README.zh.md)

## Summary

`medical_case_get` reads the case this session already recorded, together with the required facts still missing. It is the explicit read path: the record comes from the session's durable case state rather than from the conversation, so it is the same record after a restart, a resume, a fork, or a long stretch of unrelated conversation. The tool changes nothing — it appends no event and spends no revision — and it fails clearly when the session has recorded no case yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this plugin wherever the model should be able to re-check what has actually been captured. It needs `ctx.agents`, `ctx.medicalCase`, and `ctx.tools`, and registers one model-facing tool that takes no arguments.

### Why an explicit read tool

Durable domain state and conversation history are different things, and the difference only shows when they disagree. An agent that relies on its history to remember the case gets it wrong after compaction, after a resume, or whenever the record was updated by something other than a sentence it can still see. Calling this tool answers the question from the record itself.

The alternative — injecting the case into the system prompt or into every request — was rejected for Phase 2: the system prompt is a request prefix, so a value that changes every turn would invalidate KV-cache reuse on every turn, and it would mix recorded facts into the layer that carries instructions.

### Behavior

| Call | Result |
|---|---|
| session has a case | the authoritative `CaseView`: the four facts, `missingFields`, `revision`, and the timestamps |
| session has no case | an error result naming the missing record, so the agent records one with `medical_case_intake` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains how the single tool definition produces it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin identity, the empty parameter root, the output schema, and the rendering |
| — | No runtime invariant companion is published: the tool owns no lifecycle stream and appends no session event of its own, so there is no independent observation to reconcile. |

### Consumer role

The plugin injects `['agents', 'medicalCase', 'tools']` and registers exactly one `defineTool` entry. It resolves the calling agent from the execution and delegates to `ctx.medicalCase.require`, which reads the host-only `medicalCase` projection and derives `missingFields` from the current state on that read. No state is cached in the tool.

### Registration

The tool has no parameters, so the projected root object has no properties and no `required` list. Argument validation still runs through the registry's dispatch path, which is why an agentless execution fails as an ordinary tool error rather than throwing out of the plugin.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Medical case domain](../medical-case/README.md) — the state this tool reads and the derivation behind `missingFields`.
- [Intake tool](../tool-medical-case-intake/README.md) — records the first-contact case.
- [Update tool](../tool-medical-case-update/README.md) — changes the recorded case.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-case-get) — the generated schema.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`medical_case_get` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-case-get): an empty parameter object and no `required` list, plus a description that says the result is authoritative and comes from durable session state rather than conversation memory.

#### Token effect

Fixed schema cost on every request where the tool is visible, and it is the smallest of the three case tools because it declares no parameter.

#### KV Cache effect

Prefix-stable while the definition and its visibility are unchanged. Registering, disposing, or restricting the tool may invalidate reuse from this schema onward.

### Tool-call history and result

#### What the model sees

The result is the rendered record: the four facts, `missingFields`, and `revision`, or the exact `Error: <message>` line when the session has no case. The canonical structured value is not shown; only the rendered text is.

#### Token effect

One result per call, retained until compaction. A complete record renders roughly seven short lines.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate existing entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Read-only by construction** — the tool cannot restore an earlier revision, list past revisions, or report when a fact changed. Revision history is in the session log but is not surfaced here.
- **One case per session** — a call reads the session's current case; there is no way to look up a case by identity or from another session.
- **The rendered record is the whole case** — there is no field selection, so a caller wanting one fact pays for all of them.
- **No automatic injection** — the model must ask; nothing puts the record into the request on its own. Evaluated in [Use this package](#use-this-package).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The three case tools are separate packages while `tool-goal` ships three tools in one. The split follows the Phase 2 boundary the tools were specified with, and it keeps `medical_case_get` mountable on its own — a read-only deployment can offer the record without offering any way to change it.

</details>
