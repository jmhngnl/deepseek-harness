// @vitest-environment jsdom
/**
 * Product coverage for the navigation column: what a person sees when they
 * arrive, and what the two verbs actually call.
 *
 * The column is a pure renderer over an injected sessions face, so these cases
 * drive it with the exact list state the host publishes and with recorded
 * create/open calls. That is the point: the tests prove the column reads the
 * real sessions service and mints nothing of its own.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { MedharnessSidebar } from '../src/client/MedharnessSidebar.tsx'
import type { MedharnessSidebarListState, MedharnessSidebarProps } from '../src/client/MedharnessSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
afterEach(cleanup)

/** One list row as the host publishes it. */
function row(id: string, displayTitle: string, updatedAt: number): SessionSummary {
  return {
    id: id as SessionSummary['id'],
    displayTitle,
    running: false,
    blank: false,
    updatedAt,
  }
}

/** A fixed list store, plus the two verbs, as the plugin injects them. */
function face(state: Partial<MedharnessSidebarListState> = {}, overrides: Partial<MedharnessSidebarProps> = {}) {
  const full: MedharnessSidebarListState = {
    ids: [], byId: {}, current: undefined, phase: 'ready', ...state,
  }
  const createIntake = vi.fn(async () => 'session-new')
  const openIntake = vi.fn()
  const props = {
    collapsed: false,
    sessions: { getSnapshot: () => full, subscribe: () => () => {} },
    createIntake,
    openIntake,
    t,
    ...overrides,
  } as unknown as MedharnessSidebarProps
  return { props, createIntake, openIntake }
}

describe('the intake navigation column', () => {
  it('leads with the product brand, not the harness one', () => {
    const { props } = face()
    render(<MedharnessSidebar {...props} />)
    const column = screen.getByTestId('medharness-sidebar')
    expect(within(column).getByText('MedHarness')).toBeTruthy()
    expect(within(column).getByText('AI 就诊前信息采集')).toBeTruthy()
  })

  it('carries no coding-agent navigation', () => {
    const { props } = face({ ids: ['s1'], byId: { s1: row('s1', '我头疼两天', 1_700_000_000_000) } })
    render(<MedharnessSidebar {...props} />)
    const text = screen.getByTestId('medharness-sidebar').textContent ?? ''
    // The developer seats are not hidden by CSS: they are not in this column.
    for (const banned of ['Workspace', 'Terminal', 'Files', 'Jobs', 'Settings',
      'Plugin', 'Tool', 'Cordis', 'Projection', 'Event Log', 'Preset']) {
      expect(text, `the column must not mention ${banned}`).not.toContain(banned)
    }
  })

  it('offers New Intake through the existing sessions create call', async () => {
    const { props, createIntake } = face()
    render(<MedharnessSidebar {...props} />)
    screen.getByTestId('new-intake').click()
    await vi.waitFor(() => { expect(createIntake).toHaveBeenCalledTimes(1) })
    // No client-minted identity: the call takes no arguments and the column
    // uses whatever identity the host returns.
    expect(createIntake).toHaveBeenCalledWith()
  })

  it('disables the action while a create is in flight, so one click is one intake', async () => {
    let release: (id: string) => void = () => {}
    const createIntake = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const { props } = face({}, { createIntake })
    render(<MedharnessSidebar {...props} />)

    const button: HTMLButtonElement = screen.getByTestId('new-intake')
    button.click()
    button.click()
    await vi.waitFor(() => { expect(button.disabled).toBe(true) })
    expect(createIntake).toHaveBeenCalledTimes(1)

    release('session-new')
    await vi.waitFor(() => { expect(screen.getByTestId('new-intake').textContent).toContain('新建接诊') })
  })

  it('renders recent intakes from the host list, with a readable time', () => {
    const { props } = face({
      ids: ['s1', 's2'],
      byId: {
        s1: row('s1', '我头疼两天', Date.now()),
        s2: row('s2', '图片信息采集', Date.now() - 86_400_000),
      },
    })
    render(<MedharnessSidebar {...props} />)
    const rows = screen.getAllByTestId('intake-row')
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('我头疼两天'),
      expect.stringContaining('图片信息采集'),
    ])
    expect(rows[0]?.textContent).toContain('今天')
    expect(rows[1]?.textContent).toContain('昨天')
  })

  it('uses the host display title, which already falls back safely', () => {
    // The host composes displayTitle from the durable title, then the project
    // basename, then the id; the column renders it verbatim and never invents
    // a title of its own.
    const { props } = face({ ids: ['s1'], byId: { s1: row('s1', 'session-5481fe7b', 1_700_000_000_000) } })
    render(<MedharnessSidebar {...props} />)
    expect(screen.getByTestId('intake-row').textContent).toContain('session-5481fe7b')
  })

  it('hides subagent-origin sessions from the intake list', () => {
    const { props } = face({
      ids: ['s1', 'child'],
      byId: {
        s1: row('s1', '我头疼两天', 1_700_000_000_000),
        child: { ...row('child', 'subagent', 1_700_000_000_000), origin: 'subagent' },
      },
    })
    render(<MedharnessSidebar {...props} />)
    expect(screen.getAllByTestId('intake-row')).toHaveLength(1)
  })

  it('marks the current intake without relying on colour alone', () => {
    const { props } = face({
      ids: ['s1', 's2'],
      byId: { s1: row('s1', 'a', 1), s2: row('s2', 'b', 2) },
      current: 's2',
    })
    render(<MedharnessSidebar {...props} />)
    const rows = screen.getAllByTestId('intake-row')
    expect(rows[0]?.getAttribute('aria-current')).toBeNull()
    expect(rows[1]?.getAttribute('aria-current')).toBe('true')
  })

  it('opens another intake through the existing sessions open call', () => {
    const { props, openIntake } = face({
      ids: ['s1', 's2'],
      byId: { s1: row('s1', 'a', 1), s2: row('s2', 'b', 2) },
    })
    render(<MedharnessSidebar {...props} />)
    screen.getAllByTestId('intake-row')[1]?.click()
    expect(openIntake).toHaveBeenCalledWith('s2')
  })

  it('shows a first-intake prompt rather than an empty column', () => {
    const { props } = face()
    render(<MedharnessSidebar {...props} />)
    expect(screen.getByText('还没有历史接诊。')).toBeTruthy()
    expect(screen.getByText('开始第一次接诊')).toBeTruthy()
  })

  it('says it is loading instead of showing an empty state', () => {
    const { props } = face({ phase: 'pending' })
    render(<MedharnessSidebar {...props} />)
    expect(screen.getByText('正在加载接诊…')).toBeTruthy()
    expect(screen.queryByText('还没有历史接诊。')).toBeNull()
  })

  it('reports a create failure in the product voice', async () => {
    const createIntake = vi.fn(() => Promise.reject(new Error('RemoteError: gateway/internal at packages/...')))
    const { props } = face({}, { createIntake })
    render(<MedharnessSidebar {...props} />)
    screen.getByTestId('new-intake').click()
    await vi.waitFor(() => { expect(screen.getByText('无法创建新的接诊。')).toBeTruthy() })
    // The internal message never reaches the person.
    expect(screen.getByTestId('medharness-sidebar').textContent).not.toContain('RemoteError')
    expect(screen.getByTestId('medharness-sidebar').textContent).not.toContain('packages/')
  })

  it('collapses to the brand mark, keeping the rail geometry the frame solved', () => {
    const { props } = face({}, { collapsed: true })
    render(<MedharnessSidebar {...props} />)
    expect(screen.getByTestId('medharness-sidebar').textContent).toBe('M')
  })
})
