# MedHarness

English | [中文](README.zh.md)

MedHarness is a medical-intake agent built on DeepSeek Harness. This directory
holds the fork's **audit record**; the runtime composition itself is a first-class
Harness bundle.

**Single source of truth: [`packages/bundle/medharness`](../packages/bundle/medharness/README.md).**

The earlier prototype lived here as a `--patch` overlay plus a measurement
script. Both are gone: once the bundle existed they were a second authority that
could drift, and the bundle's `tests/medharness-bundle.spec.ts` asserts what the
script merely printed. Use the profile, not an overlay:

```sh
dsh --profile medharness "我头疼、发烧两天了，25 岁"
dsh --profile medharness-web
```

## What the audit measured

The runtime surface before and after, read from the durable `request/header`
event of a real session — the only place the surface is observable as the model
saw it:

| | tools in `request/header.tools` | tool-schema size |
|---|---|---|
| over `dsh-base` (27 tools, 24 of them coding) | **27** | 29,612 bytes ≈ **7,403 tokens** |
| `medharness` | **3** | 4,533 bytes ≈ **1,133 tokens** |

The three are `medical_case_intake`, `medical_case_update`, and
`medical_case_get` — an 89% reduction in tool count and about 6,300 tokens off
every request, before counting the system-prompt sections the removed plugins
contributed.

## What the audit decided

**A row another row injects is not a surface.** `bash-sandbox` / `pwsh-sandbox`
are the implementation of the abstract `shell` service that `permission-presets`
injects, and `shell-env` publishes the shell environment registry
`apps/cli/src/web.ts` injects. Removing them costs the dependent service, not an
attack surface; none registers a tool. This criterion is why the standalone
composition keeps process confinement and the filesystem provider while
declaring no shell or filesystem tool.

**Telemetry cannot be switched off from configuration.** `config` cannot disable
a row, the launcher applies the environment switch as a patch, and a
`patchReload: startup` profile freezes the tree at boot. For the record,
`FEEDBACK_ONLY` — the shipped default — exports a session-log prefix only after
an explicit feedback event (`feedback/record`, `feedback/message-put`,
`feedback/message-delete`), so ordinary conversation is not captured. Dropping
the row entirely is still the stronger guarantee for clinical text, and it is
what the bundle does.

**Why `REQUEST_EXTENSION` happened at all.** The module-fallback table mirrors
the dependency closure of the installation anchor, `apps/cli/package.json`
(`packages/boot/app-boot/src/profile.ts`, `resolveModuleFallbackEntries`). That
anchor depended on every bundle but on no medical package, so the walk never
reached them and `plugin-package-inventory-deepseek`'s `barePackageManifest`
resolved nothing. Declaring the bundle in `apps/cli` closes that gap — and is why
the bundle's rows are bare package specifiers rather than relative source paths.

## Not yet done, and deliberately

Large subsystems are **not mounted by any bundle** — SSH, browser-use,
computer-use, desktop, `experimental/`, `benchmarks`, `website`,
`native/system` — so they cost nothing at runtime and removing them is a
repository-size change, not an attack-surface one. That is a separate decision
with its own build-system blast radius: `native/system` is enumerated by
`pnpm-workspace.yaml` and mapped in `tsconfig.base.json`, `experimental/` is
imported by `scripts/gen-tool-catalog.ts`, and `website/` sits in the host
tsconfig. Nothing was deleted.
