/**
 * Stage one of this package's registration: what the intake tab type IS.
 *
 * The type is a page, not a viewer: it claims no address and opens no file. It
 * exists so a person in a consultation can see, at a glance, what the record
 * currently holds and what the attached images showed — the two things a
 * conversation alone makes hard to check.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const MEDHARNESS_KIND = 'medharness'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const MEDHARNESS_ID = '@deepseek-ai/dsh-client-ui-medharness'

/**
 * The intake type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function medharnessDefinition(t: TranslateNS<'medharness'>): SidebarRightTabDefinition {
  return {
    id: MEDHARNESS_ID,
    kind: MEDHARNESS_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'intake',
      order: 20,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }
}
