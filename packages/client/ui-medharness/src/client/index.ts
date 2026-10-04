/**
 * Browser half: the MedHarness product shell's right column.
 *
 * One contribution, and it is the product: the intake record occupies the
 * frame's right track by default, so the patient report and the image
 * observations are on screen from the first paint. The person using this page
 * never opens a tab to see their own intake.
 *
 * The column replaces the generic right Sidebar by registering at a lower
 * priority — the framework's documented way to shadow an occupied single slot —
 * so nothing is forked and the generic `web` profile, which never mounts this
 * plugin, is untouched.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Session Controller's projection read seat, the sessions
// service face, and the generated Remote face into the client assembly boundary.
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service and its Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard kit the column seat receives.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the right Sidebar's  seat declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: the two projection-key declarations the column reads.
import type {} from '@deepseek-ai/dsh-medical-case/client'
import type {} from '@deepseek-ai/dsh-medical-image/client'
import { en, zh } from './locales.ts'
import { MedharnessIntake } from './MedharnessIntake.tsx'
import { MedharnessSidebar } from './MedharnessSidebar.tsx'
import type { MedharnessSidebarInjected } from './MedharnessSidebar.tsx'

export type { MedharnessKey } from './locales.ts'
export type { PatientReportProps } from './PatientReport.tsx'
export type { ImageObservationsProps } from './ImageObservations.tsx'
export { PatientReport } from './PatientReport.tsx'
export { ImageObservations } from './ImageObservations.tsx'
export { MedharnessIntake } from './MedharnessIntake.tsx'
export { MedharnessSidebar } from './MedharnessSidebar.tsx'
export type { MedharnessSidebarInjected, MedharnessSidebarProps } from './MedharnessSidebar.tsx'
export type { MedharnessIntakeProps } from './MedharnessIntake.tsx'

/** This package's copy namespace. */
const NS = 'medharness'

/**
 * The priority the intake column registers at. The frame's `rightbar` slot is
 * `single`, and the registry resolves one occupant per priority with the
 * LOWEST rendering — so a negative priority is how a product takes the column
 * from the shipped right Sidebar without replacing it in the tree.
 */
const SHELL_PRIORITY = -1

/** Required browser services: the slot registry and copy. */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Client plugin body: take the frame's right column for the intake record.
 * @param ctx - client root context carrying the slot registry and copy.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-medharness: dictionaries')
  // The frame's column is root-scoped and carries no session, so the content
  // goes into the session-scoped seat inside it. Registering at a lower
  // priority is the framework's documented way to shadow an occupied single
  // slot: the shipped right Sidebar keeps its registration and never renders.
  ctx.effect(() => ctx.slots.inject('rightbar.session', () => ctx.slots.register({
    name: 'rightbar.session',
    priority: SHELL_PRIORITY,
    locale: NS,
  }, MedharnessIntake)), 'ui-medharness: intake column')

  // The navigation column, replaced outright. Workspaces, files, terminals,
  // jobs, settings, and the developer seats are not hidden here — they are not
  // part of this column. Every read and write goes through the sessions service
  // the rest of the product uses, so a new intake IS a harness session and
  // clicking one IS a harness navigation.
  ctx.effect(() => ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    priority: SHELL_PRIORITY,
    locale: NS,
    inject: (): MedharnessSidebarInjected => ({
      sessions: ctx.sessions.list,
      createIntake: async () => String(await ctx.sessions.create()),
      openIntake: (id) => { ctx.sessions.open(id as SessionId) },
    }),
  }, MedharnessSidebar)), 'ui-medharness: intake navigation')
}
