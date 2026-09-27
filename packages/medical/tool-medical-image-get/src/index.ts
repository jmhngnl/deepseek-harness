/**
 * Model-facing `medical_image_get` tool: reads the authoritative image
 * observations this session has recorded.
 *
 * This is the explicit read path. Observations are durable session state that
 * survives resume and fork, so an agent that needs them asks for them here rather
 * than relying on its conversation history to remember what it saw.
 *
 * The read is addressed by attachment, never by recency: a session may hold
 * several images, and an API that returned only the most recent one would make
 * the second image unreadable the moment a third arrived.
 *
 * @module @deepseek-ai/dsh-tool-medical-image-get
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
// Resolves the `ctx.medicalImage` service declaration published by the domain.
import type {} from '@deepseek-ai/dsh-medical-image'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-medical-image-get'

/** Services required by the medical image read tool. */
export const inject = ['agents', 'medicalImage', 'tools']

const description = 'Read the image observations this session has already recorded, without changing them. '
  + 'Pass an attachmentId to read one image, or omit it to list every image observed in this conversation. '
  + 'Use it to re-check what was recorded about a specific image, for example after a long conversation or when you '
  + 'are unsure whether an image was already observed. '
  + 'The returned observations are authoritative: they come from the session\u2019s durable state, not from conversation '
  + 'memory. They are observations of images only \u2014 they are never patient-reported facts, and reading them does not '
  + 'change the case record. '
  + 'This tool reads and structures input only: it does not diagnose a condition, recommend treatment or medication, '
  + 'or assess medical risk.'

/** One observation as the output schema projects it. */
interface RenderedObservation {
  attachmentId: string
  revision: number
  bodyRegion: string | null
  findings: readonly string[]
  usable: boolean
  qualityIssues: readonly string[]
  uncertainty: readonly string[]
}

/** Render one observation as a compact block. */
function renderOne(value: RenderedObservation): string {
  return [
    `- attachmentId: ${value.attachmentId} (revision ${String(value.revision)})`,
    `  bodyRegion: ${value.bodyRegion ?? '(not stated)'}`,
    `  findings: ${value.findings.length > 0 ? value.findings.join('; ') : '(none recorded)'}`,
    `  usable: ${String(value.usable)}`,
    `  qualityIssues: ${value.qualityIssues.length > 0 ? value.qualityIssues.join(', ') : '(none)'}`,
    `  uncertainty: ${value.uncertainty.length > 0 ? value.uncertainty.join('; ') : '(none)'}`,
  ].join('\n')
}

/** Render the authoritative observations as the text the model reads. */
function renderObservations(value: { readonly observations: readonly RenderedObservation[] }): string {
  if (value.observations.length === 0) return 'No image observations recorded in this session.'
  return ['Recorded image observations.', ...value.observations.map(renderOne)].join('\n')
}

/** The observation shape every entry of the output list carries. */
const observationProperties = {
  attachmentId: { type: 'string', required: true },
  revision: { type: 'integer', required: true },
  bodyRegion: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  findings: { type: 'array', required: true, items: { type: 'string' } },
  usable: { type: 'boolean', required: true },
  qualityIssues: { type: 'array', required: true, items: { type: 'string' } },
  uncertainty: { type: 'array', required: true, items: { type: 'string' } },
} as const

/**
 * Register `medical_image_get` on `ctx.tools`.
 * @param ctx - the context whose tool registry receives the definition.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'medical_image_get',
    description,
    parameters: {
      attachmentId: {
        type: 'string',
        description: 'The attachment id to read. Omit to list every image observed in this conversation. '
          + 'An id this session has no observation for is reported as such.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          observations: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: observationProperties },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderObservations(value) }],
    },
    execute(args, execution: ToolRunContext) {
      const agent = execution.agent
      if (agent === undefined) {
        throw new HarnessError('medical_image_get requires a calling agent session', 'MEDICAL_IMAGE_AGENT_REQUIRED')
      }
      const records = args.attachmentId === undefined
        ? ctx.medicalImage.list(agent)
        : [ctx.medicalImage.require(agent, args.attachmentId)]
      return Promise.resolve({
        observations: records.map(record => ({
          attachmentId: String(record.attachment.attachmentId),
          revision: record.revision,
          bodyRegion: record.bodyRegion,
          findings: record.findings,
          usable: record.quality.usable,
          qualityIssues: record.quality.issues,
          uncertainty: record.uncertainty,
        })),
      })
    },
  }))
}
