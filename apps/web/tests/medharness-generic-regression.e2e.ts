// Web e2e scenario: the generic Web surface still speaks the way it always has.
//
// The presentation seam this case guards is the one a vertical product uses to
// replace the shipped words. The risk it introduces is not that the product's
// copy is wrong — the MedHarness case owns that — but that the SHIPPED copy
// changed underneath everyone who never registers anything. So this case boots
// the plain composition, with no overlay, and asserts the vendor's own words
// are still exactly where they were.
//
// Keyless: the scaffold's composition is `dsh-base` + `dsh-web-app` over an
// empty root, and no model call is made.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/medharness-visual', import.meta.url))

/** The shipped strings this case exists to protect, as the vendor wrote them. */
const SHIPPED = {
  headline: '探索未至之境',
  placeholder: '描述你想要构建的内容, / 调用指令, @ 文件或对话',
} as const

/** The product strings that must NOT appear on a composition without the product. */
const PRODUCT_ONLY = ['开始本次信息采集', '描述症状或补充信息'] as const

describe('web e2e: the generic surface keeps its shipped presentation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // No `extraOverlayPath`: this is the composition a plain `dsh web` boots.
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('still shows the shipped hero, placeholder, and coding hints', async () => {
    onTestFailed(() => saveFailureShot(page, `screenshots/medharness-visual/generic-failure-${process.pid}`))

    const hero = page.getByText(SHIPPED.headline, { exact: true })
    await hero.waitFor({ timeout: 15_000 })

    // The placeholder is a DOM attribute, and the slash/@ hints live INSIDE it:
    // one string carries all three, which is why the product replaces it whole
    // and why this case must see it whole.
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await expect.poll(async () => await composer.getAttribute('data-placeholder'), { timeout: 15_000 })
      .toBe(SHIPPED.placeholder)

    const body = (await page.locator('body').innerText()).concat(
      await composer.getAttribute('data-placeholder') ?? '',
    )
    for (const productOnly of PRODUCT_ONLY) {
      expect(body, `the generic surface must not show ${productOnly}`).not.toContain(productOnly)
    }

    const shot = join(SHOT_DIR, 'generic-web.png')
    await page.screenshot({ path: shot, fullPage: false })

    if (tripwire.pageErrors.length > 0) throw new Error(`page errors: ${tripwire.pageErrors.join(' | ')}`)
  }, 180_000)
})
