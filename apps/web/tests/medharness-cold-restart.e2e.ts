// Web e2e scenario: a cold restart of the whole runtime, over the same durable
// session store.
//
// Everything else in this suite answers "does the running system do X". This
// one answers a different question: after the host process's context is gone —
// new Cordis tree, new session service, new projection registry, new browser —
// does the product still show the record, without anyone typing anything?
//
// That distinction is the whole point. A fixture could produce the same screen
// while proving nothing; a second observation against the SAME context would
// prove only that memory works. So the first run is real, the restart is a real
// dispose, and the second browser opens the intake through the product's own
// Recent Intakes — no prompt, no seeded JSONL.
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'
import { DIAGNOSTICS_DIR, step, watchDiagnostics, type PageDiagnostics } from './medharness-diagnostics.ts'

const OVERLAY = fileURLToPath(new URL('./medharness-product-e2e.overlay.yml', import.meta.url))
const SCRIPTED_PACKAGE = fileURLToPath(new URL('../../../packages/test-support/llm-scripted/package.json', import.meta.url))
const IMAGE_FIXTURE = fileURLToPath(new URL('../../../packages/medical/medical-eval/fixtures/images/synthetic-visible-patch.png', import.meta.url))
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/medharness-product-e2e', import.meta.url))

const TURN_ONE = '我头疼两天，还有点发烧'
const TURN_TWO = '25岁'
const TURN_THREE = '请记录这张图片中的可见信息'

/** The three tools the first run must have driven, in order. */
const EXPECTED_TOOLS = ['medical_case_intake', 'medical_case_update', 'medical_image_observe'] as const

/**
 * Connect one workspace directory through the product's own picker.
 *
 * Tolerant on purpose: a run that already has an active workspace has no
 * picker trigger to click, and that is a normal state rather than a failure —
 * the second launch may restore the workspace from settings. The step only
 * needs to leave the product pointed at `path`, so an already-open picker and
 * an already-connected workspace are both acceptable endings.
 * @param page - the page under test.
 * @param path - the workspace directory to open.
 */
async function connectWorkspace(page: Page, path: string): Promise<void> {
  const trigger = page.getByRole('textbox', { name: '选择工作区' })
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click()
  }
  const picker = page.getByRole('dialog', { name: '选择工作区目录' })
  const opened = await picker.waitFor({ timeout: 8_000 }).then(() => true, () => false)
  if (!opened) return
  await picker.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = picker.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(path)
  await pathInput.press('Enter')
  await picker.getByRole('button', { name: '打开', exact: true }).click()
  await picker.waitFor({ state: 'hidden', timeout: 15_000 })
}

describe('web e2e: a cold restart resumes the same intake', () => {
  let root: string
  let first: WebScaffold
  let second: WebScaffold
  let firstBrowser: Browser
  let secondBrowser: Browser
  let firstPage: Page
  let secondPage: Page
  let diagnostics: PageDiagnostics
  let intakeId: string | undefined
  /**
   * The workspace both runs connect to.
   *
   * Each launch mints its own temp cwd, and the product's Recent Intakes lists
   * the current workspace's sessions — so a second run with a different cwd
   * would see an empty history and the cold resume would be untestable for a
   * reason that has nothing to do with persistence. The test owns this path and
   * connects it through the picker in both runs, which is also how a person
   * returns to their own project.
   */
  let workspace: string
  /**
   * The harness home both runs share.
   *
   * `$DSH_HOME` is where `attachment-local` keeps its bytes
   * (`<home>/attachments/v1`), so a home that dies with the first launch takes
   * the images with it — the session log would survive and the picture it names
   * would not. The scaffold's default home sits inside the workspace it owns,
   * so this case passes its own, OUTSIDE both roots, and keeps it until the end.
   *
   * `harnessHome` already existed on `LaunchOptions` (added so a second host can
   * verify settings across origins), so no new seam was needed — only the
   * observation that attachments live under it too.
   */
  let harnessHome: string

  beforeAll(async () => {
    // The root belongs to this case, not to either scaffold: it has to outlive
    // the first one for the second one to open anything.
    root = await mkdtemp(join(tmpdir(), 'dsh-medharness-cold-'))
    workspace = join(root, 'workspace')
    harnessHome = join(root, 'home')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(harnessHome, { recursive: true })
  }, 60_000)

  afterAll(async () => {
    await secondBrowser?.close()
    await second?.close()
    await firstBrowser?.close()
    await first?.close()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  it('writes a real record, then a fresh runtime reads it back', async () => {
    onTestFailed(() => saveFailureShot(secondPage ?? firstPage, `screenshots/medharness-product-e2e/cold-failure-${process.pid}`))

    // ── First run: produce the record through the product ───────────────────
    first = await launchWebScaffold({
      persistenceRoot: root,
      harnessHome,
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: [SCRIPTED_PACKAGE],
    })
    firstBrowser = await chromium.launch()
    firstPage = await firstBrowser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
    diagnostics = watchDiagnostics(firstPage)

    await step('cold-a-page', firstPage, diagnostics, async () => {
      await firstPage.goto(first.authenticatedUrl, { waitUntil: 'load' })
      await firstPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    })
    await step('cold-a-workspace', firstPage, diagnostics, async () => {
      await connectWorkspace(firstPage, workspace)
    })
    await step('cold-a-intake', firstPage, diagnostics, async () => {
      await firstPage.getByTestId('new-intake').click()
      await firstPage.waitForTimeout(2_000)
    })

    const composer = firstPage.locator('[data-composer-input][contenteditable="true"]')
    await step('cold-a-composer', firstPage, diagnostics, async () => {
      await composer.waitFor({ timeout: 30_000 })
    })

    /** Type one message the way a person does, then submit it. */
    const send = async (text: string): Promise<void> => {
      await composer.click()
      await composer.pressSequentially(text, { delay: 10 })
      await composer.press('Enter')
    }

    const report = firstPage.getByTestId('patient-report')
    const observation = firstPage.getByTestId('image-observation')

    await send(TURN_ONE)
    await expect.poll(async () => await report.innerText(), { timeout: 60_000 }).toContain('记录版本 1')
    await send(TURN_TWO)
    await expect.poll(async () => await report.innerText(), { timeout: 60_000 }).toContain('记录版本 2')

    await firstPage.locator('input[type="file"]').setInputFiles([
      { name: 'patch.png', mimeType: 'image/png', buffer: await readFile(IMAGE_FIXTURE) },
    ])
    await send(TURN_THREE)
    await observation.waitFor({ timeout: 60_000 })
    await expect.poll(async () => await observation.innerText(), { timeout: 60_000 }).toContain('左前臂')
    await expect.poll(async () => await observation.locator('img').evaluate(
      (node: HTMLImageElement) => node.naturalWidth,
    ), { timeout: 30_000 }).toBeGreaterThan(0)

    // ── Capture the durable identity, from the host rather than from the URL ─
    // Onboarding leaves an empty session behind, so the intake is the one that
    // recorded a case — identified by its own events, not by position.
    let observed: Awaited<ReturnType<typeof first.ctx.sessionQuery.observeSession>> | undefined
    for (const session of first.ctx.sessions.list()) {
      using candidate = await first.ctx.sessionQuery.observeSession(session.id)
      if (candidate.events.some(event => event.type === 'medical/image-observation')) {
        intakeId = String(session.id)
        observed = candidate.retain()
        break
      }
    }
    expect(intakeId, 'the first run must have recorded an intake').toBeDefined()
    const firstSrc = await observation.locator('img').getAttribute('src')

    // The events the record is made of, read before the restart so the second
    // run can be compared against them.
    const before = observed!
    const beforeTypes = before.events.map(event => event.type)
    const toolNames = before.events
      .filter(event => event.type === 'tool/call')
      .map(event => String((event.data as { name?: unknown }).name))
    expect(toolNames).toEqual([...EXPECTED_TOOLS])
    expect(before.events.filter(event => event.type === 'medical/case-change')).toHaveLength(2)
    expect(before.events.filter(event => event.type === 'medical/image-observation')).toHaveLength(1)
    const beforeCount = before.events.length

    // ── Hard restart ────────────────────────────────────────────────────────
    // A real dispose, not a reload: the first context, its services, and its
    // browser are all gone before the second one exists.
    await firstBrowser.close()
    // `close()` disposes the tree; the second launch below builds a new one.
    await first.close()

    // The caller-owned home outlived the launch that wrote into it, and the
    // bytes are still in it. No digest path is asserted: the layout under the
    // home is the backend's business, so this only proves the store the second
    // run will read is non-empty.
    // Every entry, not a filtered view: the store names files by digest and the
    // exact layout is its business, so the count itself is the evidence.
    const stored = await readdir(join(harnessHome, 'attachments'), { recursive: true })
    writeFileSync(join(DIAGNOSTICS_DIR, 'cold-attachments.txt'),
      `home: ${harnessHome}\nfiles: ${stored.length}\n${stored.slice(0, 5).join('\n')}\n`)
    expect(stored.length, 'the attachment bytes must survive the first launch').toBeGreaterThan(0)

    // ── Second run: same root, nothing typed ────────────────────────────────
    second = await launchWebScaffold({
      persistenceRoot: root,
      harnessHome,
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: [SCRIPTED_PACKAGE],
    })
    secondBrowser = await chromium.launch()
    secondPage = await secondBrowser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
    diagnostics = watchDiagnostics(secondPage)

    await step('cold-b-page', secondPage, diagnostics, async () => {
      await secondPage.goto(second.authenticatedUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await secondPage.getByTestId('medharness-sidebar').waitFor({ timeout: 30_000 })
      // Returning to the project is a real user step, and it is what makes the
      // intake visible in Recent Intakes.
      await connectWorkspace(secondPage, workspace)
    })

    // ── Open the intake through the product's own navigation ────────────────
    const coldReport = secondPage.getByTestId('patient-report')
    await step('cold-b-open', secondPage, diagnostics, async () => {
      // Clicked through the product's own Recent Intakes, never opened through
      // the host API: the claim under test is that the product can reach the
      // record.
      //
      // Rows are addressed by `intake-row`, not by title. A cold-loaded
      // historical session carries no title projection yet, so its row shows
      // the workspace name — the same string for several rows — and a
      // title-based locator would either miss or pick the wrong one. The
      // product's own signal decides instead: open a row, and keep the one that
      // shows the record.
      const rows = secondPage.getByTestId('intake-row')
      await rows.first().waitFor({ timeout: 30_000 })
      const count = await rows.count()
      expect(count, 'Recent Intakes must list the previous run').toBeGreaterThan(1)
      for (let index = 0; index < count; index += 1) {
        await rows.nth(index).click()
        const found = await expect.poll(
          async () => await coldReport.innerText().catch(() => ''),
          { timeout: 15_000 },
        ).toContain('记录版本 2').then(() => true, () => false)
        if (found) return
      }
      throw new Error(`none of the ${count} intakes held the previous record`)
    })

    // ── Cold UI assertions: nothing was typed ───────────────────────────────
    const coldObservation = secondPage.getByTestId('image-observation')
    await expect.poll(async () => await coldReport.innerText(), { timeout: 60_000 }).toContain('记录版本 2')
    const coldReportText = await coldReport.innerText()
    for (const expected of ['头疼', '发烧', '两天', '25', '必填信息已齐备']) {
      expect(coldReportText, `the cold report must show ${expected}`).toContain(expected)
    }

    await coldObservation.waitFor({ timeout: 30_000 })
    await expect.poll(async () => await coldObservation.innerText(), { timeout: 60_000 }).toContain('左前臂')
    const coldObservationText = await coldObservation.innerText()
    for (const expected of ['可见局部红色斑片', '表面轻微隆起', '单张二维图像无法判断深度', '版本 1']) {
      expect(coldObservationText, `the cold observation must show ${expected}`).toContain(expected)
    }

    // The conversation came back too: the first run's own words are on screen.
    const conversation = await secondPage.locator('body').innerText()
    expect(conversation).toContain(TURN_ONE)
    expect(conversation).toContain('请问您的年龄是多少？')

    // ── Thumbnail, on a NEW page lifetime ───────────────────────────────────
    //
    // This is the criterion that first exposed where the bytes actually live.
    // The durable session log is in the persistence root; the attachment BYTES
    // are under `$DSH_HOME/attachments/v1`. With the scaffold's default home —
    // a directory inside the workspace it owns — the first launch took the
    // images with it, and the cold page restored an observation it could not
    // fetch. This case passes its own home, outside both roots, so the second
    // page reads the same bytes the first one wrote.
    //
    // The two page lifetimes mint different object URLs, so identity is not the
    // assertion — a decoded image is. What this proves is that the second page
    // reached the durable bytes through the ordinary session-authorized read
    // rather than inheriting anything from the first page's memory.
    const coldThumb = coldObservation.locator('img')
    await expect.poll(async () => await coldThumb.evaluate(
      (node: HTMLImageElement) => node.naturalWidth,
    ), { timeout: 30_000 }).toBeGreaterThan(0)
    const geometry = await coldThumb.evaluate((node: HTMLImageElement) => ({
      width: node.naturalWidth, height: node.naturalHeight, src: node.src,
    }))
    expect(geometry.height, 'a decoded image, not a broken one').toBeGreaterThan(0)
    writeFileSync(join(DIAGNOSTICS_DIR, 'cold-thumb.txt'),
      `first: ${firstSrc}\nsecond: ${geometry.src}\n`)
    // And the failure affordance the missing bytes used to raise is gone.
    expect(await secondPage.getByText('图片加载失败').isVisible().catch(() => false),
      'the bytes are present, so no retry prompt may appear').toBe(false)

    await mkdir(SHOT_DIR, { recursive: true })
    await secondPage.screenshot({ path: join(SHOT_DIR, 'cold-resume.png'), fullPage: false })

    // ── No new turn ─────────────────────────────────────────────────────────
    // Opening a record must not create one. The event list is the same list.
    using after = await second.ctx.sessionQuery.observeSession(intakeId as never)
    const afterTypes = after.events.map(event => event.type)
    // The log still holds the first run's three tool calls — that is the record,
    // not a new turn. What must be true is that opening it ran nothing: the
    // prefix is unchanged, no tool ran, and no domain event was written. A model
    // that re-summarized the intake would show up here.
    const appended = afterTypes.slice(beforeCount)
    writeFileSync(join(DIAGNOSTICS_DIR, 'cold-events.txt'),
      `before: ${beforeCount}
after: ${afterTypes.length}
appended: ${JSON.stringify(appended)}
`)
    expect(afterTypes.slice(0, beforeCount), 'the record must be byte-identical').toEqual(beforeTypes)
    expect(appended.filter(type => type === 'tool/call'), 'no tool may run on open').toHaveLength(0)
    expect(appended.filter(type => type === 'medical/case-change'), 'no case may change on open').toHaveLength(0)
    expect(appended.filter(type => type === 'medical/image-observation'), 'no image may be observed on open').toHaveLength(0)
    // The one appended event is the session's own start/end seed — a lifecycle
    // marker the loader writes when it opens a log. It is not a tool call and
    // not a domain event, which is precisely the distinction this case draws.
    expect(appended, 'opening a record may seed its lifecycle, nothing more').toEqual(['session/end-seed'])

    // No host-side projection read here on purpose: the fold is already proven
    // by the panel above, and the service addresses an Agent rather than a
    // session, so a second read would add a seam rather than evidence.
  }, 600_000)
})
