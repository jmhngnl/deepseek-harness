/**
 * Model-facing `medical_case_intake` tool: records the case basics a user
 * volunteers into the session's durable case, and reports the facts still
 * missing so the agent asks for them instead of inventing them.
 *
 * The tool is a thin consumer of `ctx.medicalCase`. It owns only its
 * model-facing schema and rendering; every merge, revision, and read decision
 * belongs to the domain.
 * @module @deepseek-ai/dsh-tool-medical-case-intake
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
// Resolves the `ctx.medicalCase` service declaration published by the domain.
import type {} from '@deepseek-ai/dsh-medical-case'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-medical-case-intake'

/** Services required by the medical case intake tool. */
export const inject = ['agents', 'medicalCase', 'tools']

const description = 'Record the basic case information a user provides — symptoms, duration, age, and optional additional notes — '
  + 'into this session\u2019s durable case record, and report which required fields are still missing. '
  + 'Call it when a user first describes a case, and again only when they restate facts already recorded. '
  + 'For every later answer, such as a new symptom or a duration they had not given, call medical_case_update instead. '
  + 'Omit a field the user has said nothing about rather than sending an empty or blank value. '
  + 'A successful call returns the authoritative record; fields the user did not supply come back as null (or an empty array for symptoms) '
  + 'and are listed in missingFields. Ask the user for the fields named in missingFields rather than guessing them. '
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
    value.changed ? 'Case record updated.' : 'Case record already matched this description; no revision was added.',
    `symptoms: ${value.symptoms.length > 0 ? value.symptoms.join(', ') : '(none provided)'}`,
    `duration: ${value.duration ?? '(none provided)'}`,
    `age: ${value.age === null ? '(none provided)' : String(value.age)}`,
    `additionalNotes: ${value.additionalNotes ?? '(none provided)'}`,
    `missingFields: ${value.missingFields.length > 0 ? value.missingFields.join(', ') : '(none)'}`,
    `revision: ${String(value.revision)}`,
  ].join('\n')
}

/**
 * Register `medical_case_intake` on `ctx.tools`.
 * @param ctx - the context whose tool registry receives the definition.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'medical_case_intake',
    description,
    parameters: {
      symptoms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Symptoms as the user described them. Pass an empty array or omit when the user has not named any.',
      },
      duration: {
        type: 'string',
        description: 'How long the symptoms have lasted, as the user phrased it (for example "2 days"). Omit when the user has not said.',
      },
      age: {
        type: 'integer',
        description: 'The patient\u2019s age in whole years; 0 is valid for an infant under one year. Omit when the user has not said. Values outside 0\u2013130 are rejected.',
      },
      additionalNotes: {
        type: 'string',
        description: 'Any other case context the user volunteered. Optional: omitting it never counts as missing information.',
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
        throw new HarnessError('medical_case_intake requires a calling agent session', 'MEDICAL_CASE_AGENT_REQUIRED')
      }
      const { view, changed } = ctx.medicalCase.intake(agent, args)
      return Promise.resolve({ ...view, changed })
    },
  }))
}
