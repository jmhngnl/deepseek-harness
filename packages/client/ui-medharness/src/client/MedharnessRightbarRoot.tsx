/**
 * The MedHarness right column, owned end to end.
 *
 * It occupies the frame's right track directly — the shipped right Sidebar
 * registers at the default priority, this registers below it, and the slot
 * registry renders the lowest — so the column is present because MedHarness is
 * mounted. It is not a guest inside another plugin's column, and no other
 * plugin's panel or tab state can decide whether the intake record is visible.
 *
 * The column is the product's own session-scoped area: it declares the seat,
 * renders it, and supplies its empty branch. With no intake on stage there is
 * nothing to record yet, and the column says so rather than disappearing.
 */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the frame's `rightbar` declaration and its column geometry.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the session standard kit and the SessionProvider seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from './locales.ts'
import type {} from './slots.ts'
import css from './MedharnessShell.module.css'

/**
 * The column's composed props: the frame's geometry share, the render seats for
 * its own session-scoped child, and copy.
 */
export type MedharnessRightbarRootProps =
  & PropsRuntime<'rightbar'>
  & PropsRenderSlots<'medharness.rightbar.session'>
  & PropsLocale<'medharness'>

/**
 * Draw the intake column.
 * @param props - the frame's column share, the child render seats, and copy.
 * @returns the column body.
 */
export function MedharnessRightbarRoot({
  width, canShow, renderSlot, SessionProvider, t,
}: MedharnessRightbarRootProps) {
  // The frame's own concession solve decides whether a right column can exist
  // beside the conversation; below that width there is nothing to draw, and the
  // frame renders nothing here either way.
  if (!canShow) return null

  return (
    <aside className={css.column} style={{ width }} data-testid="medharness-shell">
      <SessionProvider empty={() => <p className={css.hint}>{t('state.noIntake')}</p>}>
        {renderSlot('medharness.rightbar.session', { width, viewportWidth: width })}
      </SessionProvider>
    </aside>
  )
}
