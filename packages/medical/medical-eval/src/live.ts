/**
 * The live runner: the shipped MedHarness profile, a real model, the same
 * pipeline.
 *
 * The deterministic suite hand-mounts a context per case. That is correct for a
 * scripted model and wrong for a benchmark: a hand-mounted runtime is a second
 * composition, free to drift from the one that ships. This runner therefore
 * boots the real `medharness` profile through the app-boot loader — the same
 * profile directory, the same bundle layers, the same healed module fallback
 * the `dsh` launcher uses — and mounts no plugin of its own. What the
 * composition is, is what gets measured.
 *
 * Two deliberate subtractions, both named here rather than left implicit:
 *
 * - `@deepseek-ai/dsh-headless` is the one-shot CLI *app surface*: its rows
 *   read a task out of `cmdlineArgs` and drive it to completion. That is not
 *   this runner's work, and keeping them would either issue an uncontrolled
 *   model request or leave two rows pending forever. What remains is exactly
 *   the medical runtime the shipped profile composes for an agent —
 *   `@deepseek-ai/dsh-medharness`.
 * - the profile's user layers (its own `cordis.patch.yml` and the home-level
 *   one) are skipped. The subject is the SHIPPED composition, and a
 *   machine-local edit must not be able to change what "the shipped profile"
 *   means from one machine to the next. The model route is unaffected: the
 *   provider, the endpoint, and the key all resolve from
 *   `$DSH_HOME/settings.yaml` and the credential store, not from a patch layer.
 *
 * Skipping the patch layer is not on its own enough to make that claim true.
 * `app-boot` normalizes a profile manifest only while its `dsh.profile.bundles`
 * still equals the shipped template; any other list is user-owned and is left
 * exactly as written. A hand-edited
 * `$DSH_HOME/profiles/medharness/package.json` would therefore be booted
 * verbatim and still be reported as the shipped composition. So the runner
 * states what it measured rather than assuming it, and refuses rather than
 * reports loosely: the loaded profile must still compose the shipped bundles,
 * and the booted composition must publish exactly the three medical tools. A
 * profile whose bundles were edited, or a composition that gained a fourth
 * tool, fails the run rather than silently widening what the numbers below
 * describe. Neither guard repairs anything — an edited profile is a refusal,
 * not a profile to rewrite.
 *
 * A live failure is a result. Nothing here repairs, retries, or relaxes a case
 * to make one pass.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  healProfilesModuleFallback,
  loadProfile,
  PROFILE_TEMPLATES,
  PluginPackages,
} from '@deepseek-ai/dsh-app-boot'
import type { Profile } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
// Empty type imports carry the tool-registry Context merge the surface guard reads.
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { loadGoldenCases } from './golden.ts'
import { buildReport, createRunId, evalRunsDirectory, writeEvalReport } from './report.ts'
import { runGoldenCases } from './runner.ts'
import type { GoldenCaseHarness } from './runner.ts'
import type { EvalReport, EvalRuntime, GoldenCase } from './types.ts'

/** The shipped profile the live runner boots. */
export const LIVE_PROFILE = 'medharness'

/**
 * The one-shot CLI app surface, excluded from the booted composition. It
 * contributes no medical row: everything the agent's runtime is made of comes
 * from `@deepseek-ai/dsh-medharness`.
 */
export const LIVE_APP_SURFACE_BUNDLE = '@deepseek-ai/dsh-headless'

/** The complete model-facing surface the medical composition must publish. */
export const LIVE_MEDICAL_TOOLS: readonly string[] = [
  'medical_case_get',
  'medical_case_intake',
  'medical_case_update',
]

/**
 * The cases the default invocation replays. Three turns of one conversation
 * each — a first contact, a completion, and a read — is the smallest set that
 * exercises intake, a multi-turn update, and a read-only get.
 */
export const SMOKE_CASE_IDS: readonly string[] = [
  'intake-first-contact-two-symptoms',
  'update-completes-the-record',
  'get-reads-without-changing',
]

/** The Loader's include root inside a profile directory; the launcher rewrites it on every boot. */
const ROOT_CONFIG_FILENAME = 'cordis.yml'

/** The root config content: the whole composition is patch layers over an empty tree. */
const ROOT_CONFIG_CONTENT = '[]\n'

/** First resolution anchor for the module fallback walk, as the launcher uses it. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))

/** The shipped roster beside this package's sources. */
const ROSTER_DIRECTORY = fileURLToPath(new URL('../golden/', import.meta.url))

/** The provider and model a run resolved, as the report states them. */
export interface LiveRoute {
  /** Provider route the cases were replayed against. */
  readonly provider: string
  /** Model id the cases were replayed against. */
  readonly model: string
}

/**
 * One profile's resolved patch layers, derived from the profile contract rather
 * than from the include package: this module consumes the layers a loaded
 * profile hands it and never parses a patch file itself.
 */
type BundlePatches = Profile['layers'][number]['patches']

/**
 * Which cases an invocation asks for.
 *
 * `ids` is empty when the invocation named no case, which the caller resolves
 * to {@link SMOKE_CASE_IDS} rather than to the whole roster.
 */
export interface LiveArgs {
  /** Whether the whole roster was requested. */
  readonly all: boolean
  /** Case ids named by `--case`, in the order they were given. */
  readonly ids: readonly string[]
}

/** The outcome of reading an invocation's arguments. */
export interface LiveArgsResult {
  /** The parsed selection; absent when at least one argument was rejected. */
  readonly args?: LiveArgs
  /** Every rejected argument, as one line each. */
  readonly errors: readonly string[]
}

/** Options for {@link runLiveEval}. */
export interface LiveEvalOptions {
  /** Checkout root; the report lands in `<root>/.medharness/eval-runs`. */
  readonly root: string
  /** The cases to replay, in order. Must not be empty. */
  readonly cases: readonly GoldenCase[]
  /** Wall-clock ceiling for one turn, in milliseconds. */
  readonly turnTimeoutMs?: number
  /**
   * The route to run against. Absent means the composition's own default model,
   * which is what a real smoke uses; a scripted test supplies a mock route so
   * the same runner is exercised without a network. What the report records is
   * whichever route this resolves to, never an assumption about it.
   */
  readonly route?: LiveRoute
  /**
   * Called once per case with the freshly booted root, after the surface
   * assertion and before any agent exists. A scripted test registers its
   * adapter here; a live run passes nothing.
   */
  readonly onRuntimeReady?: (ctx: Context) => void | Promise<void>
}

/** What one live run produced. */
export interface LiveEvalResult {
  /** The versioned report document. */
  readonly report: EvalReport
  /** Absolute path the report was written to. */
  readonly path: string
  /** The route the run resolved, as recorded in {@link LiveEvalResult.report}. */
  readonly route: LiveRoute
}

/** Output sinks an entry point writes its summary to. */
export interface LiveIo {
  /** One line to standard output. */
  readonly out: (line: string) => void
  /** One line to standard error. */
  readonly err: (line: string) => void
}

/**
 * Read a live invocation's arguments.
 *
 * Grammar, in full: `--case <id>` (repeatable), `--all`, and nothing else. No
 * `--provider` or `--model`: the route is a property of the profile under test,
 * and a flag that could silently point a "live" run at a different model would
 * make the report's own route line untrustworthy. Defaults are the smoke set,
 * not the roster, because a first live run should be cheap to abandon.
 * @param argv - the invocation's arguments, without the node and script paths.
 * @returns the selection, or the lines describing what was rejected.
 */
export function parseLiveArgs(argv: readonly string[]): LiveArgsResult {
  const errors: string[] = []
  const ids: string[] = []
  let all = false
  let expectValue = false
  for (const argument of argv) {
    if (expectValue) {
      if (argument === '' || argument.startsWith('--')) {
        errors.push('--case requires a case id')
        break
      }
      ids.push(argument)
      expectValue = false
      continue
    }
    if (argument === '--all') {
      all = true
      continue
    }
    if (argument === '--case') {
      expectValue = true
      continue
    }
    errors.push(argument.startsWith('-')
      ? `unknown option ${argument}`
      : `unexpected argument ${argument}`)
    break
  }
  // A trailing `--case` never reached the value branch above.
  if (expectValue && errors.length === 0) errors.push('--case requires a case id')
  if (all && ids.length > 0) errors.push('--all cannot be combined with --case')
  return errors.length === 0 ? { args: { all, ids }, errors } : { errors }
}

/**
 * Resolve a selection against a roster.
 * @param roster - every case available.
 * @param args - the parsed selection.
 * @returns the cases to replay in roster order, and the ids that named nothing.
 */
export function selectLiveCases(
  roster: readonly GoldenCase[],
  args: LiveArgs,
): { readonly cases: readonly GoldenCase[]; readonly unknown: readonly string[] } {
  const requested = args.all
    ? roster.map(golden => golden.id)
    : args.ids.length > 0 ? args.ids : SMOKE_CASE_IDS
  const wanted = new Set(requested)
  const cases = roster.filter(golden => wanted.has(golden.id))
  const unknown = requested.filter(id => !roster.some(golden => golden.id === id))
  return { cases, unknown }
}

/**
 * State the route and runner a live report describes.
 * @param route - the resolved provider and model.
 * @returns the runtime block of the report, with `runner` fixed to `live`.
 */
export function liveRuntime(route: LiveRoute): EvalRuntime {
  return { profile: LIVE_PROFILE, provider: route.provider, model: route.model, runner: 'live' }
}

/**
 * Render the lines describing a rejected invocation.
 * @param errors - the rejected arguments.
 * @param roster - the cases that could have been named.
 * @returns one line per error, followed by the available ids.
 */
export function renderLiveArgsErrors(errors: readonly string[], roster: readonly GoldenCase[]): string[] {
  return [
    ...errors.map(error => `medharness:eval: ${error}`),
    `medharness:eval: available cases: ${roster.map(golden => golden.id).join(', ')}`,
  ]
}

/**
 * Render the lines describing a finished run.
 *
 * The route, the per-case verdict, the failure taxonomy, token-coverage, latency
 * and the report path all appear here so that a failing live run is readable
 * without opening the JSON — the point of a live smoke is the evidence, and a
 * summary that hid the failures would be the one thing worth hiding.
 * @param report - the finished report.
 * @param path - where the report was written.
 * @returns one line per fact.
 */
export function renderLiveSummary(report: EvalReport, path: string): string[] {
  const { runtime, summary } = report
  const lines = [
    `profile=${runtime.profile} provider=${runtime.provider} model=${runtime.model} runner=${runtime.runner}`,
    `cases=${String(summary.casesPassed)}/${String(summary.casesTotal)} passed`
      + ` routing=${String(summary.toolRoutingPassed)}/${String(summary.toolRoutingTotal)}`
      + ` state=${String(summary.stateAssertionsPassed)}/${String(summary.stateAssertionsTotal)}`
      + ` missingFields=${String(summary.missingFieldAssertionsPassed)}/${String(summary.missingFieldAssertionsTotal)}`,
    `toolErrors=${String(summary.toolErrors)} unexpectedMutations=${String(summary.unexpectedMutations)}`
      + ` timeouts=${String(summary.timeouts)} runtimeErrors=${String(summary.runtimeErrors)}`,
    `usage input=${String(summary.usage.inputTokens)} output=${String(summary.usage.outputTokens)}`
      + ` turns=${String(summary.usage.observedTurns)}/${String(summary.usage.totalTurns)}`
      + ` complete=${String(summary.usage.complete)}`,
    `latency totalMs=${String(summary.latencyMs.totalMs)}`,
    `report=${path}`,
  ]
  for (const reported of report.cases) {
    lines.push(`${reported.passed ? 'PASS' : 'FAIL'} ${reported.id}`)
    for (const failure of reported.failures) {
      lines.push(`  turn ${String(failure.turnIndex)}: ${failure.failureType} — ${failure.detail}`)
    }
  }
  return lines
}

/**
 * Load the shipped profile, refuse a user-owned one, write its empty include
 * root, and heal the module fallback the bare specifiers in its rows resolve
 * through.
 *
 * Done once per run rather than once per case: the profile directory, its
 * layers, and the fallback table do not change between cases, and healing is
 * the expensive part.
 *
 * The provenance check runs before anything is written into the profile
 * directory, so a refused run leaves it exactly as it found it.
 * @returns the loaded profile, with its root config written.
 * @throws when the profile no longer composes the shipped bundles, cannot be
 * loaded, or its fallback cannot be repaired.
 */
async function prepareLiveComposition(): Promise<{
  readonly profileDir: string
  readonly bundlePatches: BundlePatches
}> {
  const profile = loadProfile(LIVE_PROFILE, LIVE_PROFILE, INSTALL_ANCHOR, undefined, { userLayer: false })
  assertShippedProfile(LIVE_PROFILE, profile.layers.map(layer => layer.packageName))
  writeFileSync(join(profile.dir, ROOT_CONFIG_FILENAME), ROOT_CONFIG_CONTENT)
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile })
  return {
    profileDir: profile.dir,
    bundlePatches: profile.layers
      .filter(layer => layer.packageName !== LIVE_APP_SURFACE_BUNDLE)
      .flatMap(layer => layer.patches),
  }
}

/**
 * Assert a booted composition published the medical surface and nothing else.
 *
 * The complete set is the assertion, not the absence of a few names: a
 * composition that quietly gained a tool would satisfy "publishes no shell" and
 * fail this. Exported for its own test rather than for callers — it takes names
 * so the check needs no booted context to exercise.
 * @param published - every schema name the composition published.
 * @throws when the names are not exactly {@link LIVE_MEDICAL_TOOLS}.
 */
export function assertMedicalSurface(published: readonly string[]): void {
  const actual = [...published].sort()
  const expected = [...LIVE_MEDICAL_TOOLS].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(
      `${LIVE_PROFILE}: the booted composition must publish exactly ${expected.join(', ')};`
      + ` it published ${actual.length === 0 ? 'nothing' : actual.join(', ')}`,
    )
  }
}

/**
 * Assert a loaded profile still composes the shipped bundle list.
 *
 * The check is on the layers the loader actually resolved, because that is what
 * boot consumes — and it is the only check that can tell a shipped profile from
 * a user-owned one. `app-boot` rewrites a manifest whose `dsh.profile.bundles`
 * equals the shipped template, or a retired installation tuple, and leaves every
 * other list exactly as written; so a mismatch here means the composition about
 * to be measured is not the one that ships.
 *
 * Nothing is repaired. A user-owned profile is a refusal: rewriting the
 * manifest would answer the question by changing it.
 *
 * Exported for its own test rather than for callers — it takes names so the
 * check needs no loaded profile to exercise.
 * @param name - the shipped profile the runner is about to boot.
 * @param bundles - the bundle package names the loaded profile resolved, in order.
 * @throws when the name has no shipped template, or the layers are not exactly
 * {@link PROFILE_TEMPLATES}'s bundles for it.
 */
export function assertShippedProfile(name: string, bundles: readonly string[]): void {
  const template = PROFILE_TEMPLATES[name]
  if (template === undefined) {
    throw new Error(`${name}: no shipped profile template, so there is no composition for the live runner to measure`)
  }
  const expected = template.bundles
  const actual = [...bundles]
  if (actual.length !== expected.length || actual.some((bundle, index) => bundle !== expected[index])) {
    throw new Error(
      `${name}: the profile is user-owned and no longer composes the shipped bundles;`
      + ` expected ${expected.join(', ')}, found ${actual.length === 0 ? 'nothing' : actual.join(', ')}.`
      + ' The live runner measures the SHIPPED composition and refuses to report a modified one as shipped.',
    )
  }
}

/** One case's resolved route, kept beside the case that resolved it. */
export interface LiveRouteSample {
  /** The case whose boot resolved {@link LiveRouteSample.route}. */
  readonly caseId: string
  /** The provider and model that boot resolved for that case. */
  readonly route: LiveRoute
}

/**
 * Assert a run resolved one route, and return it.
 *
 * Every case boots the same composition, so every case must resolve the same
 * provider and model. A run that did not — settings edited mid-run, a route
 * that depends on something the composition does not own — would still produce
 * a single `runtime` block, and that block would name one model while the
 * numbers beside it came from several. The report is refused instead of
 * written.
 *
 * Exported for its own test rather than for callers — it takes the samples so
 * the check needs no booted run to exercise.
 * @param samples - one entry per replayed case, in run order.
 * @returns the route every case resolved.
 * @throws when no case produced a route, or a case resolved a different one
 * than the first.
 */
export function assertSingleRoute(samples: readonly LiveRouteSample[]): LiveRoute {
  const first = samples[0]
  if (first === undefined) throw new Error('medharness:eval: no case produced a runtime route')
  for (const sample of samples.slice(1)) {
    if (sample.route.provider !== first.route.provider || sample.route.model !== first.route.model) {
      throw new Error(
        `medharness:eval: the run resolved more than one route — ${first.caseId} ran`
        + ` ${first.route.provider}/${first.route.model}, ${sample.caseId} ran`
        + ` ${sample.route.provider}/${sample.route.model}. A report describes one route,`
        + ' so a run that spanned several is refused rather than misreported.',
      )
    }
  }
  return first.route
}

/**
 * Boot one case's runtime and create its agent.
 *
 * Cases are isolated the way the deterministic suite isolates them — one
 * composition per case, disposed when the case ends — because that is the
 * lifetime {@link GoldenCaseHarness} documents. A live case is cheaper to boot
 * than it is to reason about, so the isolation is bought rather than shared.
 * @param composition - the prepared profile and its bundle patches.
 * @param golden - the case about to be replayed.
 * @param options - the run's route override and runtime hook.
 * @returns one case's harness and the route its composition resolved.
 */
async function bootCase(
  composition: { readonly profileDir: string; readonly bundlePatches: BundlePatches },
  golden: GoldenCase,
  options: LiveEvalOptions,
): Promise<{ readonly harness: GoldenCaseHarness; readonly route: LiveRoute }> {
  // Fresh clones per boot: the include pushes `insert` rows into the mounted
  // tree BY REFERENCE, so reusing one parsed patch object would let the first
  // boot mutate what the next one mounts.
  const ctx = await boot(
    LIVE_PROFILE,
    join(composition.profileDir, ROOT_CONFIG_FILENAME),
    structuredClone([...composition.bundlePatches]),
    async (hostCtx) => {
      await hostCtx.plugin(PluginPackages, {})
    },
  )
  assertMedicalSurface(ctx.tools.schemas().map(schema => schema.name))
  await options.onRuntimeReady?.(ctx)
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  /* v8 ignore next -- boot() awaited the Loader, and the surface assertion above already read ctx.tools */
  if (agents === undefined || defaultModel === undefined) {
    throw new Error(`${LIVE_PROFILE}: the booted composition published no agent registry or default model`)
  }
  // A live smoke takes the composition's own answer. The other side of this
  // choice is a real provider request, which CI must not make, so the absent
  // side stays exempt rather than covered by a fake route that would misreport
  // the run.
  /* v8 ignore next -- route-absent is the live path, exercised by a real smoke */
  const selection = options.route ?? defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const { agent } = await agents.create({
    // Cases are persisted side by side in $DSH_HOME/sessions, so the identity
    // must be unique per run: reusing one would collide with a stored session.
    sessionId: SessionId(`medharness-eval-${golden.id}-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions,
    setup,
  })
  await agent.whenIdle()
  return { harness: { ctx, agent }, route: { provider: selection.provider, model: selection.model } }
}

/**
 * Replay cases against the shipped profile and persist the report.
 *
 * The route the report carries is the one the booted composition resolved, not
 * one this module guessed: every case boots the same patch set, so the boot is
 * where the answer lives — and every case must resolve the same one, which
 * {@link assertSingleRoute} settles before a report exists.
 * @param options - the cases, the checkout root, and optional route and hooks.
 * @returns the report, its path, and the route it recorded.
 * @throws when no case was selected, the composition cannot be booted, or the
 * cases did not all resolve one route.
 */
export async function runLiveEval(options: LiveEvalOptions): Promise<LiveEvalResult> {
  if (options.cases.length === 0) {
    throw new Error('medharness:eval: no case selected')
  }
  const composition = await prepareLiveComposition()
  const samples: LiveRouteSample[] = []
  const startedAt = new Date()
  const runs = await runGoldenCases(options.cases, async (golden) => {
    const booted = await bootCase(composition, golden, options)
    samples.push({ caseId: golden.id, route: booted.route })
    return booted.harness
  }, options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs })
  const finishedAt = new Date()
  const route = assertSingleRoute(samples)
  const report = buildReport({
    runId: createRunId(startedAt),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    runtime: liveRuntime(route),
    runs,
  })
  return { report, path: writeEvalReport(report, evalRunsDirectory(options.root)), route }
}

/**
 * Read the shipped roster.
 * @returns every golden case the package ships, in file order.
 */
export function liveRoster(): readonly GoldenCase[] {
  return loadGoldenCases(ROSTER_DIRECTORY)
}
