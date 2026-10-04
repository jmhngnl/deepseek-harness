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
 *
 * The thumbnail is not a second attachment path. It asks the injected loader
 * for a session-authorized URL — the same read the conversation's own image
 * bubbles use — and degrades to the name alone when that read refuses, because
 * what the model recorded is still worth showing when the bytes are not.
 */
import { useEffect, useState } from 'react'
import type { MedicalImageWireObservation, MedicalImageWireView } from '@deepseek-ai/dsh-medical-image/client'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import type { MedharnessImageLoader } from './slots.ts'
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

/**
 * The image itself, when the session can still read it.
 *
 * The loader runs once per observation identity. A refusal is not an error
 * state for the page: the card keeps its name and its findings, because what
 * the model recorded is still true even if the bytes have become unreachable.
 * @param props - the observation's attachment facts and the injected loader.
 * @returns the thumbnail, or nothing while it is unresolved.
 */
function Thumbnail({ observation, loadImage, alt }: {
  observation: MedicalImageWireObservation
  loadImage: MedharnessImageLoader
  alt: string
}) {
  const [url, setUrl] = useState<string | undefined>(undefined)
  const { attachmentId, bytes, height, mediaType, width } = observation

  useEffect(() => {
    let live = true
    void loadImage({ attachmentId, mediaType, bytes, width, height }).then(
      (resolved) => { if (live) setUrl(resolved) },
      () => { if (live) setUrl(undefined) },
    )
    return () => { live = false }
  }, [loadImage, attachmentId, bytes, height, mediaType, width])

  if (url === undefined) return null
  return <img className={css.thumb} src={url} alt={alt} width={width} height={height} />
}

/** One observed image. */
function Observation({ observation, index, loadImage, t }: {
  observation: MedicalImageWireObservation
  index: number
  loadImage: MedharnessImageLoader
  t: TranslateNS<'medharness'>
}) {
  const label = observation.displayName ?? t('image.label', { index: String(index + 1) })

  return (
    <article className={css.image} data-testid="image-observation">
      <header className={css.imageHead}>
        <span className={css.imageName}>{label}</span>
        <span className={css.imageRevision}>{t('image.revision', { revision: String(observation.revision) })}</span>
      </header>

      <Thumbnail observation={observation} loadImage={loadImage} alt={label} />

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

/** Props: the owner-facing image value, the loader, and the panel's copy. */
export interface ImageObservationsProps {
  /** The session's observations, `undefined` while the first value is loading. */
  readonly view: MedicalImageWireView | undefined
  /** Session-authorized image URL resolution, injected by the surface plugin. */
  readonly loadImage: MedharnessImageLoader
}

/**
 * Draw every observation the session holds, one card per image.
 * @param props - the image value, the loader, and the injected locale seat.
 * @returns the panel body.
 */
export function ImageObservations({ view, loadImage, t }: ImageObservationsProps & PropsLocale<'medharness'>) {
  if (view === undefined) {
    return (
      <div className={css.panel} data-testid="image-observations">
        <p className={css.hint}>{t('state.loading')}</p>
      </div>
    )
  }
  if (view.observations.length === 0) {
    return (
      <div className={css.panel} data-testid="image-observations">
        <p className={css.hint}>{t('image.empty')}</p>
      </div>
    )
  }

  return (
    <div className={css.panel} data-testid="image-observations">
      {view.observations.map((observation, index) => (
        <Observation
          key={observation.attachmentId}
          observation={observation}
          index={index}
          loadImage={loadImage}
          t={t}
        />
      ))}
    </div>
  )
}
