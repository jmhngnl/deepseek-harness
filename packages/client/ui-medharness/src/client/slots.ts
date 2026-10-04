/**
 * The intake surface's injected face.
 *
 * The loader is deliberately expressed in the wire vocabulary the observation
 * carries, not in the attachment package's branded reference: the surface may
 * not import the domain's host types, and the adapter that turns one into the
 * other belongs in the plugin body where both sides are in scope.
 *
 * @module @deepseek-ai/dsh-client-ui-medharness
 */

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
