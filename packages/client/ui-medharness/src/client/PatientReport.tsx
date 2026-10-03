/**
 * The PATIENT REPORTED half of the intake surface.
 *
 * Everything drawn here came from the person using the page, and the heading
 * says so. The completeness list is driven by the host's `missingFields` — the
 * browser never decides what is missing, so the indicator cannot disagree with
 * the record it describes.
 *
 * There is deliberately no conclusion row. The domain has no diagnosis,
 * severity, or risk field, so there is nothing clinical this panel could show
 * even if a renderer asked for it.
 */
import type { MedicalCaseWireView, MissingField } from '@deepseek-ai/dsh-medical-case/client'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './MedharnessBody.module.css'

/** Required fields, in the order the domain reports them. */
const REQUIRED: readonly MissingField[] = ['symptoms', 'duration', 'age']

/** Field label keys, keyed by the domain's own field names. */
const FIELD_LABEL = {
  symptoms: 'field.symptoms',
  duration: 'field.duration',
  age: 'field.age',
} as const satisfies Record<MissingField, string>

/**
 * Render one recorded value, or the placeholder that says it is absent.
 * @param value - the recorded value, or null.
 * @param t - namespace-bound translate.
 * @returns the text to draw.
 */
function recorded(value: string | number | null, t: TranslateNS<'medharness'>): string {
  if (value === null) return t('state.notProvided')
  if (typeof value === 'number') return String(value)
  return value
}

/** Props: the owner-facing case value and the panel's copy. */
export interface PatientReportProps {
  /** The session's case, `null` before the first record, `undefined` while loading. */
  readonly view: MedicalCaseWireView | null | undefined
}

/**
 * Draw the patient-reported record and its completeness.
 * @param props - the case value plus the injected locale seat.
 * @returns the panel body.
 */
export function PatientReport({ view, t }: PatientReportProps & PropsLocale<'medharness'>) {
  // The root always carries the panel's test id, so an empty or loading state is
  // still the patient panel rather than an unlabelled paragraph.
  if (view === undefined) return <div className={css.panel} data-testid='patient-report'><p className={css.hint}>{t('state.loading')}</p></div>
  if (view === null) return <div className={css.panel} data-testid='patient-report'><p className={css.hint}>{t('state.empty')}</p></div>

  const missing = new Set(view.missingFields)

  return (
    <div className={css.panel} data-testid="patient-report">
      <ul className={css.checklist} aria-label={t('progress.title')}>
        {REQUIRED.map(field => (
          <li key={field} className={missing.has(field) ? css.checkMissing : css.checkDone}>
            <span className={css.checkGlyph} aria-hidden="true">{missing.has(field) ? '○' : '✓'}</span>
            <span>{t(FIELD_LABEL[field])}</span>
          </li>
        ))}
      </ul>

      <dl className={css.fields}>
        <dt>{t('field.symptoms')}</dt>
        <dd>{view.symptoms.length === 0 ? t('state.notProvided') : view.symptoms.join('、')}</dd>
        <dt>{t('field.duration')}</dt>
        <dd>{recorded(view.duration, t)}</dd>
        <dt>{t('field.age')}</dt>
        <dd>{recorded(view.age, t)}</dd>
        <dt>{t('field.notes')}</dt>
        <dd>{recorded(view.additionalNotes, t)}</dd>
      </dl>

      <p className={css.meta}>
        {t('field.revision')} {view.revision}
        {missing.size === 0 ? ` · ${t('progress.complete')}` : ''}
      </p>
    </div>
  )
}
