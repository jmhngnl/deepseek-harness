/**
 * The intake surface's body: what this consultation has recorded, and what the
 * attached images showed.
 *
 * Two panels, deliberately not one. The left-hand column of a consultation is
 * the conversation; this page answers the two questions a conversation makes
 * hard to check — what have I actually told it, and what did it see in my
 * photo. The headings and the accent colour are the whole design: a reader must
 * never have to work out which of the two a line came from.
 *
 * Both values arrive as finished projection reads. The browser folds nothing:
 * `medicalCase` and `medicalImage` are computed on the host from the session
 * log, so this page shows the same state a reload, a resume, or another device
 * would show.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the session standard kit (session identity, projection read)
// into the props every session-scope slot component receives.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the `medicalCase` / `medicalImage` projection-key declarations.
import type {} from '@deepseek-ai/dsh-medical-case/client'
import type {} from '@deepseek-ai/dsh-medical-image/client'
import type {} from './locales.ts'
import { ImageObservations } from './ImageObservations.tsx'
import { PatientReport } from './PatientReport.tsx'
import css from './MedharnessBody.module.css'

/** The body's composed props: the tab seat, the session standard kit, and copy. */
export type MedharnessBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'medharness'>

/**
 * Draw the intake surface.
 * @param props - the tab's runtime seat plus the injected locale seat.
 * @returns the page body.
 */
export function MedharnessBody({ useProjection, t }: MedharnessBodyProps) {
  const reported = useProjection('medicalCase')
  const observed = useProjection('medicalImage')

  return (
    <div className={css.page}>
      <section className={css.section} data-evidence="patient-reported">
        <header className={css.head}>
          <h2 className={css.headTitle}>{t('panel.reported.title')}</h2>
          <p className={css.headCaption}>{t('panel.reported.caption')}</p>
        </header>
        <PatientReport view={reported} t={t} />
      </section>

      <section className={css.section} data-evidence="model-observed">
        <header className={css.head}>
          <h2 className={css.headTitle}>{t('panel.observed.title')}</h2>
          <p className={css.headCaption}>{t('panel.observed.caption')}</p>
        </header>
        <ImageObservations view={observed} t={t} />
      </section>
    </div>
  )
}
