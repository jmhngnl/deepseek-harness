/**
 * Model-facing `medical_case_get` tool: reads the authoritative case record for
 * the current session without changing it.
 *
 * This is the explicit read path. The record is durable session state that
 * survives resume and fork, so an agent that needs it asks for it here rather
 * than relying on its conversation history to remember it.
 * @module @deepseek-ai/dsh-tool-medical-case-get
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
// Resolves the `ctx.medicalCase` service declaration published by the domain.
import type {} from '@deepseek-ai/dsh-medical-case'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-medical-case-get'

/** Services required by the medical case read tool. */
export const inject = ['agents', 'medicalCase', 'tools']

const description = 'Read the case record this session has already recorded, without changing it. '
  + 'Use it to re-check the authoritative facts and the fields still missing, for example after a long conversation, '
  + 'after the record was updated, or whenever you are unsure what has actually been captured. '
  + 'The returned record is authoritative: it comes from the session\u2019s durable case state, not from conversation memory. '
  + 'It fails when this session has recorded no case yet; record one with medical_case_intake first. '
  + 'This tool reads and structures input only: it does not diagnose a condition, recommend treatment or medication, or assess medical risk.'

/** The value shape the output schema projects, as the renderer receives it. */
interface RenderedRecord {
  symptoms: string[]
  duration: string | null
  age: number | null
  additionalNotes: string | null
  missingFields: readonly string[]
  revision: number
}

/** Render the authoritative record as the text the model reads. */
function renderRecord(value: RenderedRecord): string {
  return [
    'Current case record.',
    `symptoms: ${value.symptoms.length > 0 ? value.symptoms.join(', ') : '(none provided)'}`,
    `duration: ${value.duration ?? '(none provided)'}`,
    `age: ${value.age === null ? '(none provided)' : String(value.age)}`,
    `additionalNotes: ${value.additionalNotes ?? '(none provided)'}`,
    `missingFields: ${value.missingFields.length > 0 ? value.missingFields.join(', ') : '(none)'}`,
    `revision: ${String(value.revision)}`,
  ].join('\n')
}

/**
 * Register `medical_case_get` on `ctx.tools`.
 * @param ctx - the context whose tool registry receives the definition.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'medical_case_get',
    description,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          caseId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          symptoms: { type: 'array', required: true, items: { type: 'string' } },
          duration: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          age: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          additionalNotes: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          createdAt: { type: 'integer', required: true },
          updatedAt: { type: 'integer', required: true },
          missingFields: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRecord(value) }],
    },
    execute(_args, execution: ToolRunContext) {
      const agent = execution.agent
      if (agent === undefined) {
        throw new HarnessError('medical_case_get requires a calling agent session', 'MEDICAL_CASE_AGENT_REQUIRED')
      }
      return Promise.resolve(ctx.medicalCase.require(agent))
    },
  }))
}
