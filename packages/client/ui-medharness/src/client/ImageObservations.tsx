/**
 * The MODEL OBSERVED half of the intake surface.
 *
 * Everything drawn here is what the model reported seeing in an image the
 * person attached, and the heading says so. It is deliberately a separate
 * panel from the patient report: a reader must be able to tell what the person
 * said from what the model saw, and one merged list would destroy exactly that
 * distinction.
 *
 * An unusable image is shown as a result, not as a failure: "this photo cannot
 * be assessed reliably" is useful information, and it is why the person can
 * take a better one.
 */
import type { MedicalImageWireObservation, MedicalImageWireView } from '@deepseek-ai/dsh-medical-image/client'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './MedharnessBody.module.css'

/** One labelled list of short strings, or the placeholder when it is empty. */
function Findings({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div className={css.group}>
      <span className={css.groupLabel}>{label}</span>
      <span className={css.groupValue}>{values.length === 0 ? '—' : values.join('、')}</span>
    </div>
  )
}

/** One observed image. */
function Observation({ observation, index, t }: {
  observation: MedicalImageWireObservation
  index: number
  t: TranslateNS<'medharness'>
}) {
  return (
    <article className={css.image} data-testid="image-observation">
      <header className={css.imageHead}>
        <span className={css.imageName}>
          {observation.displayName ?? t('image.label', { index: String(index + 1) })}
        </span>
        <span className={css.imageRevision}>{t('image.revision', { revision: String(observation.revision) })}</span>
      </header>

      <p className={observation.usable ? css.usable : css.unusable}>
        {observation.usable ? t('image.usable') : t('image.unusable')}
      </p>

      <Findings label={t('image.region')} values={observation.bodyRegion === null ? [] : [observation.bodyRegion]} />
      <Findings label={t('image.findings')} values={observation.findings} />
      <Findings label={t('image.quality')} values={observation.qualityIssues} />
      <Findings label={t('image.uncertainty')} values={observation.uncertainty} />
    </article>
  )
}

/** Props: the owner-facing image value and the panel's copy. */
export interface ImageObservationsProps {
  /** The session's observations, `undefined` while the first value is loading. */
  readonly view: MedicalImageWireView | undefined
}

/**
 * Draw every observation the session holds, one card per image.
 * @param props - the image value plus the injected locale seat.
 * @returns the panel body.
 */
export function ImageObservations({ view, t }: ImageObservationsProps & PropsLocale<'medharness'>) {
  // The root always carries the panel's test id, so an empty or loading state is
  // still the observation panel rather than an unlabelled paragraph.
  if (view === undefined) return <div className={css.panel} data-testid='image-observations'><p className={css.hint}>{t('state.loading')}</p></div>
  if (view.observations.length === 0) return <div className={css.panel} data-testid='image-observations'><p className={css.hint}>{t('image.empty')}</p></div>

  return (
    <div className={css.panel} data-testid="image-observations">
      {view.observations.map((observation, index) => (
        <Observation
          key={observation.attachmentId}
          observation={observation}
          index={index}
          t={t}
        />
      ))}
    </div>
  )
}
