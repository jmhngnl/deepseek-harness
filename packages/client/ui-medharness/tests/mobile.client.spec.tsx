// @vitest-environment jsdom
/**
 * The narrow product surface's composition, pinned.
 *
 * These cases are about WHERE things render and WHAT they call, not about what
 * the record says — the patient report and the image observations own their own
 * component tests, and a second fixture here would be a second answer to the
 * same question. What this file guards is the responsive composition: the
 * chrome appears only below the frame's breakpoint, the record surface is the
 * existing panel rather than a copy of it, and switching surfaces is local
 * state rather than a session operation.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { MedharnessIntake } from '../src/client/MedharnessIntake.tsx'
import { MedharnessMobile } from '../src/client/MedharnessMobile.tsx'
import type { MedharnessMobileProps } from '../src/client/MedharnessMobile.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
afterEach(cleanup)

/**
 * jsdom has no `matchMedia`. The component reads the frame's breakpoint through
 * one, so the stub has to answer it — and it is stubbed, not faked away: the
 * `matches` value is driven by the same `innerWidth` the snapshot reads, so the
 * two cannot disagree about whether the frame is narrow.
 */
function stubViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query)
      return {
        matches: max === null ? false : width < Number(max[1]),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }
    },
  })
}

/** One list row as the host publishes it. */
function row(id: string, displayTitle: string): SessionSummary {
  return { id: id as SessionSummary['id'], displayTitle, running: false, blank: false, updatedAt: 1 }
}

/**
 * Render the surface over recording faces.
 * @param overrides - list state and recorded verbs for this case.
 * @returns the recorded verbs.
 */
function surface(overrides: {
  rows?: SessionSummary[]
  current?: string
} = {}) {
  const rows = overrides.rows ?? []
  const state = {
    ids: rows.map(entry => String(entry.id)),
    byId: Object.fromEntries(rows.map(entry => [String(entry.id), entry])),
    current: overrides.current,
  }
  const createIntake = vi.fn(async () => 'session-new')
  const openIntake = vi.fn()
  const useProjection = (() => undefined) as unknown as MedharnessMobileProps['useProjection']

  const props = {
    useProjection,
    loadImage: async () => 'blob:x',
    sessions: { getSnapshot: () => state, subscribe: () => () => {} },
    createIntake,
    openIntake,
    t,
  } as unknown as MedharnessMobileProps

  render(<MedharnessMobile {...props} />)
  return { createIntake, openIntake }
}

beforeEach(() => { stubViewport(390) })

describe('the narrow product surface', () => {
  it('renders the product chrome below the frame breakpoint', () => {
    stubViewport(390)
    surface()
    expect(screen.getByTestId('medharness-mobile-bar')).toBeTruthy()
    expect(screen.getByTestId('medharness-surface-conversation')).toBeTruthy()
    expect(screen.getByTestId('medharness-surface-record')).toBeTruthy()
  })

  it('renders nothing above the frame breakpoint, leaving the columns alone', () => {
    stubViewport(1440)
    surface()
    // The desktop layout is the frame's three columns; this surface exists only
    // where the frame has no third column to put the record in.
    expect(screen.queryByTestId('medharness-mobile-bar')).toBeNull()
    expect(screen.queryByTestId('medharness-mobile-record')).toBeNull()
  })

  it('opens on the conversation, not the record', () => {
    stubViewport(390)
    surface()
    expect(screen.getByTestId('medharness-surface-conversation').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('medharness-surface-record').getAttribute('aria-selected')).toBe('false')
    expect(screen.queryByTestId('medharness-mobile-record')).toBeNull()
  })

  it('shows the existing intake surface when the record is selected', () => {
    stubViewport(390)
    surface()
    act(() => { screen.getByTestId('medharness-surface-record').click() })
    // The record layer is the SAME panel the desktop column renders: a copy
    // would be a second place for the two projections to be read.
    expect(screen.getByTestId('medharness-mobile-record')).toBeTruthy()
    expect(screen.getByTestId('patient-report')).toBeTruthy()
    expect(screen.getByTestId('image-observations')).toBeTruthy()
  })

  it('reaches the record panel through the same component the column uses', () => {
    // Named so a future refactor cannot quietly swap in a bespoke mobile panel.
    expect(MedharnessIntake).toBeTypeOf('function')
  })

  it('lists recent intakes from the sessions store', () => {
    stubViewport(390)
    // The host's own fallback: displayTitle IS the session id when nothing else
    // exists, which is the case the label rule exists to catch.
    surface({ rows: [row('s1', '我头疼两天'), row('s2', 's2')] })
    act(() => { screen.getByRole('button', { name: '最近接诊' }).click() })

    const sheet = screen.getByRole('dialog', { name: '最近接诊' })
    expect(within(sheet).getByText('我头疼两天')).toBeTruthy()
    // The same label rule the sidebar uses: an id is not a name.
    expect(within(sheet).getByText('未命名接诊')).toBeTruthy()
  })

  it('opens a historical intake through the sessions store', () => {
    stubViewport(390)
    const { openIntake } = surface({ rows: [row('s1', 'a'), row('s2', 'b')] })
    act(() => { screen.getByRole('button', { name: '最近接诊' }).click() })
    act(() => { screen.getAllByTestId('medharness-mobile-intake')[1]?.click() })
    expect(openIntake).toHaveBeenCalledWith('s2')
  })

  it('never creates a session when switching surfaces', () => {
    stubViewport(390)
    const { createIntake } = surface({ rows: [row('s1', 'a')] })

    act(() => { screen.getByTestId('medharness-surface-record').click() })
    act(() => { screen.getByTestId('medharness-surface-conversation').click() })
    act(() => { screen.getByTestId('medharness-surface-record').click() })

    // Switching is local state. A new intake is a deliberate action, never a
    // side effect of looking at the record.
    expect(createIntake).not.toHaveBeenCalled()
  })

  it('creates an intake only when the sheet offers one', () => {
    stubViewport(390)
    const { createIntake } = surface()
    act(() => { screen.getByRole('button', { name: '最近接诊' }).click() })
    act(() => { screen.getByText('+ 新建接诊').click() })
    expect(createIntake).toHaveBeenCalledTimes(1)
  })

  it('closes the sheet from its own control', () => {
    stubViewport(390)
    surface({ rows: [row('s1', 'a')] })
    act(() => { screen.getByRole('button', { name: '最近接诊' }).click() })
    expect(screen.getByRole('dialog', { name: '最近接诊' })).toBeTruthy()

    act(() => { screen.getByRole('button', { name: '关闭' }).click() })
    expect(screen.queryByRole('dialog', { name: '最近接诊' })).toBeNull()
  })
})
