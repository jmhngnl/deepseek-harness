/**
 * The primitive-string presentation resolver, on its own terms.
 *
 * These cases drive the resolver directly rather than through a component: the
 * rules it owns — what an unregistered resolver returns, which priority wins,
 * and what a disposer must restore — are invisible from a rendered placeholder,
 * because a component can only show the winner. Testing through React here
 * would assert the composer's markup, not this class's contract.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ConversationPresentation } from '../src/client/conversation/presentation.ts'

/** A resolver registry over its own Context, as the service mints one. */
function registry() {
  return new ConversationPresentation(new Context())
}

describe('ConversationPresentation', () => {
  it('returns the shipped text when nothing is registered', () => {
    expect(registry().heroPlaceholder('shipped')).toBe('shipped')
  })

  it('returns the registered replacement', () => {
    const presentation = registry()
    presentation.registerPlaceholder(() => 'product text')
    expect(presentation.heroPlaceholder('shipped')).toBe('product text')
  })

  it('hands the shipped text to the resolver', () => {
    const presentation = registry()
    const seen: string[] = []
    presentation.registerPlaceholder((shipped) => { seen.push(shipped); return 'x' })
    presentation.heroPlaceholder('shipped')
    // The argument is the contract: a resolver replaces a string with a string
    // and never has to know where the original came from.
    expect(seen).toEqual(['shipped'])
  })

  it('lets the lowest priority win', () => {
    const presentation = registry()
    presentation.registerPlaceholder(() => 'shipped band', 0)
    presentation.registerPlaceholder(() => 'higher', 1)
    expect(presentation.heroPlaceholder('shipped')).toBe('shipped band')

    presentation.registerPlaceholder(() => 'product', -1)
    // Same rule as the slot registry: a product shadows the shipped surface by
    // claiming a lower band, so "who renders" means one thing on both halves.
    expect(presentation.heroPlaceholder('shipped')).toBe('product')
  })

  it('restores the shipped text when the registration is disposed', async () => {
    const ctx = new Context()
    const presentation = new ConversationPresentation(ctx)
    // The caller owns the lifetime, exactly as the plugin body does: a
    // registration is an effect on the contributing fiber.
    const fiber = ctx.plugin({
      apply: (pluginCtx) => { pluginCtx.effect(() => presentation.registerPlaceholder(() => 'product text')) },
    })
    await fiber.await()

    expect(presentation.heroPlaceholder('shipped')).toBe('product text')
    await fiber.dispose()
    // A presentation override must not outlive the plugin that made it: the
    // next composition to mount this Context gets the shipped text back.
    expect(presentation.heroPlaceholder('shipped')).toBe('shipped')
  })

  it('falls back to the next resolver when the winner is disposed', () => {
    const presentation = registry()
    presentation.registerPlaceholder(() => 'shipped band', 0)
    const disposeProduct = presentation.registerPlaceholder(() => 'product', -1)
    expect(presentation.heroPlaceholder('shipped')).toBe('product')

    disposeProduct()
    expect(presentation.heroPlaceholder('shipped')).toBe('shipped band')
  })

  it('keeps the shipped text when every registration is gone', () => {
    const presentation = registry()
    const a = presentation.registerPlaceholder(() => 'a', -1)
    const b = presentation.registerPlaceholder(() => 'b', -2)
    expect(presentation.heroPlaceholder('shipped')).toBe('b')

    b()
    expect(presentation.heroPlaceholder('shipped')).toBe('a')
    a()
    expect(presentation.heroPlaceholder('shipped')).toBe('shipped')
  })
})
