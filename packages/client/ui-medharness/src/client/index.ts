/**
 * Browser half: register `intake` as a right-Sidebar tab type.
 *
 * The public two-stage path: the type into `ctx.sidebarRightTabs`, the body into
 * the keyed `sidebar.right.pane.tab` seat under the type's `id`. Nothing else is
 * contributed — no Remote namespace, no store, no host row — because the two
 * values the page draws are session projections the host already folds and the
 * framework already delivers.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Session Controller's projection read seat and the
// generated Remote face into the client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the renderer-owned slots service and its Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard kit the tab body receives.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the tab registry and its keyed body seat.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: the two projection-key declarations the page reads.
import type {} from '@deepseek-ai/dsh-medical-case/client'
import type {} from '@deepseek-ai/dsh-medical-image/client'
import { MEDHARNESS_ID, medharnessDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { MedharnessBody } from './MedharnessBody.tsx'

export type { MedharnessKey } from './locales.ts'
export type { MedharnessBodyProps } from './MedharnessBody.tsx'
export type { PatientReportProps } from './PatientReport.tsx'
export type { ImageObservationsProps } from './ImageObservations.tsx'
export { PatientReport } from './PatientReport.tsx'
export { ImageObservations } from './ImageObservations.tsx'

/** This package's copy namespace. */
const NS = 'medharness'

/** Required browser services: the tab registry, the keyed seat, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, and its body.
 * @param ctx - client root context carrying the registry, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(medharnessDefinition(t)), 'ui-medharness: intake type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-medharness: dictionaries')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: MEDHARNESS_ID, locale: NS },
    MedharnessBody,
  )), 'ui-medharness: intake tab body')
}
