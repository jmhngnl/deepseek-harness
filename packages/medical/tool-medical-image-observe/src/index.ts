/**
 * Model-facing `medical_image_observe` tool: records the model's complete
 * observation of one image the session already holds.
 *
 * The model has ALREADY looked at the image — that is why the image was in its
 * request. This tool does not read the image, does not call a model, and does not
 * re-derive anything from the bytes. It takes the model's structured account of
 * what is directly visible, hands it to the domain service, and returns the
 * authoritative observation.
 *
 * The request is a FULL SNAPSHOT: every field is required, so one call declares
 * the whole current observation. Nothing here preserves an older value, because
 * the durable event is a full state too — see the package README.
 *
 * @module @deepseek-ai/dsh-tool-medical-image-observe
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
// Resolves the `ctx.medicalImage` service declaration published by the domain.
import type {} from '@deepseek-ai/dsh-medical-image'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-medical-image-observe'

/** Services required by the medical image observation tool. */
export const inject = ['agents', 'medicalImage', 'tools']

const description = 'Record the COMPLETE current observation of one image the user attached to this conversation, '
  + 'after you have looked at it. Every field is required: this is a full snapshot, not a patch, so never omit a field '
  + 'intending to preserve an older value. '
  + 'Pass the attachmentId shown beside the image; the harness resolves it against this session and rejects an id that '
  + 'was not attached here. '
  + 'Record only what is DIRECTLY VISIBLE: body region, colour, shape, size, distribution, surface appearance, '
  + 'swelling, discoloration. State image limitations and what you could not determine; if the image cannot be '
  + 'assessed reliably, set usable to false and say why instead of guessing. '
  + 'Do NOT state a diagnosis, name a disease or condition, suggest treatment or medication, or give a risk, urgency, '
  + 'or triage judgement. '
  + 'Do NOT restate these findings as patient-reported symptoms: the case record changes only from what the user says. '
  + 'Repeating an identical snapshot is a no-op and does not create a new revision.'

/** The value shape the output schema projects, as the renderer receives it. */
interface RenderedObservation {
  attachmentId: string
  revision: number
  bodyRegion: string | null
  findings: readonly string[]
  usable: boolean
  qualityIssues: readonly string[]
  uncertainty: readonly string[]
}

/** Render the authoritative observation as the text the model reads. */
function renderObservation(value: RenderedObservation): string {
  return [
    'Recorded image observation.',
    `attachmentId: ${value.attachmentId}`,
    `revision: ${String(value.revision)}`,
    `bodyRegion: ${value.bodyRegion ?? '(not stated)'}`,
    `findings: ${value.findings.length > 0 ? value.findings.join('; ') : '(none recorded)'}`,
    `usable: ${String(value.usable)}`,
    `qualityIssues: ${value.qualityIssues.length > 0 ? value.qualityIssues.join(', ') : '(none)'}`,
    `uncertainty: ${value.uncertainty.length > 0 ? value.uncertainty.join('; ') : '(none)'}`,
  ].join('\n')
}

/**
 * Register `medical_image_observe` on `ctx.tools`.
 * @param ctx - the context whose tool registry receives the definition.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'medical_image_observe',
    description,
    parameters: {
      attachmentId: {
        type: 'string',
        required: true,
        description: 'The attachmentId of the image, copied verbatim from the image handle in this conversation: the '
          + 'full value inside attachmentId="..." exactly as written, including its "sha256:" prefix. It is NOT the '
          + 'display name, the file name, a digest with the prefix removed, a file path, or the image position, and it '
          + 'must not be shortened, recomputed, or rewritten. An id that was not attached to this session is rejected, '
          + 'and the harness uses its own record of the image rather than any detail you send.',
      },
      bodyRegion: {
        required: true,
        // Required AND nullable: "no region can be stated" is a fact worth
        // recording, and it is not the same as having left the field out. The
        // schema therefore admits an explicit null, and the domain refuses a
        // blank string rather than folding it into null.
        oneOf: [
          {
            type: 'string',
            description: 'The body region the image shows, as you would describe it (for example "left forearm").',
          },
          { type: 'null', description: 'Pass null when no body region can be stated from this image.' },
        ],
      },
      findings: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Every directly visible finding, one short phrase each (for example "irregular red patch", '
          + '"raised border"). Pass an empty array when nothing can be described. Do not include a diagnosis, a disease '
          + 'name, or a severity judgement.',
      },
      usable: {
        type: 'boolean',
        required: true,
        description: 'Whether any part of the image could be described. Pass false when the image cannot be assessed '
          + 'reliably, and list the quality issues that prevented it.',
      },
      qualityIssues: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: ['blur', 'poor_lighting', 'occlusion', 'too_distant', 'unable_to_assess'] },
        description: 'Every image limitation you observed. Pass an empty array when the image has none.',
      },
      uncertainty: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Everything you could not determine from this image (for example "depth cannot be judged from a '
          + 'single view"). Pass an empty array when there is nothing you are unsure about.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          bodyRegion: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          findings: { type: 'array', required: true, items: { type: 'string' } },
          usable: { type: 'boolean', required: true },
          qualityIssues: { type: 'array', required: true, items: { type: 'string' } },
          uncertainty: { type: 'array', required: true, items: { type: 'string' } },
          changed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderObservation(value) }],
    },
    execute(args, execution: ToolRunContext) {
      const agent = execution.agent
      if (agent === undefined) {
        throw new HarnessError(
          'medical_image_observe requires a calling agent session',
          'MEDICAL_IMAGE_AGENT_REQUIRED',
        )
      }
      const result = ctx.medicalImage.observe(agent, {
        attachmentId: args.attachmentId,
        bodyRegion: args.bodyRegion,
        findings: args.findings,
        usable: args.usable,
        qualityIssues: args.qualityIssues,
        uncertainty: args.uncertainty,
      })
      return Promise.resolve({
        attachmentId: String(result.view.attachment.attachmentId),
        revision: result.view.revision,
        bodyRegion: result.view.bodyRegion,
        findings: result.view.findings,
        usable: result.view.quality.usable,
        qualityIssues: result.view.quality.issues,
        uncertainty: result.view.uncertainty,
        changed: result.changed,
      })
    },
  }))
}
