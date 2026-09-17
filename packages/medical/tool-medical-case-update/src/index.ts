/**
 * Model-facing `medical_case_update` tool: applies one incremental change to the
 * session's recorded case and returns the authoritative result.
 *
 * The tool is a thin consumer of `ctx.medicalCase`. Its parameter contract is
 * deliberately narrow: a field the model omits keeps its recorded value, and no
 * parameter quietly clears one.
 * @module @deepseek-ai/dsh-tool-medical-case-update
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
// Resolves the `ctx.medicalCase` service declaration published by the domain.
import type {} from '@deepseek-ai/dsh-medical-case'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-medical-case-update'

/** Services required by the medical case update tool. */
export const inject = ['agents', 'medicalCase', 'tools']

const description = 'Apply one incremental change to the case this session already recorded. '
  + 'Use it for every follow-up the user gives after the case exists: a new symptom, a duration, an age, or extra notes. '
  + 'A field you omit keeps its recorded value, so send only what the user just told you. '
  + 'For symptoms, prefer symptomsAdd for "also ..." and symptomsRemove to correct a mistake; pass symptoms only when the user restates the whole list. '
  + 'symptoms cannot be combined with symptomsAdd or symptomsRemove, and one symptom cannot be both added and removed. '
  + 'Never send a blank or empty value to erase something: this tool does not clear recorded facts. '
  + 'The call returns the authoritative record after the change, with missingFields telling you what to ask for next. '
  + 'This tool records and structures input only: it does not diagnose a condition, recommend treatment or medication, or assess medical risk.'

/** The value shape the output schema projects, as the renderer receives it. */
interface RenderedRecord {
  symptoms: string[]
  duration: string | null
  age: number | null
  additionalNotes: string | null
  missingFields: readonly string[]
  revision: number
  changed: boolean
}

/** Render the authoritative record as the text the model reads. */
function renderRecord(value: RenderedRecord): string {
  return [
    value.changed ? 'Case record updated.' : 'Nothing changed; the record already matched this call.',
    `symptoms: ${value.symptoms.length > 0 ? value.symptoms.join(', ') : '(none provided)'}`,
    `duration: ${value.duration ?? '(none provided)'}`,
    `age: ${value.age === null ? '(none provided)' : String(value.age)}`,
    `additionalNotes: ${value.additionalNotes ?? '(none provided)'}`,
    `missingFields: ${value.missingFields.length > 0 ? value.missingFields.join(', ') : '(none)'}`,
    `revision: ${String(value.revision)}`,
  ].join('\n')
}

/**
 * Register `medical_case_update` on `ctx.tools`.
 * @param ctx - the context whose tool registry receives the definition.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'medical_case_update',
    description,
    parameters: {
      symptoms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace the whole symptom list. Use only when the user restates the complete list; it cannot be combined with symptomsAdd or symptomsRemove, and an empty list is rejected.',
      },
      symptomsAdd: {
        type: 'array',
        items: { type: 'string' },
        description: 'Symptoms to append, keeping the ones already recorded. Use this for "also ...". Entries are trimmed, blanks dropped, and exact repeats ignored.',
      },
      symptomsRemove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Symptoms to drop, for correcting an earlier record. A symptom that is not recorded is ignored. One symptom cannot appear in both symptomsAdd and symptomsRemove.',
      },
      duration: {
        type: 'string',
        description: 'Replacement duration text, as the user phrased it. Omit to keep the recorded value; a blank string is rejected.',
      },
      age: {
        type: 'integer',
        description: 'Replacement patient age in whole years; 0 is valid for an infant under one year. Omit to keep the recorded value. Values outside 0\u2013130 are rejected.',
      },
      additionalNotes: {
        type: 'string',
        description: 'Replacement optional notes. Omit to keep the recorded value; a blank string is rejected.',
      },
    },
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
          changed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRecord(value) }],
    },
    execute(args, execution: ToolRunContext) {
      const agent = execution.agent
      if (agent === undefined) {
        throw new HarnessError('medical_case_update requires a calling agent session', 'MEDICAL_CASE_AGENT_REQUIRED')
      }
      const { view, changed } = ctx.medicalCase.applyPatch(agent, args)
      return Promise.resolve({ ...view, changed })
    },
  }))
}
