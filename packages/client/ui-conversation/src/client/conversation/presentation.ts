/**
 * Presentation resolvers for the Conversation's primitive strings.
 *
 * A slot carries React; a placeholder is a string the DOM attribute needs
 * verbatim, and no component can be that. This is the other half of the same
 * idea: a deployment registers a resolver, the shipped text arrives as the
 * argument, and whatever comes back is what the surface uses.
 *
 * The shipped text is passed IN rather than looked up here, which is what keeps
 * this class ignorant of the locale system: a resolver replaces a string with a
 * string, and a composition that registers nothing gets exactly the string the
 * caller already had.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

/** One registered replacement for a primitive presentation string. */
export interface ConversationPresentationResolver {
  /** Lower renders. Matches the slot registry's own band convention. */
  readonly priority: number
  /** Replace the shipped text. The argument is what the surface would show. */
  readonly resolve: (shipped: string) => string
}

/**
 * The Conversation's primitive-string presentation registry.
 *
 * One registry per concern rather than one per string: a product that speaks in
 * its own terms replaces several strings at once, and giving each its own
 * registration path would make the product's copy scatter across call sites.
 */
export class ConversationPresentation {
  private readonly resolvers: ConversationPresentationResolver[] = []

  /** @param ctx - Context whose effects own contributed resolvers. */
  constructor(private readonly ctx: Context) {
    Object.defineProperty(this, Service.tracker, { value: { property: 'ctx' } })
  }

  /**
   * Register one placeholder resolver for the caller's lifetime.
   * @param resolve - replacement for the shipped placeholder text.
   * @param priority - lower wins; defaults to zero, the shipped band.
   * @returns idempotent disposer.
   */
  registerPlaceholder(resolve: (shipped: string) => string, priority = 0): () => void {
    const entry: ConversationPresentationResolver = { priority, resolve }
    const dispose = this.ctx.effect(() => {
      this.resolvers.push(entry)
      return () => {
        const at = this.resolvers.indexOf(entry)
        if (at !== -1) this.resolvers.splice(at, 1)
      }
    }, 'uiConversation.presentation.registerPlaceholder')
    return () => { void dispose() }
  }

  /**
   * Resolve the hero placeholder a composer should show.
   *
   * Ties break by registration order, and the lowest priority wins — the same
   * rule the slot registry uses, so "a product shadows the shipped surface"
   * means one thing across both halves.
   * @param shipped - the text the surface would show with no registration.
   * @returns the resolved placeholder.
   */
  heroPlaceholder(shipped: string): string {
    let winner: ConversationPresentationResolver | undefined
    for (const entry of this.resolvers) {
      if (winner === undefined || entry.priority < winner.priority) winner = entry
    }
    return winner === undefined ? shipped : winner.resolve(shipped)
  }
}
