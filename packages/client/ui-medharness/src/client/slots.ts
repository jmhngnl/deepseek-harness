/**
 * The intake surface's slot declaration and injected face.
 *
 * The seat is declared here rather than borrowed from the shipped right
 * Sidebar: a child slot is rendered by whoever declared it, so registering into
 * someone else's seat puts this product's state behind their visibility gate.
 * Declaring our own means the column appears because MedHarness is mounted, and
 * for no other reason.
 *
 * The loader is expressed in the wire vocabulary the observation carries, not
 * in the attachment package's branded reference: the surface may not import the
 * domain's host types, and the adapter that turns one into the other belongs in
 * the plugin body where both sides are in scope.
 *
 * @module @deepseek-ai/dsh-client-ui-medharness
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The intake record inside the MedHarness right column. Session-scoped, so
     * the occupant receives the session standard kit and can read the
     * `medicalCase` and `medicalImage` projections.
     */
    'medharness.rightbar.session': { kind: 'single'; scope: 'session' }
  }
}

/** The attachment facts one observation publishes, as the loader consumes them. */
export interface MedharnessImageRef {
  /** Canonical durable attachment identity. */
  readonly attachmentId: string
  /** Admitted media type. */
  readonly mediaType: string
  /** Exact encoded byte length. */
  readonly bytes: number
  /** Intrinsic encoded width in pixels. */
  readonly width: number
  /** Intrinsic encoded height in pixels. */
  readonly height: number
}

/**
 * Resolve one session-authorized browser URL for an image the session holds.
 *
 * Implemented over the same read the conversation's own image bubbles use, so
 * authorization, caching, and lifetime stay in one place. A rejection means the
 * bytes are not reachable for this session; the caller renders without them.
 */
export type MedharnessImageLoader = (attachment: MedharnessImageRef) => Promise<string>
