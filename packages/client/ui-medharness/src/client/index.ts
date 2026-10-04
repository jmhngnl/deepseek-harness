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
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard kit the column seat receives.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the Conversation service that owns session-authorized image reads.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the right Sidebar's  seat declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: the two projection-key declarations the column reads.
import type {} from '@deepseek-ai/dsh-medical-case/client'
import type {} from '@deepseek-ai/dsh-medical-image/client'
import { en, zh } from './locales.ts'
import { MedharnessIntake } from './MedharnessIntake.tsx'
import { MedharnessHeroCopy, MedharnessHeroMark } from './MedharnessHero.tsx'
import { MedharnessRightbarRoot } from './MedharnessRightbarRoot.tsx'
import type {} from './slots.ts'
import { MedharnessSidebar } from './MedharnessSidebar.tsx'
import type { MedharnessSidebarInjected } from './MedharnessSidebar.tsx'
import type { MedharnessImageLoader, MedharnessImageRef } from './slots.ts'

export type { MedharnessKey } from './locales.ts'
export type { PatientReportProps } from './PatientReport.tsx'
export type { ImageObservationsProps } from './ImageObservations.tsx'
export { PatientReport } from './PatientReport.tsx'
export { ImageObservations } from './ImageObservations.tsx'
export { MedharnessIntake } from './MedharnessIntake.tsx'
export { MedharnessRightbarRoot } from './MedharnessRightbarRoot.tsx'
export { MedharnessHeroCopy, MedharnessHeroMark } from './MedharnessHero.tsx'
export type { MedharnessHeroCopyProps } from './MedharnessHero.tsx'
export type { MedharnessHeroMarkProps } from './MedharnessHero.tsx'
export type { MedharnessRightbarRootProps } from './MedharnessRightbarRoot.tsx'
export type { MedharnessImageLoader, MedharnessImageRef } from './slots.ts'
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
export const inject = ['slots', 'locale', 'sessions', 'uiConversation', 'layout']

/**
 * Client plugin body: take the frame's right column for the intake record.
 * @param ctx - client root context carrying the slot registry and copy.
 */
/** A seat the product claims and leaves empty. */
function EmptySeat(): null {
  return null
}

/**
 * Client plugin body: take the frame's right column for the intake record.
 * @param ctx - client root context carrying the slot registry and copy.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-medharness: dictionaries')

  // The frame's right column, taken outright. Registering at a lower priority
  // is the framework's documented way to shadow an occupied single slot: the
  // shipped right Sidebar keeps its registration and never renders.
  //
  // The child seat is this package's OWN, not the one the shipped Sidebar
  // declares. A child slot is rendered by whoever declared it, so borrowing
  // `rightbar.session` would leave the intake record inside another plugin's
  // visibility gate — which is exactly what happened before this change: the
  // column was absent on every viewport because `ui-sidebar-right`'s own
  // occupant decided not to render. Declaring the seat here means the column is
  // present because MedHarness is mounted, and for no other reason.
  ctx.effect(() => ctx.slots.inject('rightbar', function* () {
    yield ctx.slots.register({
      name: 'rightbar',
      priority: SHELL_PRIORITY,
      locale: NS,
      children: { 'medharness.rightbar.session': { kind: 'single', scope: 'session' } },
    }, MedharnessRightbarRoot)
    yield ctx.slots.register({
      name: 'medharness.rightbar.session',
      locale: NS,
      inject: (): { loadImage: MedharnessImageLoader } => ({
        // The same read the conversation's image bubbles use: authorization,
        // caching, and URL lifetime stay in the Conversation service. The
        // adapter widens the wire facts back into the branded reference the
        // service takes, which is the one place both vocabularies are in scope.
        loadImage: (ref: MedharnessImageRef) => ctx.uiConversation.imageUrl(
          ctx.sessions.list.getSnapshot().current as SessionId,
          ref as unknown as Parameters<typeof ctx.uiConversation.imageUrl>[1],
        ),
      }),
    }, MedharnessIntake)
  }), 'ui-medharness: intake column')

  // The column's WIDTH is a frame decision, not a slot decision: the frame
  // reserves a right track only when something reports one open. Taking the
  // slot without this leaves the occupant rendering inside a zero-width
  // column — present in the tree, invisible on screen. Reporting the track open
  // is what makes the intake record actually occupy space, and reporting it
  // closed on teardown is what gives the width back.
  ctx.effect(() => {
    ctx.layout.openRightbar(true, false)
    return () => { ctx.layout.closeRightbar() }
  }, 'ui-medharness: right track')

  // ── The blank-intake hero ────────────────────────────────────────────────
  //
  // Three single seats the shipped hero occupies. Taking them at a lower
  // priority is the same shadow the right column uses: the generic Web profile
  // keeps every one of its own occupants, and this profile shows the product a
  // person actually opened.
  ctx.effect(() => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
    priority: SHELL_PRIORITY,
    locale: NS,
  }, MedharnessHeroMark)), 'ui-medharness: hero mark')

  // The headline the shipped hero shows is the harness vendor introducing a
  // coding agent. This seat is the generic seam a vertical product uses to
  // introduce itself instead; the Conversation underneath is untouched.
  ctx.effect(() => ctx.slots.inject('conversation.hero.copy', () => ctx.slots.register({
    name: 'conversation.hero.copy',
    priority: SHELL_PRIORITY,
    locale: NS,
  }, MedharnessHeroCopy)), 'ui-medharness: hero copy')

  // The composer placeholder is a DOM attribute, so it is a string rather than
  // a slot. The shipped text — which carries the coding surface's slash and @
  // hints inside the same string — arrives as the argument and is replaced
  // wholesale, which is why no separate hint switch exists: there is nothing
  // left to switch off once the string is gone.
  ctx.effect(() => ctx.uiConversation.presentation.registerPlaceholder(
    () => ctx.locale.bind(NS)('composer.placeholder'),
    SHELL_PRIORITY,
  ), 'ui-medharness: composer placeholder')

  // The agent-preset control is a development choice — which tool surface the
  // agent runs — and an intake never asks it, so the seat renders nothing.
  //
  // The workspace picker is deliberately NOT shadowed, though the product
  // never asks the question either. It is the only first-run path that
  // establishes a workspace for a fresh installation; removing it left the
  // browser acceptance unable to connect a workspace at all. A product control
  // that onboarding depends on stays until something else owns that step.
  for (const seat of ['conversation.hero.agentPreset'] as const) {
    ctx.effect(() => ctx.slots.inject(seat, () => ctx.slots.register({
      name: seat,
      priority: SHELL_PRIORITY,
    }, EmptySeat)), `ui-medharness: empty ${seat}`)
  }

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
