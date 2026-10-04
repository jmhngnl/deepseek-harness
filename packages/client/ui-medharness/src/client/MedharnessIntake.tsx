/**
 * The intake record for the current session: the two panels the product exists
 * to show.
 *
 * It occupies the right column's own session-scoped child seat rather than in the
 * frame's root column, because the frame's column carries no session identity —
 * a root occupant cannot read a session projection, and both panels are
 * session projections.
 *
 * Neither panel is optional. "No observations yet" is rendered as a state of
 * the observation panel, not by removing the panel: a person should be able to
 * see that the section exists before they attach anything.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the session standard kit (session identity, projection read).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the `medicalCase` / `medicalImage` projection-key declarations.
import type {} from '@deepseek-ai/dsh-medical-case/client'
import type {} from '@deepseek-ai/dsh-medical-image/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MedharnessImageLoader } from './slots.ts'
import type {} from './locales.ts'
import { ImageObservations } from './ImageObservations.tsx'
import { PatientReport } from './PatientReport.tsx'
import css from './MedharnessShell.module.css'

/** The intake content's props: the shell's session seat plus copy. */
export type MedharnessIntakeProps =
  & PropsRuntime<'rightbar.session'>
  & PropsLocale<'medharness'>
  & { /** Session-authorized image URL resolution, injected by the plugin body. */ readonly loadImage: MedharnessImageLoader }

/**
 * Draw the patient report and the image observations for the current session.
 * @param props - the session seat plus the injected locale seat.
 * @returns the two panels.
 */
export function MedharnessIntake({ useProjection, loadImage, t }: MedharnessIntakeProps) {
  const reported = useProjection('medicalCase')
  const observed = useProjection('medicalImage')

  return (
    <>
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
        <ImageObservations view={observed} loadImage={loadImage} t={t} />
      </section>
    </>
  )
}
