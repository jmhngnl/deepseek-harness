/**
 * The MedHarness hero: the blank-intake state's brand line.
 *
 * It replaces the shipped brand mark rather than restyling it. The shipped mark
 * is the harness vendor's logo, and a person filling in an intake should see
 * the product they opened, not the runtime underneath it.
 *
 * The headline and the supporting copy beneath it are NOT replaced here, and
 * that is a real limit rather than an oversight: `ui-conversation` renders them
 * from its own dictionary, and the locale service refuses a second registration
 * for a namespace and locale that already exist. Only the mark is a slot.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the headline seat's declaration and its owner share.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'
import css from './MedharnessHero.module.css'

/** The copy seat's composed props: the shipped strings and this product's copy. */
export type MedharnessHeroCopyProps =
  & PropsRuntime<'conversation.hero.copy'>
  & PropsLocale<'medharness'>

/**
 * Speak as the product in the blank-intake headline seat.
 *
 * The shipped strings arrive in the owner share and are deliberately unused:
 * the seat exists so a vertical product introduces itself in its own terms.
 * Nothing here reaches the Conversation underneath it — the composer, the
 * transcript, and the runtime are the same ones the generic surface uses.
 * @param props - the seat's owner share and this product's copy.
 * @returns the intake headline block.
 */
export function MedharnessHeroCopy({ t }: MedharnessHeroCopyProps) {
  return (
    <span className={css.copy} data-testid="medharness-hero-copy">
      <span className={css.copyHeadline}>{t('hero.headline')}</span>
      <span className={css.copyBody}>{t('hero.body')}</span>
    </span>
  )
}

/** The mark's composed props: the slot's owner share plus copy. */
export type MedharnessHeroMarkProps =
  & PropsRuntime<'conversation.hero.brand.mark'>
  & PropsLocale<'medharness'>

/**
 * Draw the MedHarness wordmark in the hero's mark seat.
 * @param props - the mark slot's owner share and copy.
 * @returns the wordmark.
 */
export function MedharnessHeroMark({ size, className, t }: MedharnessHeroMarkProps) {
  return (
    <span
      className={className === undefined ? css.mark : `${css.mark} ${className}`}
      style={{ fontSize: Math.max(12, Math.round(size * 0.62)) }}
      data-testid="medharness-hero-mark"
    >
      {t('brand.name')}
    </span>
  )
}
