# MedHarness runtime composition

MedHarness is a medical-intake agent built on DeepSeek Harness. This directory
holds its runtime composition: the patch layer that decides which plugins the
medical agent actually mounts, and the audit that decided it.

```
medharness/
  cordis.patch.yml    the composition (applied with --patch)
  tool-surface.mjs    the assertion + measurement tool
  README.md           this file (the audit and the design decisions)
```

Apply it explicitly, on top of a shipped profile:

```sh
pnpm dsh --profile headless --patch ./medharness/cordis.patch.yml "task"
pnpm dsh web --patch ./medharness/cordis.patch.yml
```

## Why this exists

`dsh-base` is the shared core of a **coding** agent. It mounts a shell, a
filesystem, background jobs, goals, todos, plan mode, subagents, workflows,
skills, web search, and telemetry — 82 plugin rows, of which a medical intake
conversation uses almost none. Left alone, the medical agent sees all of it:

| | tools in `request/header.tools` | tool-schema size |
|---|---|---|
| before | **27** | 29,612 bytes ≈ **7,403 tokens** |
| after | **3** | 4,533 bytes ≈ **1,133 tokens** |

The three remaining tools are `medical_case_intake`, `medical_case_update`, and
`medical_case_get`. That is an 89% reduction in tool count and roughly 6,300
tokens off every request, before counting the system-prompt sections the removed
plugins contributed.

Both numbers are measured, not estimated: `tool-surface.mjs --measure` reads the
durable `request/header` event of a real session, which is the only place the
surface is observable as the model saw it.

## How the composition works

A patch row addresses an earlier layer's row **by `id`**, and the last write
wins — `packages/bundle/base/cordis.patch.yml` states the rule, and
`packages/bundle/web-app/cordis.patch.yml` already uses it to strip the host
plane. So `disabled: true` in this overlay outranks the bundle that inserted the
row, the row is never mounted, its module is never imported, its service is never
published, and its tools never enter the request. There is no partial state where
the source is present and callable anyway.

### One criterion decides what may be disabled

**A row another row injects is not a surface.** Two rows that look like shell
surface are kept for exactly this reason, and both were found by boot failing,
not by reading:

- `bash-sandbox` / `pwsh-sandbox` are the sandboxed *implementation* of the
  abstract `shell` service (`packages/shell/shell`), the role `fs-sandbox` plays
  for the filesystem. Disabling both left
  `permission (@deepseek-ai/dsh-permission-presets): pending (waiting for
  service: shell)`. Base platform-gates the pair, so exactly one is mounted on
  any host, and with `tool-bash` / `tool-pwsh` disabled nothing can reach it.
- `shell-env` publishes the environment registry that shells consume;
  `apps/cli/src/web.ts` injects it to publish `DSH_WEB_URL` / `DSH_WEB_MODE`.
  `web-app`'s own comment calls this out as the host-plane ownership criterion.

Neither registers a tool, so keeping them leaves the tool surface at three.
Symmetrically, services with no remaining consumer stay mounted and inert rather
than being torn out — `jobs`, `goal`, the subagent providers — because removing
them reduces no attack surface and only makes the composition harder to extend.

### Telemetry

`session-telemetry-otel` is disabled, because the subject matter is clinical, and
because the environment switch cannot do it: `config` cannot disable a row, the
launcher applies `DSH_TELEMETRY_DISABLED` as a patch, and this profile is
`patchReload: startup`, so that decision would otherwise be frozen at boot.
Dropping the row is the only composition-level guarantee.

For the record, `FEEDBACK_ONLY` — the shipped default — is narrower than its name
suggests: it exports a session-log prefix only after an explicit user feedback
event (`isFeedback` matches `feedback/record`, `feedback/message-put`, and
`feedback/message-delete`; `packages/session/session-telemetry-otel/src/index.ts`).
Ordinary conversation is not captured. Disabling it is defence in depth for a
case conversation, not a fix for a leak.

### Tool presentation is pinned

`tools.mode` is set to `native` instead of reading `DSH_TOOLS_MODE`. Base lets an
environment variable switch the runtime into `ptc` mode, which replaces every
medical schema with a single `run_code` tool; the `ptc-runtime` row that switch
would need is disabled here, and pinning the mode keeps the variable from
steering this profile at all.

## Asserting it

```sh
node --import tsx/esm medharness/tool-surface.mjs            # composition only
node --import tsx/esm medharness/tool-surface.mjs --measure  # + newest live session
```

The composition half loads the shipped bundle layers and this overlay through the
official profile API and asserts, for both `headless` and `web`, that every
coding-agent row is disabled, every medical row is mounted, and the tool mode is
pinned. It needs no model, no network, and no credentials.

It is a script rather than a vitest spec for a concrete reason: vitest collects
only `packages/<group>/<pkg>/tests/**/*.spec.ts` (`vitest.config.ts`,
`testIncludes`) and enforces a per-file 100% coverage threshold on
`packages/<group>/<pkg>/src/**`, so a spec belongs to a workspace package. This
composition is owned by a directory, not a package. The spec belongs with the
bundle below.

## Upgrading past the relative paths

The medical rows name their modules by a path relative to this file, which is how
`docs/user/develop/basic/index.md` mounts a local plugin, and which keeps the
overlay portable across checkouts. A bare `@deepseek-ai/dsh-tool-*` specifier does
not work here, and the reason is not visible from the config layer:

- the Loader would resolve it through the profile directory, so the row composes
  and `--dump-config` looks correct;
- `tsconfig.base.json`, generated by `scripts/gen-tsconfig-paths.ts`, maps the
  name to source, so `scripts/verify-cordis-config.ts` accepts it too;
- but `plugin-package-inventory-deepseek` resolves each active entry through
  Node's `node_modules` lookup (`barePackageManifest`). A workspace package that
  no bundle depends on is absent from `$DSH_HOME/profiles/node_modules`, so that
  lookup returns undefined and **every model request dies with
  `REQUEST_EXTENSION`** — during a request, not at boot, which is why it survives
  a config check.

The fallback table is built by walking the dependency closure of the installation
anchor, `apps/cli/package.json` (`packages/boot/app-boot/src/profile.ts`,
`resolveModuleFallbackEntries`) — and that anchor depends on every bundle but on
no medical package, which is exactly why the walk never reaches them.

A relative path is not a bare specifier, so the inventory falls back to
`nearestManifest`, which walks up from the module to its real manifest.

The fixed form is a bundle package, following `packages/bundle/sdk-minimal` — the
shipped precedent for a composition that does **not** inherit `base`:

1. `packages/bundle/medharness` with
   `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` and a `dependencies`
   list carrying every row it mounts, medical packages included.
2. `@deepseek-ai/dsh-medharness` added to `apps/cli/package.json`. This is what
   makes the closure walk reach the medical packages, which is what makes bare
   specifiers resolvable — the same reason every other bundle is listed there.
3. `medharness: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-medharness'] }`
   in `PROFILE_TEMPLATES` (`packages/boot/app-boot/src/profile.ts`), so
   `dsh --profile medharness` is self-initializing like `sdk-minimal`.
4. The vitest spec, in that package's `tests/`, where `tool-surface.mjs`'s
   assertions move to.

Steps 2 and 3 touch Harness packages. They are additive and follow shipped
precedent, but they are the reason this is a separate, explicitly-confirmed step
rather than part of the tool-surface reduction — which needs none of it.

## What was audited and deliberately left alone

The audit classified every subsystem by whether a bundle actually mounts it.
Several large subsystems are **not mounted by any bundle** — SSH, browser-use,
computer-use, desktop, `experimental/`, `benchmarks`, `website`, `native/system`
— so they cost nothing at runtime today and removing them is a repository-size
change, not an attack-surface one. That is a separate decision, with its own
build-system blast radius: `native/system` is enumerated by `pnpm-workspace.yaml`
and mapped in `tsconfig.base.json`; `experimental/` is imported by
`scripts/gen-tool-catalog.ts`; `website/` is in the host tsconfig. None of it is
touched here.

`test-support` is not removable either: `packages/medical/**` tests depend on it
(`agent-loop-testkit`, `llm-mock-server`, `session-snapshot`, `llm-replay`).

The parts of the surface that are still reachable but unused — the `commands`
slash-command registry, `command-feedback`, `command-compact` — stay mounted
because the Web client uses them. Anything a preset can re-add in the Web profile
is governed by `packages/preset/agent-presets`, which is where a medical preset
would go if the Web UI needs one: there is none today, and the Web profile
already disables the host-plane coding rows, so a Web session's tools come from
its preset rather than from this overlay.
