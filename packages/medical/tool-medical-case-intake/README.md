---
description: "The model-facing medical_case_intake tool, which records user-supplied case basics into the session's durable case and reports the required fields still missing."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-case-intake

English | [中文](README.zh.md)

## Summary

`medical_case_intake` records the case facts a user volunteers — symptoms, duration, age, and optional notes — into this session's durable case, and reports which required facts are still missing. Its purpose is to make the agent ask instead of guess: missing information is a successful result listing the gaps, while a wrong argument type is an ordinary tool error. On an existing case the call restates the record rather than starting a second one. The tool records and structures only: it does not diagnose, recommend treatment or medication, or state a medical risk conclusion.

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

Compose this plugin wherever an agent should record case basics before doing anything else with them. It needs `ctx.agents`, `ctx.medicalCase`, and `ctx.tools`, and registers one global tool on a root-plane mount; a scoped mount registers it for that scope instead. The case belongs to the calling agent's session, so a call without an owning agent fails as an ordinary tool error.

### The two outcomes are deliberately different

This is the whole reason the tool exists, and the reason no parameter is required:

| Model sends | Meaning | Result |
|---|---|---|
| `{}` | the user has not said anything yet | success, `missingFields` names every required field |
| `{"symptoms": "headache"}` | the model malformed the call | error result, `isError: true` |

Marking `symptoms`, `duration`, or `age` as required would collapse the first case into the second: the harness cannot tell "the user did not say" from "the model broke the schema", and the agent would lose the ability to ask a useful follow-up question.

### What the model gets back

A successful call always returns the whole authoritative record, not just the fields it was given. Absent facts are explicit `null` (or `[]` for symptoms) so the shape never varies, `missingFields` is derived from those values on this read, and `revision` identifies the record the call produced:

```json
{
  "caseId": "…",
  "revision": 1,
  "symptoms": [],
  "duration": null,
  "age": null,
  "additionalNotes": null,
  "createdAt": 0,
  "updatedAt": 0,
  "missingFields": ["symptoms", "duration", "age"],
  "changed": true
}
```

`additionalNotes` is optional by contract: omitting it never appears in `missingFields`.

### Creating the case, or restating it

The first call creates the case at revision one. A later call restates it: a field it supplies replaces the recorded value, and a field it omits keeps it. `changed: false` means the restatement matched the record exactly, so nothing was appended and the revision did not move.

A blank is tolerated only while there is nothing to lose. On the create path a blank `duration` records `null` and is reported missing, which is how an intake can record a case the user has barely described. Once a case exists the same blank could only erase a recorded fact, so it is rejected with the field named in the error — as is an empty symptom list. Nothing clears a recorded fact except a deliberate replacement with a real value.

For follow-up answers, prefer [`medical_case_update`](../tool-medical-case-update/README.md): its symptom deltas cannot lose recorded symptoms the way a restatement can.

### Age rules

`age` is a whole number of years, so `0` is valid and means an infant under one year. `integer` in the parameter schema rejects a fractional value at the schema boundary; the range (`0`–`130`) is not expressible in the schema DSL, so the domain enforces it and the call fails with an error result when it is violated.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains how the single tool definition produces it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin identity, the parameter and output schemas, and the rendering |
| — | No runtime invariant companion is published: the tool owns no lifecycle stream, and the durable validation lives in the domain's own strict fold. |

### Consumer role

The plugin injects `['agents', 'medicalCase', 'tools']` and registers exactly one `defineTool` entry. It resolves the calling agent from the execution and delegates to `ctx.medicalCase.intake`, which owns every merge, revision, and validation decision. The durable traces of a call are the `tool/call` + `tool/result` pair the agent loop records and the `medical/case-change` event the domain appends when the change is accepted.

### Why the parameter root is open

The schema DSL compiles `parameters` to an implicit **open** object root, so a call carrying an unrecognized top-level property is accepted and that property is dropped. This is a registry-level convention rather than a choice this package makes; it is recorded under [known limitations](#known-limitations-and-deferred-work).

### Where each rejection happens

Argument types are checked by `defineTool` before the body runs, so a malformed call never reaches this code. The age range and every merge rule are enforced by the domain, which reports a stable error code the registry surfaces as an error result the model sees. Neither path aborts the turn.

### Rendering

`output.render` lists the four fields, `missingFields`, and `revision`, says plainly when nothing changed, and uses `(none provided)` / `(none)` for absent values. The canonical value stays structured and is what a PTC program receives; the rendered text exists so the model reads the gaps without parsing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Medical case domain](../medical-case/README.md) — the durable state this tool records into.
- [Update tool](../tool-medical-case-update/README.md) — the incremental path for follow-up answers.
- [Read tool](../tool-medical-case-get/README.md) — the explicit read path.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-case-intake) — the generated `medical_case_intake` schema.
- [Writing a tool](../../../docs/cookbook/adding-a-tool.md) — the `defineTool` contract this package follows.
- [Medical group map](../README.md) — the sibling packages this tool belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`medical_case_intake` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-medical-case-intake): four optional parameters, each with its own description, and no `required` list. The tool description states the non-goals — no diagnosis, no treatment or medication recommendation, no risk assessment — points follow-ups at `medical_case_update`, and instructs the model to ask for the fields named in `missingFields`.

#### Token effect

Fixed schema cost on every request where the tool is visible. The four parameter descriptions are the bulk of it.

#### KV Cache effect

Prefix-stable while the definition and its visibility are unchanged. Registering, disposing, or restricting the tool may invalidate reuse from this schema onward.

### Tool-call history and result

#### What the model sees

The model's own arguments remain in the assistant tool-call block. The result is either the rendered record listing all four fields, `missingFields`, and `revision`, or, for a rejected call, the exact `Error: <message>` line. The canonical structured value is not shown; only the rendered text is.

#### Token effect

One result per call, retained until compaction. A record with empty fields renders roughly seven short lines; the descriptions are not repeated in the result.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate existing entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The parameter root is open, so an unrecognized top-level property is silently ignored** — a misspelled field name reads as "the user did not say", not as a bad call. Closing it is not expressible in the parameter DSL; a stricter contract would need a wrapper object parameter with `additionalProperties: false`.
- **A restatement replaces the symptom list** — intake is the "here is the whole picture" path, so a call that supplies a shorter list drops the missing entries. `medical_case_update` is the safe path for follow-ups, and its description says so; nothing here enforces that choice.
- **Individual symptoms are only normalized** — trimmed, blank-free, and deduplicated, but never mapped to a controlled vocabulary, so `"Fever"` and `fever` stay distinct.
- **`duration` stays free text** — it is trimmed but never parsed into a normalized interval, so `"2 days"` and `"48 hours"` are not comparable.
- **`age` accepts whole years only** — infants are expressed as `0`, and there is no date-of-birth or months-granularity input.
- **One case per session** — there is no case identity to correlate visits across sessions, and no way to record a second concurrent case.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The tool stays thin on purpose. Every rule the model can trip over — the mutual exclusion, the blank rejection, the revision monotonicity — lives in the domain so the three case tools cannot drift apart, and so a future UI or command path gets the same guarantees without re-deriving them.

</details>
