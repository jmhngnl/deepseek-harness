---
description: "Standalone medical-intake profile whose entire model-facing tool surface is three case tools, with no shell, filesystem, jobs, goals, subagents, workflows, or telemetry."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-medharness`

English | [中文](README.zh.md)

## Summary

Use `dsh --profile medharness` when the agent's job is to record what a person says about their case and ask for what is missing — and nothing else. The profile supplies a complete Cordis tree and deliberately excludes `dsh-base`: no shell, no filesystem, no background jobs, no goals, no todos, no plan mode, no subagents, no workflows, no skills, no web search, and no telemetry. What the model sees is `medical_case_intake`, `medical_case_update`, and `medical_case_get`, backed by a session-log-resident case domain. The agent records and reports gaps; it does not diagnose, prescribe, or assess risk.

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

Launch the profile directly. It answers one task and exits, like every headless profile.

```sh
dsh --profile medharness "我头疼、发烧两天了，25 岁"
```

The Web surface is the same runtime under `dsh-web-app`:

```sh
dsh --profile medharness-web
```

There, an agent's tools come from its preset rather than from the host plane, so the `medical` preset in `dsh-agent-presets` is what a Web medical session sees. It mounts the same three tools.

Both profiles persist sessions through `dsh-session-persistence-jsonl` under `$DSH_HOME/sessions`, and the case lives in that same session log as `medical/case-change` events. `dsh plugin --profile medharness` manages profile-local dependencies; profile, home, and ordered `--patch` files can still replace rows.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle's single insert is a standalone tree, not `dsh-base` with rows switched off. Composing subtractively would still install, resolve, and version every coding-agent package the base bundle names; this lists what the medical agent needs and nothing else, the way [`dsh-sdk-minimal`](../sdk-minimal/README.md) does.

The medical rows name bare package specifiers. That works because this bundle declares every one of them in `package.json`, and because `apps/cli` depends on this bundle: the installation's module-fallback walk starts at `apps/cli/package.json` and mirrors its dependency closure into `$DSH_HOME/profiles/node_modules`, so a package no bundle declares is absent from that walk and every model request fails with `REQUEST_EXTENSION`.

Telemetry is absent rather than disabled. The `DSH_TELEMETRY_DISABLED` switch is applied by the launcher as a patch, `config` cannot disable a row, and a `patchReload: startup` profile freezes the tree at boot — so dropping the row is the only composition-level guarantee that a case conversation is never exported.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Complete standalone profile tree: runtime scaffolding, session and projection, confinement, the agent loop, and the four medical rows |
| [`src/index.ts`](src/index.ts) | Bundle package entry |
| — | No runtime invariant companion is published; the package is a static patch-list carrier whose inserted rows own their runtime relationships and invariant companions. |
| [`tests/medharness-bundle.spec.ts`](tests/medharness-bundle.spec.ts) | Declared-tree contract, the booted tool surface, the token budget, and the preset the Web surface resolves |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Base bundle](../base/README.md) — the full product foundation this profile deliberately omits.
- [SDK-minimal bundle](../sdk-minimal/README.md) — the other standalone bundle, and the pattern this one follows.
- [Medical case domain](../../medical/medical-case/README.md) — the session-backed case the three tools read and write.

-----

<a id="model-experience"></a>
## Model Experience

### Medical intake composition

#### What the model sees

A persona stating that the agent records facts, asks for what is missing, and never diagnoses, prescribes, or assesses risk. Exactly three tool schemas: `medical_case_intake`, `medical_case_update`, and `medical_case_get`. No repository instructions, no runtime context snapshot beyond the persona's own suffix, and no tool for reading, writing, running, searching, delegating, or fetching anything.

#### Token effect

A stable persona plus three tool schemas — measured at 4,533 bytes, about 1,133 tokens, against 29,612 bytes (about 7,403 tokens) for the same agent over `dsh-base`. Conversation history and tool results grow with the session, as everywhere else.

#### KV Cache effect

Stable for a fixed persona, provider, model, and bundle patch stack. Tool presentation is pinned to `native`, so the environment cannot swap the schemas for a single `run_code` and invalidate the cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The Web profile is base-backed** — `dsh-web-app` patches base rows by id and inserts the whole client/Host stack, so it expects a base-backed tree. The Web surface is unaffected because that profile disables the host plane's coding rows and governs each agent's tools by its preset.
- **No medical preset is shipped for the plain `web` profile** — the `medical` preset assumes a composition that mounts `@deepseek-ai/dsh-medical-case`, which the `medharness` bundle does. Use `--profile medharness-web` rather than layering the preset onto `web`.
- **The headless runner's persona row is not reused** — the `medharness` profile lists `dsh-headless` first so this bundle's persona is the later layer. A future mode bundle that patches `system-prompt` will need the same ordering.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`dsh-medharness` is the single source of truth for the MedHarness runtime composition. The earlier `medharness/cordis.patch.yml` prototype and its measurement script were removed once this bundle existed, so there is no second authority to drift.

</details>
