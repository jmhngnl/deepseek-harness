/**
 * Model-facing `medical_image_observe` tool: records what the model saw in one
 * image the session already holds.
 *
 * The model has ALREADY looked at the image — that is why the image was in its
 * request. This tool does not read the image, does not call a model, and does not
 * re-derive anything from the bytes. It takes the model's structured account of
 * what is directly visible, hands it to the domain service, and returns the
 * authoritative observation.
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

const description = 'Record what you can DIRECTLY SEE in an image the user attached to this conversation. '
  + 'Use it once per image, after you have looked at the image. '
  + 'Pass the attachmentId shown beside the image in the conversation; the harness resolves it against this session and '
  + 'rejects an id that was not attached here. '
  + 'Record only visible properties: body region, colour, shape, size, distribution, surface appearance, swelling, '
  + 'discoloration, or anything else you can point at in the picture. '
  + 'State image limitations (blur, poor lighting, occlusion, too distant, unable to assess) and what you could not '
  + 'determine. If the image cannot be assessed reliably, set usable to false and say why rather than guessing. '
  + 'Do NOT state a diagnosis, name a disease or condition, suggest treatment or medication, or give a risk, urgency, or '
  + 'triage judgement: this tool records visible evidence, not a clinical conclusion. '
  + 'Do NOT restate these findings as patient-reported symptoms; the case record is updated only from what the user says. '
  + 'Repeating the same observation is a no-op and does not create a new revision.'

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
        description: 'The attachment id shown beside the image in this conversation. An id that was not attached to '
          + 'this session is rejected, and the harness uses its own record of the image rather than any detail you send.',
      },
      bodyRegion: {
        type: 'string',
        description: 'The body region the image shows, as you would describe it (for example "left forearm"). '
          + 'Omit when you cannot tell.',
      },
      findings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Directly visible findings, one short phrase each (for example "irregular red patch", '
          + '"raised border", "dry flaking surface"). Pass an empty array or omit when nothing can be described. '
          + 'Do not include a diagnosis, a disease name, or a severity judgement.',
      },
      usable: {
        type: 'boolean',
        required: true,
        description: 'Whether any part of the image could be described. Pass false when the image cannot be assessed '
          + 'reliably, and list the quality issues that prevented it.',
      },
      qualityIssues: {
        type: 'array',
        items: { type: 'string', enum: ['blur', 'poor_lighting', 'occlusion', 'too_distant', 'unable_to_assess'] },
        description: 'Image limitations you observed. Omit when the image has none.',
      },
      uncertainty: {
        type: 'array',
        items: { type: 'string' },
        description: 'What you could not determine from this image (for example "depth cannot be judged from a single '
          + 'view"). Omit when there is nothing you are unsure about.',
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
        ...args.bodyRegion === undefined ? {} : { bodyRegion: args.bodyRegion },
        ...args.findings === undefined ? {} : { findings: args.findings },
        usable: args.usable,
        ...args.qualityIssues === undefined ? {} : { qualityIssues: args.qualityIssues },
        ...args.uncertainty === undefined ? {} : { uncertainty: args.uncertainty },
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
