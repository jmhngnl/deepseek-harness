// @vitest-environment jsdom
/**
 * The right column's ownership, pinned.
 *
 * These cases exist because the column was absent from the real browser on
 * every viewport while every component test passed. Two separate causes were
 * found, and neither was visible from a component test:
 *
 *   1. the product registered into `rightbar.session` — a seat the shipped
 *      right Sidebar declares and renders — so its visibility was owned by
 *      another plugin's panel state;
 *   2. even after taking the slot, the frame allocated a zero-width column
 *      because nothing had reported the right track open.
 *
 * So this file asserts what the plugin registers and what it claims, not what
 * it draws. The component suite already owns the drawing.
 *
 * The registry and the slot registry are the real ones where the distinction
 * matters; the layout service is a recorder, because what is under test is the
 * claim the plugin makes on the frame, and a recorder is the only thing that
 * can observe a claim rather than its effect.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/client/index.ts'
import { MedharnessIntake } from '../src/client/MedharnessIntake.tsx'
import { MedharnessRightbarRoot } from '../src/client/MedharnessRightbarRoot.tsx'
import { apply as hostApply } from '../src/index.ts'

/** One recorded slot registration. */
interface Recorded {
  name: string
  priority?: number
  locale?: string
  children?: Record<string, { kind: string; scope: string }>
  component: unknown
}

/** The priority the product registers below the shipped right Sidebar. */
const SHELL_PRIORITY = -1

/**
 * Boot the plugin over recording faces.
 * @returns the recorded registrations, the layout calls, and the plugin fiber.
 */
async function boot() {
  const ctx = new Context()
  const registered: Recorded[] = []
  const slots = {
    // The plugin's `rightbar` contribution is a generator, because it yields a
    // second registration; running the factory to exhaustion is what the real
    // registry does on inject.
    inject: vi.fn((_name: string, factory: () => unknown) => {
      // A generator factory yields one disposer per registration; collecting
      // them is what lets this case observe teardown at all. The real registry
      // wires each into the injecting fiber the same way.
      const disposers: Array<() => void> = []
      const produced = factory()
      if (typeof produced === 'function') disposers.push(produced as () => void)
      else if (produced !== null && typeof produced === 'object' && Symbol.iterator in produced) {
        for (const yielded of produced as Iterable<unknown>) {
          if (typeof yielded === 'function') disposers.push(yielded as () => void)
        }
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn(() => () => {}),
  }
  const openRightbar = vi.fn()
  const closeRightbar = vi.fn()
  const sessions = { list: { getSnapshot: () => ({ current: undefined }) } }
  const uiConversation = { imageUrl: vi.fn(async () => 'blob:x') }

  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('layout', { openRightbar, closeRightbar } as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('uiConversation', uiConversation as never)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { registered, openRightbar, closeRightbar, fiber }
}

describe('ui-medharness rightbar ownership', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the frame column itself, below the shipped right Sidebar', async () => {
    const { registered } = await boot()
    const column = registered.find(entry => entry.name === 'rightbar')
    expect(column).toBeDefined()
    // The single-slot rule renders the lowest priority, so registering below
    // the shipped Sidebar is what takes the column without replacing it in the
    // tree — the generic `web` profile keeps its own occupant.
    expect(column?.priority).toBe(SHELL_PRIORITY)
    expect(column?.component).toBe(MedharnessRightbarRoot)
  })

  it('declares its own session-scoped child seat', async () => {
    const { registered } = await boot()
    const column = registered.find(entry => entry.name === 'rightbar')
    // A child seat is rendered by whoever declared it. Declaring this one is
    // the whole fix: the product's state can no longer sit inside another
    // plugin's visibility gate.
    expect(column?.children).toEqual({
      'medharness.rightbar.session': { kind: 'single', scope: 'session' },
    })
  })

  it('registers the product content in its own seat, never the shipped one', async () => {
    const { registered } = await boot()
    const content = registered.find(entry => entry.component === MedharnessIntake)
    expect(content?.name).toBe('medharness.rightbar.session')
    // The regression this pins: registering into `rightbar.session` put the
    // intake record behind `ui-sidebar-right`'s `activePanelId` gate, and the
    // column rendered nothing on any viewport.
    expect(registered.map(entry => entry.name)).not.toContain('rightbar.session')
  })

  it('claims the frame track on activation and releases it on dispose', async () => {
    const { openRightbar, closeRightbar, fiber } = await boot()
    // Taking the slot without this leaves the occupant rendering inside a
    // zero-width column: present in the tree, invisible on screen.
    expect(openRightbar).toHaveBeenCalledWith(true, false)
    expect(closeRightbar).not.toHaveBeenCalled()

    await fiber.dispose()
    expect(closeRightbar).toHaveBeenCalledTimes(1)
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { registered, fiber } = await boot()
    expect(registered.length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(registered).toEqual([])
  })

  it('asks nothing of the shipped right Sidebar', () => {
    // The occupant is reachable without that plugin's controller: the plugin's
    // declared services name no sidebar-right face, so a composition without
    // `ui-sidebar-right` still mounts the column.
    expect(inject).not.toContain('sidebarRight')
    expect(inject).not.toContain('sidebarRightTabs')
    expect(inject).toContain('layout')
  })
})
