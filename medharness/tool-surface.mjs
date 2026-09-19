/*
 * Assert the MedHarness runtime composition, and optionally measure the live
 * tool surface of the newest session.
 *
 *   node --import tsx/esm medharness/tool-surface.mjs
 *   node --import tsx/esm medharness/tool-surface.mjs --measure
 *
 * The composition half needs no model and no network: it loads the shipped
 * bundle layers and this overlay through the official profile API, composes them
 * exactly as `dsh --profile headless` does, and asserts the rows that decide the
 * tool surface. The measurement half reads the durable `request/header` event of
 * a real session, which is the only place the surface is observable as the model
 * saw it.
 *
 * Why this is a script and not a vitest spec: vitest only collects
 * `packages/<group>/<pkg>/tests/**\/*.spec.ts` (vitest.config.ts, `testIncludes`),
 * and `packages/<group>/<pkg>/src/**` carries a per-file 100% coverage threshold,
 * so a spec belongs to a workspace package. The composition this asserts is owned
 * by `medharness/cordis.patch.yml`, which is not inside one — the proper home is
 * the MedHarness bundle package evaluated in `medharness/README.md`.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const installAnchor = join(repo, 'apps', 'cli', 'package.json')

const { loadProfile, loadOverlayPatches, composeEntries } = await import(
  pathToFileURL(join(repo, 'packages', 'boot', 'app-boot', 'src', 'index.ts')).href
)

/**
 * Rows that must be OFF. Each entry is the row id a shipped bundle inserts and
 * the tool family it would otherwise contribute. A tool reaches
 * `request/header.tools` only if its registering plugin is mounted, so a disabled
 * row is the whole guarantee.
 */
const FORBIDDEN_ROWS = {
  'tool-bash': 'bash',
  'tool-pwsh': 'pwsh',
  'tool-fs': 'read/write/edit',
  'tool-fs-search': 'glob/grep',
  'tool-jobs': 'job_*',
  'tool-goal': 'goal_*',
  'command-goal': '/goal',
  'plan-mode': 'exit_plan_mode',
  'tool-todo': 'todo_write',
  'tool-workflow': 'workflow',
  'tool-ralph': 'ralph',
  'tool-subagent': 'subagent',
  'tool-subagent-fork': 'subagent_fork',
  'tool-subagent-control': 'send_message/interrupt_agent',
  'tool-subagent-list-agents': 'list_agents',
  'tool-web': 'web_search/web_fetch',
  skill: 'skill',
  'tool-skill': 'skill',
  'mcp-resources': 'mcp',
  'agent-instructions': 'AGENTS.md prompt',
  'session-telemetry-otel': 'session export',
}

/** The medical rows this overlay inserts; each must be mounted. */
const REQUIRED_ROWS = [
  'medical-case',
  'tool-medical-case-intake',
  'tool-medical-case-update',
  'tool-medical-case-get',
]

const failures = []

function fail(message) {
  failures.push(message)
}

function composeProfile(profileName) {
  const profile = loadProfile('medharness-audit', profileName, installAnchor, undefined, { userLayer: false })
  const overlayPaths = [join(here, 'cordis.patch.yml')]
  const overlays = overlayPaths.map(path => loadOverlayPatches('medharness-audit', path))
  const rows = composeEntries([profile.layers.flatMap(layer => layer.patches), ...overlays])
  const byId = new Map(rows.filter(row => typeof row.id === 'string').map(row => [row.id, row]))
  return { profile, byId, layers: profile.layers.map(l => l.packageName) }
}

// ── Composition assertions, on every profile the overlay is applied to ──────
//
// These assertions are about ROWS, and rows are what this overlay owns. They are
// NOT a claim about a Web session's tool list: the Web profile disables the
// host-plane tool rows and re-supplies tools per agent from
// `packages/preset/agent-presets`, so a Web session's surface is decided by its
// preset. There is no medical preset today, so the `web` result below says the
// host plane is clean — not that a Web session sees three tools. The headless
// surface is measured end to end instead, by `--measure` below.

for (const profileName of ['headless', 'web']) {
  const { byId, layers } = composeProfile(profileName)
  console.log(`\n=== profile ${profileName} ===`)
  console.log(`  bundle layers: ${layers.join(', ')}`)
  console.log(`  composed rows: ${byId.size}`)

  for (const [id, family] of Object.entries(FORBIDDEN_ROWS)) {
    const row = byId.get(id)
    if (row === undefined) {
      // A row the profile never carries is already absent; that satisfies the
      // requirement, and `web-app` legitimately omits some of them.
      continue
    }
    if (row.disabled !== true) {
      fail(`${profileName}: row ${id} (${family}) is still enabled`)
    }
  }

  for (const id of REQUIRED_ROWS) {
    const row = byId.get(id)
    if (row === undefined) fail(`${profileName}: required row ${id} is missing`)
    else if (row.disabled === true) fail(`${profileName}: required row ${id} is disabled`)
  }

  // The tool presentation mode must be pinned, or `DSH_TOOLS_MODE=ptc` would
  // replace every medical schema with a single `run_code` tool.
  const tools = byId.get('tools')
  if (tools?.config?.mode !== 'native') {
    fail(`${profileName}: tools.mode must be pinned to 'native', got ${JSON.stringify(tools?.config?.mode)}`)
  }

  const disabled = [...byId.values()].filter(row => row.disabled === true).length
  console.log(`  disabled rows: ${disabled}`)
}

// ── Optional live measurement ───────────────────────────────────────────────

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function readSessionLog(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8') } catch { /* partial frame */ }
  }
  return text.split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

function newestSession() {
  const base = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'sessions')
  if (!existsSync(base)) return undefined
  const candidates = []
  for (const ws of readdirSync(base)) {
    const wsDir = join(base, ws)
    if (!statSync(wsDir).isDirectory()) continue
    for (const id of readdirSync(wsDir)) {
      const file = join(wsDir, id, 'session.v3.jsonl.zstd')
      if (existsSync(file)) candidates.push({ id, file, mtime: statSync(file).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]
}

if (process.argv.includes('--measure')) {
  const session = newestSession()
  console.log('\n=== live tool surface (newest session) ===')
  if (session === undefined) {
    console.log('  no session log found')
  } else {
    const headers = readSessionLog(session.file).filter(e => e.type === 'request/header')
    const last = [...headers].reverse().find(h => Array.isArray(h.data?.header?.tools))
    const tools = last?.data?.header?.tools ?? []
    const bytes = JSON.stringify(tools).length
    console.log(`  session: ${session.id}`)
    console.log(`  tools:   ${tools.length} -> ${tools.map(t => t.name).join(', ') || '(none)'}`)
    console.log(`  schema:  ${bytes} bytes ≈ ${Math.round(bytes / 4)} tokens`)
    const bannedNames = ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep',
      'todo_write', 'workflow', 'subagent', 'web_search', 'web_fetch', 'skill']
    for (const banned of bannedNames) {
      if (tools.some(t => t.name === banned)) fail(`live session still exposes ${banned}`)
    }
    for (const name of ['medical_case_intake', 'medical_case_update', 'medical_case_get']) {
      if (!tools.some(t => t.name === name)) fail(`live session is missing ${name}`)
    }
  }
}

console.log()
if (failures.length > 0) {
  console.error('FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('PASS: the MedHarness composition disables every coding-agent row and mounts the medical rows.')
