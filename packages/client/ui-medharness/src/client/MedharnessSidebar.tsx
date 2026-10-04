/**
 * The MedHarness product sidebar: who this page is, how to start, and what
 * came before.
 *
 * It replaces the harness navigation column outright — Workspaces, the file
 * tree, terminals, jobs, settings, and the developer seats are not hidden here,
 * they are simply not part of this column. A person arriving at an intake
 * should see their own appointments, not a coding agent's toolbox.
 *
 * Everything it reads and does goes through the sessions service the rest of
 * the product already uses: the same list store the generic sidebar reads, the
 * same create call, the same open call. There is no second intake store and no
 * client-minted identity — a new intake IS a harness session, created on the
 * host.
 */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from './locales.ts'
import css from './MedharnessSidebar.module.css'

/**
 * The injected face: the sessions read feed plus the two verbs. The component
 * never reaches for a service — a deployment can therefore mount this column
 * over any sessions implementation that publishes the same face.
 */
export interface MedharnessSidebarInjected {
  /**
   * The same list snapshot the generic sidebar reads; `current` rides it. A
   * plain injected property rather than a framework hook seat: this column is
   * root-scoped, so it has no session standard kit to hang a hook on, and the
   * store already satisfies useSyncExternalStore's contract.
   */
  readonly sessions: {
    getSnapshot(): MedharnessSidebarListState
    subscribe(listener: () => void): () => void
  }
  /** Create an intake on the host and return its identity. */
  readonly createIntake: () => Promise<string>
  /** Make one intake the current one. */
  readonly openIntake: (id: string) => void
}

/**
 * The slice of the sessions list this column renders. Narrower than the service
 * snapshot on purpose: the column must not grow a dependency on fields it does
 * not draw.
 */
export interface MedharnessSidebarListState {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummary>>
  readonly current: string | undefined
  readonly phase: string
}

/** The column's composed props: the frame's column share, the injected face, and copy. */
export type MedharnessSidebarProps =
  & PropsRuntime<'sidebar'>
  & MedharnessSidebarInjected
  & PropsLocale<'medharness'>

/** Format one timestamp the way a person reads a schedule, not a log. */
function when(updatedAt: number, t: TranslateNS<'medharness'>): string {
  const then = new Date(updatedAt)
  const now = new Date()
  const sameDay = then.toDateString() === now.toDateString()
  const time = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `${t('time.today')} ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) return `${t('time.yesterday')} ${time}`
  return `${String(then.getMonth() + 1).padStart(2, '0')}-${String(then.getDate()).padStart(2, '0')} ${time}`
}

/**
 * Draw the product navigation column.
 * @param props - the frame's column share, the injected sessions face, and copy.
 * @returns the column body.
 */
export function MedharnessSidebar({
  collapsed, sessions, createIntake, openIntake, t,
}: MedharnessSidebarProps) {
  // Bound through arrows: the store is an injected object, and passing its
  // methods unbound would detach them from it.
  const state = useSyncExternalStore(
    listener => sessions.subscribe(listener),
    () => sessions.getSnapshot(),
  )
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState<'create' | 'list' | null>(null)
  // React state disables the control on the NEXT render; the ref closes the
  // same-render window, so two clicks dispatched in one tick cannot both start
  // an intake. The state is still what the button reads.
  const inFlight = useRef(false)

  const start = useCallback(() => {
    // The guard is the disabled attribute's source of truth, so a second click
    // in the same render window cannot start a second intake.
    if (inFlight.current) return
    inFlight.current = true
    setCreating(true)
    setFailed(null)
    void createIntake().then(
      () => { inFlight.current = false; setCreating(false) },
      () => { inFlight.current = false; setCreating(false); setFailed('create') },
    )
  }, [createIntake])

  const rows = state.ids
    .map(id => state.byId[id])
    .filter((row): row is SessionSummary => row !== undefined && row.origin !== 'subagent')

  // The rail is the frame's collapsed state, not this column's decision: it
  // renders the brand mark alone rather than a squeezed list.
  if (collapsed) {
    return (
      <nav className={css.rail} aria-label={t('brand.name')} data-testid="medharness-sidebar">
        <span className={css.railMark} aria-hidden="true">M</span>
      </nav>
    )
  }

  return (
    <nav className={css.column} aria-label={t('brand.name')} data-testid="medharness-sidebar">
      <header className={css.brand}>
        <h1 className={css.brandName}>{t('brand.name')}</h1>
        <p className={css.brandTagline}>{t('brand.tagline')}</p>
      </header>

      <button
        type="button"
        className={css.primary}
        onClick={start}
        disabled={creating}
        data-testid="new-intake"
      >
        {creating ? t('action.creating') : t('action.newIntake')}
      </button>

      {failed === 'create' ? <p className={css.error}>{t('error.create')}</p> : null}

      <section className={css.recent}>
        <h2 className={css.recentTitle}>{t('recent.title')}</h2>

        {state.phase === 'pending' ? (
          <p className={css.hint}>{t('recent.loading')}</p>
        ) : failed === 'list' ? (
          <p className={css.error}>{t('error.list')}</p>
        ) : rows.length === 0 ? (
          <div className={css.empty}>
            <p className={css.hint}>{t('recent.empty')}</p>
            <button type="button" className={css.secondary} onClick={start} disabled={creating}>
              {t('recent.emptyAction')}
            </button>
          </div>
        ) : (
          <ul className={css.list}>
            {rows.map(row => (
              <li key={row.id}>
                <button
                  type="button"
                  className={row.id === state.current ? css.rowActive : css.row}
                  aria-current={row.id === state.current ? 'true' : undefined}
                  onClick={() => { openIntake(row.id) }}
                  data-testid="intake-row"
                >
                  <span className={css.rowTime}>{when(row.updatedAt, t)}</span>
                  <span className={css.rowTitle}>{row.displayTitle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </nav>
  )
}
