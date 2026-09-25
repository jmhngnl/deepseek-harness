/**
 * The `pnpm medharness:eval` entry point: an invocation's arguments in, one
 * line of summary per fact out, and an exit code that reports whether every
 * case passed.
 *
 * Nothing here decides anything. The grammar, the selection, and the report all
 * live in `live.ts`, so this file is readable as the answer to "what does the
 * command do" — parse, select, boot, print — and a failure in it is an argument
 * or a composition fault rather than a judgement about a model.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import {
  liveRoster,
  parseLiveArgs,
  renderLiveArgsErrors,
  renderLiveSummary,
  runLiveEval,
  selectLiveCases,
} from './live.ts'
import type { LiveIo } from './live.ts'

const io: LiveIo = {
  out: (line) => { process.stdout.write(`${line}\n`) },
  err: (line) => { process.stderr.write(`${line}\n`) },
}

/**
 * Read one invocation and replay what it selected.
 * @param argv - the arguments after the script path.
 * @returns the process exit code: zero only when every selected case passed.
 */
async function run(argv: readonly string[]): Promise<number> {
  const roster = liveRoster()
  const parsed = parseLiveArgs(argv)
  if (parsed.args === undefined) {
    for (const line of renderLiveArgsErrors(parsed.errors, roster)) io.err(line)
    return 1
  }
  const selected = selectLiveCases(roster, parsed.args)
  if (selected.unknown.length > 0) {
    for (const line of renderLiveArgsErrors([`unknown case ${selected.unknown.join(', ')}`], roster)) {
      io.err(line)
    }
    return 1
  }
  io.out(`medharness:eval: replaying ${selected.cases.map(golden => golden.id).join(', ')}`)
  const { report, path } = await runLiveEval({ root: process.cwd(), cases: selected.cases })
  for (const line of renderLiveSummary(report, path)) io.out(line)
  return report.summary.casesPassed === report.summary.casesTotal ? 0 : 1
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error: unknown) {
  io.err(`medharness:eval: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
