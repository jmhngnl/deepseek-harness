// Web e2e scenario: a populated intake, driven through the real runtime.
//
// The claim this case makes is architectural, so it is worth stating plainly:
// the browser types Chinese into a composer, and everything after that is the
// real system. The agent loop decides to call a tool, the tool registry
// validates and dispatches it, the medical domain writes a durable session
// event, the projection folds that event, the wire carries the folded value,
// and the panel the person is looking at redraws. The ONLY stand-in is the
// model, which is a script in the overlay.
//
// Keyless: the scripted route is the only registered adapter.
//
// The setup is staged and every step captures the page on failure. The first
// attempt at this case failed inside `beforeAll` with a bare locator timeout,
// which said nothing about whether the page had booted, which step had
// stopped, or what the host had said — so the staging and the capture are part
// of the case, not scaffolding around it.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'
import { step, watchDiagnostics, type PageDiagnostics } from './medharness-diagnostics.ts'

const OVERLAY = fileURLToPath(new URL('./medharness-product-e2e.overlay.yml', import.meta.url))
const SCRIPTED_PACKAGE = fileURLToPath(new URL('../../../packages/test-support/llm-scripted/package.json', import.meta.url))
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/medharness-product-e2e', import.meta.url))

/** The route the overlay's scripted row serves, and the model it advertises. */
const SCRIPTED_PROVIDER = 'medharness-e2e'
const SCRIPTED_MODEL = 'scripted'


/** What the person types, and what the record must become. */
const TURN_ONE = '我头疼两天，还有点发烧'
const TURN_TWO = '25岁'

/** Photograph the product panel as it stands. */
async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false })
}

describe('web e2e: a populated intake through the real runtime', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let diagnostics: PageDiagnostics

  beforeAll(async () => {
    // ── STEP A: the host itself ─────────────────────────────────────────────
    // The composition is resolved before a browser exists, so a boot failure
    // here has no page to photograph. The error text is the evidence.
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      // The scripted row is a workspace package the installation's dependency
      // closure does not otherwise name, so its manifest has to be handed over
      // for the module fallback to resolve it.
      extraInstallAnchors: [SCRIPTED_PACKAGE],
    })

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    diagnostics = watchDiagnostics(page)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('records a case from a typed sentence, then completes it', async () => {
    onTestFailed(() => saveFailureShot(page, `screenshots/medharness-product-e2e/failure-${process.pid}`))

    // ── STEP B: the page ────────────────────────────────────────────────────
    await step('b-page', page, diagnostics, async () => {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    })

    // ── STEP C: workspace onboarding ────────────────────────────────────────
    await step('c-workspace', page, diagnostics, async () => {
      mkdirSync(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
      await page.getByRole('textbox', { name: '选择工作区' }).click()
      const picker = page.getByRole('dialog', { name: '选择工作区目录' })
      await picker.waitFor({ timeout: 10_000 })
      await picker.getByRole('button', { name: '编辑路径' }).click()
      const pathInput = picker.getByRole('textbox', { name: '编辑路径' })
      await pathInput.fill(join(scaffold.workspaceCwd, 'workspace'))
      await pathInput.press('Enter')
      await picker.getByRole('button', { name: '打开', exact: true }).click()
      await picker.waitFor({ state: 'hidden', timeout: 15_000 })
    })

    // ── STEP D: the product shell ───────────────────────────────────────────
    await step('d-shell', page, diagnostics, async () => {
      await page.getByTestId('medharness-sidebar').waitFor({ timeout: 15_000 })
      await page.getByTestId('new-intake').waitFor({ timeout: 15_000 })
    })

    // ── STEP E: an intake on stage ──────────────────────────────────────────
    // A fresh workspace does not necessarily open a Session, and the composer
    // belongs to one. The product's own New Intake is the real user step, so
    // the case takes it rather than creating a Session behind the UI.
    await step('e-intake', page, diagnostics, async () => {
      await page.getByTestId('new-intake').click()
      await page.waitForTimeout(2_000)
    })

    // ── STEP F: the composer ────────────────────────────────────────────────
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await step('f-composer', page, diagnostics, async () => {
      await composer.waitFor({ timeout: 30_000 })
    })

    // ── What actually decides which provider is called ──────────────────────
    //
    // An earlier version of this case asserted that every real provider route
    // was UNRESOLVABLE here. That assertion was wrong, and running it is how we
    // learned so: `deepseek-official` IS registered in this composition —
    // the scaffold disables the direct adapters for STREAMING, it does not
    // remove their registrations. So a registry-level negative tripwire cannot
    // be written for this lane, and claiming one existed would have been worse
    // than having none.
    //
    // What IS checkable is the thing that actually routes a call: the model the
    // agent selects. The overlay pins it to the scripted route, and this asserts
    // that pin — because a real provider is only reachable if something selects
    // one.
    const resolved = await scaffold.ctx.llm.resolveModelInfo(SCRIPTED_PROVIDER, SCRIPTED_MODEL)
    expect(resolved, 'the overlay scripted route must resolve').toBeTruthy()
    expect(
      scaffold.ctx.agentDefaultModel.currentSelection(),
      'the agent must select the scripted route, not a real provider',
    ).toMatchObject({ provider: SCRIPTED_PROVIDER, model: SCRIPTED_MODEL })
    /** Type one message the way a person does, then submit it. */
    const send = async (text: string): Promise<void> => {
      await composer.click()
      await composer.pressSequentially(text, { delay: 10 })
      await composer.press('Enter')
    }

    // ── Turn 1 ──────────────────────────────────────────────────────────────
    await send(TURN_ONE)

    const report = page.getByTestId('patient-report')
    await expect.poll(async () => await report.innerText(), { timeout: 60_000 }).toContain('头疼')
    await expect.poll(async () => await report.innerText(), { timeout: 60_000 }).toContain('发烧')

    const afterFirst = await report.innerText()
    expect(afterFirst, 'the duration the person stated').toContain('两天')
    expect(afterFirst, 'an age nobody gave yet').toContain('未提供')
    expect(afterFirst, 'the first revision').toContain('记录版本 1')
    expect(await page.locator('body').innerText()).toContain('请问您的年龄是多少？')

    await shoot(page, 'text-revision-1')

    // ── Turn 2 ──────────────────────────────────────────────────────────────
    await send(TURN_TWO)

    await expect.poll(async () => await report.innerText(), { timeout: 60_000 }).toContain('记录版本 2')
    const afterSecond = await report.innerText()
    expect(afterSecond, 'the age the person supplied').toContain('25')
    expect(afterSecond, 'all three required facts').toContain('必填信息已齐备')

    await shoot(page, 'text-revision-2')

    if (tripwire.pageErrors.length > 0) throw new Error(`page errors: ${tripwire.pageErrors.join(' | ')}`)
  }, 300_000)

  it('drives the real tool registry and writes real domain events', async () => {
    // The browser assertions above prove the PANEL; these prove the ROUTE. A
    // fixture could produce the same screen, so the durable log is what makes
    // the difference visible: the events below were written by the medical
    // domain in response to tool calls the agent loop made.
    //
    // Read through the same query the Web history path uses, after the turn's
    // persistence flush — not from anything this process kept in memory.
    // The turn already settled: the browser waited for the second revision to
    // appear, which cannot happen before the domain wrote it and the
    // projection folded it. So the current selection IS the session under test.
    // The workspace onboarding leaves an empty session behind, so the intake is
    // the one that actually recorded a case — identified by its own events, not
    // by position in a list.
    const open = scaffold.ctx.sessions.list()
    let observation: Awaited<ReturnType<typeof scaffold.ctx.sessionQuery.observeSession>> | undefined
    for (const session of open) {
      using candidate = await scaffold.ctx.sessionQuery.observeSession(session.id)
      if (candidate.events.some(event => event.type === 'medical/case-change')) { observation = candidate.retain(); break }
    }
    expect(observation, 'an intake that recorded a case').toBeDefined()
    const events = observation!.events
    const types = events.map(event => event.type)

    // Two turns, so two rounds of model -> tool -> model.
    expect(types.filter(type => type === 'tool/call')).toHaveLength(2)

    const calls = events
      .filter(event => event.type === 'tool/call')
      .map(event => String((event.data as { name?: unknown }).name))
    expect(calls).toEqual(['medical_case_intake', 'medical_case_update'])

    // The domain's own events: full snapshots, each carrying the whole record.
    const changes = events
      .filter(event => event.type === 'medical/case-change')
      .map(event => event.data as { operation?: unknown; case?: { revision?: unknown; age?: unknown; symptoms?: unknown } })
    expect(changes.map(change => change.operation)).toEqual(['create', 'update'])
    expect(changes.map(change => change.case?.revision)).toEqual([1, 2])
    expect(changes[0]?.case?.symptoms).toEqual(['头疼', '发烧'])
    expect(changes[0]?.case?.age).toBeNull()
    expect(changes[1]?.case?.age).toBe(25)
  })
})
