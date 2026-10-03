/**
 * Client-namespace projection of the medical image domain: a pure re-export of
 * the package's types outlet. Browser code imports ONLY the client namespace
 * (repo discipline), so `./client` projects the same single-source content
 * `./types` serves to host consumers — the `medicalImage` projection-key
 * declaration reaches the client program through exactly one home, with no
 * second copy to drift.
 *
 * @module @deepseek-ai/dsh-medical-image/client
 */

export type * from './types.ts'
