/**
 * The narrow-viewport product surface: a two-way selector, a record panel, and
 * the intake list.
 *
 * Above the frame's own breakpoint this renders nothing at all, which is what
 * keeps the desktop three-column layout untouched — the desktop columns are
 * still the frame's, and this component only exists to answer the question the
 * frame cannot: on a phone there is no room for a third column, so where does
 * the intake record go?
 *
 * It answers it without a second data path. The record panel renders the same
 * `MedharnessIntake` the desktop column renders, in the same session-scoped
 * seat, reading the same two projections. Switching surfaces is local state
 * and nothing else: no session is created, no projection is re-read, and the
 * conversation underneath is never unmounted — the record panel is a fixed
 * layer over it, so going back is a repaint rather than a restore.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the composer-dock seat this occupant registers into.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'
import { MedharnessIntake } from './MedharnessIntake.tsx'
import type { MedharnessIntakeProps } from './MedharnessIntake.tsx'
import type { MedharnessImageLoader } from './slots.ts'
import css from './MedharnessMobile.module.css'

/**
 * The one breakpoint this surface uses.
 *
 * It is the frame's own: below it the frame already collapses its sidebar and
 * gives the right column no track, so "the frame is narrow" and "this surface
 * takes over" are the same fact rather than two opinions about width. A second
 * set of tablet/tiny steps would drift from the frame the first time either
 * moved.
 */
export const NARROW_MAX_WIDTH = 1024

/** Which product surface the narrow frame is showing. */
export type MedharnessSurface = 'conversation' | 'record'

/**
 * Track the frame's narrow state from the one source a root-scoped seat can
 * read. The layout service publishes actions, not geometry, and the composer
 * dock's owner props carry none either, so the browser's own width is the
 * honest input here.
 * @returns whether the viewport is below the frame's narrow breakpoint.
 */
function useNarrow(): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const media = window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH - 1}px)`)
    media.addEventListener('change', listener)
    return () => { media.removeEventListener('change', listener) }
  }, [])
  const snapshot = useCallback(() => window.innerWidth < NARROW_MAX_WIDTH, [])
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

/** Props: the session-scoped seats this occupant needs, plus copy. */
export type MedharnessMobileProps =
  & PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'medharness'>
  & {
    /** Session-authorized image URL resolution, injected by the plugin body. */
    readonly loadImage: MedharnessImageLoader
    /** The same list snapshot the product sidebar reads. */
    readonly sessions: {
      getSnapshot(): {
        readonly ids: readonly string[]
        readonly byId: Readonly<Record<string, SessionSummary>>
        readonly current: string | undefined
      }
      subscribe(listener: () => void): () => void
    }
    /** Create an intake on the host and return its identity. */
    readonly createIntake: () => Promise<string>
    /** Make one intake the current one. */
    readonly openIntake: (id: string) => void
  }

/** The label a person sees for one intake; mirrors the sidebar's own rule. */
function labelOf(row: SessionSummary, t: TranslateNS<'medharness'>): string {
  const projected = row.projectionValues?.['title']
  if (typeof projected === 'string' && projected.trim() !== '') return projected
  const display = row.displayTitle
  if (display !== '' && display !== String(row.id)) return display
  return t('recent.untitled')
}

/**
 * Draw the narrow product surface.
 * @param props - the composer dock's seats, the injected faces, and copy.
 * @returns the selector, the record layer, and the intake sheet.
 */
export function MedharnessMobile({
  useProjection, sessionId, loadImage, sessions, createIntake, openIntake, t,
}: MedharnessMobileProps) {
  const narrow = useNarrow()
  const [surface, setSurface] = useState<MedharnessSurface>('conversation')
  const [sheetOpen, setSheetOpen] = useState(false)
  const state = useSyncExternalStore(
    listener => sessions.subscribe(listener),
    () => sessions.getSnapshot(),
  )

  // Leaving the narrow frame drops the narrow-only state: a phone's record
  // panel is not a desktop column, and reopening the window wide should not
  // leave a layer behind it.
  useEffect(() => {
    if (!narrow) { setSurface('conversation'); setSheetOpen(false) }
  }, [narrow])

  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setSheetOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [sheetOpen])

  if (!narrow) return null

  const rows = state.ids
    .map(id => state.byId[id])
    .filter((row): row is SessionSummary => row !== undefined && row.origin !== 'subagent')

  // The panels read the projections themselves, in the seat below: passing
  // values down would be a second read of the same two keys.
  return (
    <>
      <header className={css.bar} data-testid="medharness-mobile-bar">
        <button
          type="button"
          className={css.menu}
          aria-label={t('recent.title')}
          aria-expanded={sheetOpen}
          onClick={() => { setSheetOpen(true) }}
        >
          ☰
        </button>
        <span className={css.brand}>{t('brand.name')}</span>
        <div className={css.segmented} role="tablist" aria-label={t('brand.name')}>
          {(['conversation', 'record'] as const).map(candidate => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={surface === candidate}
              className={surface === candidate ? css.segmentActive : css.segment}
              onClick={() => { setSurface(candidate) }}
              data-testid={`medharness-surface-${candidate}`}
            >
              {t(candidate === 'conversation' ? 'surface.conversation' : 'surface.record')}
            </button>
          ))}
        </div>
      </header>

      {surface === 'record' && (
        <section className={css.record} data-testid="medharness-mobile-record" role="tabpanel">
          {/* The same panel the desktop column renders, in the same session
              seat, reading the same two projections. Only its container
              differs, and only because a phone has no third column. */}
          <MedharnessIntake
            {...({ sessionId, useProjection, loadImage, t } as unknown as MedharnessIntakeProps)}
          />
        </section>
      )}

      {sheetOpen && (
        <>
          <div
            className={css.scrim}
            role="presentation"
            onClick={() => { setSheetOpen(false) }}
          />
          <aside className={css.sheet} role="dialog" aria-modal="true" aria-label={t('recent.title')}>
            <div className={css.sheetHead}>
              <span className={css.sheetTitle}>{t('recent.title')}</span>
              <button type="button" className={css.sheetClose} aria-label={t('action.close')} onClick={() => { setSheetOpen(false) }}>
                ✕
              </button>
            </div>
            <button
              type="button"
              className={css.newIntake}
              onClick={() => { void createIntake().then(() => { setSheetOpen(false) }, () => undefined) }}
            >
              {t('action.newIntake')}
            </button>
            {rows.length === 0 ? (
              <p className={css.hint}>{t('recent.empty')}</p>
            ) : (
              <ul className={css.list}>
                {rows.map(row => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={row.id === state.current ? css.rowActive : css.row}
                      aria-current={row.id === state.current ? 'true' : undefined}
                      onClick={() => { openIntake(row.id); setSheetOpen(false) }}
                      data-testid="medharness-mobile-intake"
                    >
                      {labelOf(row, t)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </>
      )}
    </>
  )
}

/** The session identity the record panel is showing, for diagnostics. */
export type MedharnessMobileSessionId = SessionId
