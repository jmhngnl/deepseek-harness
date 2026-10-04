/**
 * Failure capture for the product E2E's setup.
 *
 * The setup runs in `beforeAll`, where vitest's `onTestFailed` never fires — so
 * the first run of this case failed with nothing but a locator timeout, and no
 * way to tell whether the page had booted, which step had stopped, or what the
 * host had said. This helper exists so the next failure is a description rather
 * than a guess.
 *
 * It captures the page AND the host. A boot that never reaches the browser
 * leaves its reason in the host's own log, which no screenshot can show.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Page } from 'playwright'

/** Where every capture lands. Outside the committed inventory, like screenshots. */
export const DIAGNOSTICS_DIR = fileURLToPath(new URL('../../../.artifacts/diagnostics/medharness-product-e2e', import.meta.url))

/** Everything a browser session can be asked about itself. */
export interface PageDiagnostics {
  /** Console messages, all levels — a boot failure is often a console error. */
  readonly console: string[]
  /** Uncaught page errors. */
  readonly pageErrors: string[]
  /** Requests that never completed. */
  readonly requestFailures: string[]
}

/**
 * Watch a page and accumulate its diagnostics.
 * @param page - the page to watch.
 * @returns the live accumulator.
 */
export function watchDiagnostics(page: Page): PageDiagnostics {
  const console: string[] = []
  const pageErrors: string[] = []
  const requestFailures: string[] = []
  page.on('console', (message) => { console.push(`[${message.type()}] ${message.text()}`) })
  page.on('pageerror', (error) => { pageErrors.push(String(error)) })
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`)
  })
  return { console, pageErrors, requestFailures }
}

/**
 * Capture one labelled moment: the page as an image, as markup, and as text,
 * plus everything the browser said.
 * @param page - the page to capture.
 * @param stage - the setup step that is being reported.
 * @param diagnostics - the accumulator from {@link watchDiagnostics}.
 * @param hostLog - host output, when the scaffold exposes it.
 */
export async function captureStage(
  page: Page,
  stage: string,
  diagnostics: PageDiagnostics,
  hostLog = '',
): Promise<void> {
  mkdirSync(DIAGNOSTICS_DIR, { recursive: true })
  const at = (name: string): string => join(DIAGNOSTICS_DIR, `${stage}-${name}`)

  // Each capture is independent: one failing read must not cost the others.
  const attempt = async (name: string, run: () => Promise<string> | string): Promise<void> => {
    try {
      writeFileSync(at(name), await run())
    } catch (error: unknown) {
      writeFileSync(at(`${name}.error`), String(error))
    }
  }

  await attempt('page.png', async () => { await page.screenshot({ path: at('page.png') }); return '' })
  await attempt('page-full.png', async () => { await page.screenshot({ path: at('page-full.png'), fullPage: true }); return '' })
  await attempt('url.txt', () => `${page.url()}\n`)
  await attempt('title.txt', async () => `${await page.title()}\n`)
  await attempt('body.txt', async () => await page.locator('body').innerText())
  await attempt('page.html', async () => await page.content())
  await attempt('browser-console.txt', () => diagnostics.console.join('\n'))
  await attempt('page-errors.txt', () => diagnostics.pageErrors.join('\n'))
  await attempt('request-failures.txt', () => diagnostics.requestFailures.join('\n'))
  await attempt('host-log.txt', () => hostLog)
}

/**
 * Report one setup step, capturing the page when it throws.
 * @param stage - the step's name.
 * @param page - the page under test.
 * @param diagnostics - the accumulator.
 * @param run - the step itself.
 * @param hostLog - host output, when available.
 * @throws the step's own error, after the capture lands.
 */
export async function step(
  stage: string,
  page: Page,
  diagnostics: PageDiagnostics,
  run: () => Promise<void>,
  hostLog = '',
): Promise<void> {
  try {
    await run()
  } catch (error: unknown) {
    await captureStage(page, stage, diagnostics, hostLog)
    throw new Error(`setup step "${stage}" failed: ${String(error)}`, { cause: error })
  }
}
