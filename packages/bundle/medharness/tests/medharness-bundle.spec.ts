/**
 * The MedHarness bundle's composition, and the model-facing surface it produces.
 *
 * Two independent things are asserted, because either can drift without the
 * other: the tree the bundle declares (which every other profile layer composes
 * over), and the tool catalog the real Loader ends up publishing once that tree
 * is booted with the medical rows.
 *
 * The surface assertion is on the COMPLETE set, not on the absence of a few
 * names: a bundle that quietly gained a tool would pass "does not contain bash"
 * and fail this.
 */

import { writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { boot, healProfilesModuleFallback, loadOverlayPatches, loadProfile, PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { discoverPresets, SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const INSTALL_ANCHOR = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))

/** The whole model-facing surface this runtime is allowed to publish. */
const MEDICAL_TOOLS = ['medical_case_get', 'medical_case_intake', 'medical_case_update']

/** Rows whose presence would mean a coding-agent capability leaked in. */
const CODING_TOOLS = ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'read_image',
  'job_list', 'job_output', 'job_kill', 'todo_write', 'exit_plan_mode', 'get_goal', 'create_goal',
  'update_goal', 'web_search', 'web_fetch', 'workflow', 'ralph', 'skill', 'subagent',
  'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents']

/** A generous ceiling: the measured surface is ~1,133 tokens. */
const TOKEN_BUDGET = 1500

/**
 * Booting the real Loader here pulls this bundle's ~30 workspace packages
 * through the test transform. Cold — a fresh clone, or CI, where nothing is
 * cached — that graph costs tens of seconds; the 5 s default only holds once it
 * is warm. Raising the ceiling relaxes no assertion: a surface that published a
 * fourth tool still fails, it just fails on the assertion instead of on a
 * stopwatch.
 */
const BOOT_TIMEOUT = 120_000

/** Preset discovery walks the shipped roster off disk, which is slow when cold. */
const DISCOVERY_TIMEOUT = 60_000

/**
 * Price the tool-schema part of a request the way the harness does.
 *
 * `estimateToolsTokens` lives in `packages/llm/token-meter/src/estimate.ts` and
 * is NOT re-exported from that package's root, so it is not a stable reusable
 * interface — importing the module path happens to work at runtime through the
 * package's `./src/*` export but does not survive the test runner's tsconfig
 * paths mapping. This repeats the published heuristic instead (a fixed 4
 * chars/token density plus the block's structural overhead), so a change to the
 * official formula shows up here as a deliberate edit rather than as a silent
 * drift in the budget.
 */
function estimateToolSchemaTokens(tools: readonly unknown[]): number {
  const CHARS_PER_TOKEN = 4
  const BLOCK_OVERHEAD = 4
  if (tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

interface Row {
  id?: string
  name?: string
  inject?: string[]
  config?: Record<string, unknown>
  disabled?: unknown
}

function declaredRows(): Row[] {
  const manifest = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const patchPath = manifest.dsh?.bundle?.patch
  expect(patchPath).toBe('./cordis.patch.yml')
  const patches = yaml.load(
    readFileSync(resolve(PACKAGE_ROOT, patchPath!), 'utf8'),
    { schema: entryListSchema },
  ) as Array<{ insert?: Row[] }>
  expect(patches).toHaveLength(1)
  return patches[0]?.insert ?? []
}

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

// ── The declared tree ───────────────────────────────────────────────────────

describe('dsh-medharness bundle', () => {
  it('declares exactly the dependencies its rows name', () => {
    const manifest = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const rows = declaredRows()
    // Exact set equality in both directions: an undeclared row cannot resolve,
    // and a declared-but-unused dependency would widen the installation closure
    // the module-fallback walk mirrors into every profile.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined)
        .map(packageName))].sort(),
    )
  })

  it('mounts the medical domain and its three tools, and nothing else model-facing', async () => {
    const rows = declaredRows()
    const medical = rows.filter(row => (row.name ?? '').includes('medical'))
    expect(medical.map(row => row.id).sort()).toEqual([
      'medical-case',
      'tool-medical-case-get',
      'tool-medical-case-intake',
      'tool-medical-case-update',
    ])
    expect(rows.filter(row => row.disabled !== undefined)).toEqual([])
    // Telemetry must be ABSENT, not disabled: a composition without the row
    // cannot export, which is stronger than a switch the launcher applies.
    expect(rows.some(row => (row.name ?? '').includes('telemetry'))).toBe(false)
    // No shell, filesystem, job, goal, todo, plan, subagent, workflow, skill or
    // web tool plugin is declared at all.
    for (const banned of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-jobs', 'tool-goal',
      'tool-todo', 'plan-mode', 'tool-subagent', 'tool-workflow', 'tool-ralph', 'tool-skill',
      'tool-web', 'mcp-resources', 'agent-instructions', 'user-questions']) {
      expect(rows.some(row => row.id === banned), `row ${banned} must not be declared`).toBe(false)
    }
    // The tool mode is pinned, so the environment cannot swap the medical
    // schemas for a single `run_code`.
    expect(rows.find(row => row.id === 'tools')?.config).toEqual({ mode: 'native' })
  })

  it('requires no relative source path: every row is a bare package specifier', () => {
    for (const row of declaredRows()) {
      expect(row.name, `row ${String(row.id)} must use a package specifier`).toMatch(/^@deepseek-ai\//)
    }
  })
})

// ── The surface the real Loader publishes ───────────────────────────────────

describe('medharness profile surface', () => {
  let ctx: Context | undefined

  afterAll(async () => {
    await ctx?.fiber.dispose()
  })

  it('publishes exactly the three medical tools', async () => {
    // What is booted is this bundle's own patch layer, inside the real
    // `medharness` profile directory so the module fallback the launcher heals
    // is the one that resolves the rows. The profile's other layer —
    // `dsh-headless` — is deliberately excluded: its `headless-startup` row
    // needs the launcher's `cmdlineArgs` and its runner then executes the task,
    // which would make a unit test issue a live model request. It contributes no
    // tool, and the next test asserts it is the only thing the profile adds.
    const profile = loadProfile('medharness-surface-test', 'medharness', INSTALL_ANCHOR, undefined, { userLayer: false })
    const rootConfig = join(profile.dir, 'cordis.yml')
    // The launcher rewrites this file on every boot; the Loader needs a real
    // include root to anchor `baseUrl` at the profile directory.
    writeFileSync(rootConfig, '[]\n')
    await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile })
    ctx = await boot(
      'medharness-surface-test',
      rootConfig,
      loadOverlayPatches('medharness-surface-test', resolve(PACKAGE_ROOT, 'cordis.patch.yml')),
      async (hostCtx) => {
        await hostCtx.plugin(PluginPackages, {})
      },
    )
    const schemas = ctx.tools.schemas()
    const names = schemas.map(schema => schema.name).sort()
    expect(names).toEqual(MEDICAL_TOOLS)
    for (const banned of CODING_TOOLS) {
      expect(names, `the surface must not publish ${banned}`).not.toContain(banned)
    }
  }, BOOT_TIMEOUT)

  it('stays inside the tool-schema token budget', async () => {
    const schemas = ctx?.tools.schemas() ?? []
    expect(schemas).toHaveLength(MEDICAL_TOOLS.length)
    const tokens = estimateToolSchemaTokens(schemas)
    expect(tokens).toBeLessThan(TOKEN_BUDGET)
  })
})

describe('profile registration', () => {
  it('adds only the one-shot runner on top of this bundle', async () => {
    const { PROFILE_TEMPLATES } = await import('@deepseek-ai/dsh-app-boot')
    expect(PROFILE_TEMPLATES.medharness?.bundles).toEqual([
      '@deepseek-ai/dsh-headless',
      '@deepseek-ai/dsh-medharness',
    ])
    // The Web profile is base-backed because `dsh-web-app` patches base rows by
    // id; its surface is the preset's, asserted above.
    expect(PROFILE_TEMPLATES['medharness-web']?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-medharness',
    ])
    // The shipped profiles keep the bundles they had.
    expect(PROFILE_TEMPLATES.headless?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    expect(PROFILE_TEMPLATES.web?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })
})

// ── The preset the Web surface resolves ─────────────────────────────────────

describe('medical agent preset', () => {
  async function presetRows(id: string): Promise<Row[]> {
    const presets = await discoverPresets(
      [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      pathToFileURL(join(INSTALL_ANCHOR, '..')).href,
      // Package presence is decided by the test runtime's tsconfig paths, not by
      // node_modules, so presence is not what this assertion is about.
      () => true,
    )
    const preset = presets.find(candidate => candidate.id === id)
    expect(preset, `preset ${id} must be discovered`).toBeDefined()
    expect(preset!.broken).toBeUndefined()
    const patches = yaml.load(readFileSync(preset!.path, 'utf8'), { schema: entryListSchema }) as Row[]
    return patches
  }

  it('is discovered on the shipped roster', async () => {
    const presets = await discoverPresets(
      [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      pathToFileURL(join(INSTALL_ANCHOR, '..')).href,
      () => true,
    )
    expect(presets.map(preset => preset.id)).toContain('medical')
  }, DISCOVERY_TIMEOUT)

  it('mounts exactly the three medical tools for an agent', async () => {
    const rows = await presetRows('medical')
    const toolRows = rows.filter(row => (row.name ?? '').includes('tool-'))
    expect(toolRows.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-tool-medical-case-intake',
      '@deepseek-ai/dsh-tool-medical-case-update',
      '@deepseek-ai/dsh-tool-medical-case-get',
    ])
    // The persona is the COMPLETE prompt, so no later assembly listener can
    // describe capabilities this agent does not have.
    expect(rows.find(row => row.id === 'persona')?.config).toMatchObject({
      complete: true,
      includeRuntimeContext: false,
    })
    expect(rows.some(row => row.disabled !== undefined)).toBe(false)
  }, DISCOVERY_TIMEOUT)

  it('keeps the control meaningful: the standard preset does declare coding tools', async () => {
    const rows = await presetRows('standard')
    const names = rows.map(row => row.name ?? '')
    expect(names).toContain('@deepseek-ai/dsh-tool-bash')
    expect(names.some(name => name.includes('tool-medical'))).toBe(false)
  }, DISCOVERY_TIMEOUT)
})
