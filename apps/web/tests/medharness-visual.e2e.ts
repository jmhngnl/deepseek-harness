// Web e2e scenario: the MedHarness product surface, photographed.
//
// This case asserts nothing about behaviour — the component and bundle suites
// own that. What it produces is the evidence a test cannot assert: what the
// page actually looks like at a desktop and a phone viewport, so a person can
// judge whether the product reads as a product.
//
// Keyless by construction: the scaffold's composition is the generic Web tree
// plus this case's overlay, and no model call is made. Screenshots land under
// `.artifacts/`, which is outside the committed snapshot inventory.
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./medharness-visual.overlay.yml', import.meta.url))
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/medharness-visual', import.meta.url))

/** The two viewports a person actually uses, named for the file they produce. */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
] as const

/** Photograph the page as it stands, at the size it currently is. */
async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false })
  // A full-page shot as well: the narrow layout is the one whose overflow this
  // is meant to expose, and a viewport-only shot cannot show content below it.
  await page.screenshot({ path: join(SHOT_DIR, `${name}-full.png`), fullPage: true })
}

describe('web e2e: MedHarness product surface, photographed', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('photographs the desktop and narrow surfaces', async () => {
    onTestFailed(() => saveFailureShot(page, `screenshots/medharness-visual/failure-${process.pid}`))

    // The product columns mount only once a Session is on stage, so this waits
    // for the surface itself rather than for a fixed delay.
    await page.waitForSelector('[data-testid="medharness-sidebar"]', { timeout: 30_000 })
      .catch(() => undefined)

    // Open an intake before photographing: the right column renders inside a
    // session-scoped seat, so with nothing on stage there is nothing to see and
    // the photograph would answer the wrong question.
    const row = page.locator('[data-testid="intake-row"]').first()
    if (await row.count() > 0) {
      await row.click()
      await page.waitForTimeout(1500)
    }

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      // Let the frame's concession solve settle at the new width.
      await page.waitForTimeout(600)
      await shoot(page, viewport.name)
    }

    // The tripwire is evidence, not an assertion: this case photographs what
    // the page looks like, and a console warning is reported by the summary.
    if (tripwire.pageErrors.length > 0) throw new Error(`page errors: ${tripwire.pageErrors.join(' | ')}`)
  }, 180_000)
})
