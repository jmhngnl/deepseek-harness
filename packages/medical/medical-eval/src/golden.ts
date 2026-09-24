/**
 * Strict reader for the golden-case contract.
 *
 * A golden case is versioned data, not a test fixture: the roster is reviewed
 * and replayed against a real model, so a document that does not say what its
 * author meant has to fail loudly at load time. Two rules follow from that.
 * Every member is checked against its declared type, and **unknown members are
 * rejected** — without that, a mistyped `caseStete` would read as "no state
 * expectation", which is the one failure mode that silently weakens the
 * suite.
 *
 * @module @deepseek-ai/dsh-medical-eval
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseOperation, MissingField } from '@deepseek-ai/dsh-medical-case'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { GOLDEN_CASE_SCHEMA_VERSION, GoldenCaseError, isJson } from './runtime.ts'
import type {
  CaseStateExpectation,
  ExpectedToolCall,
  GoldenCase,
  GoldenTurn,
  MutationExpectation,
  ToolRoutingExpectation,
  TurnExpectation,
} from './types.ts'

/**
 * Read every golden case in a directory, in file-name order.
 *
 * The directory is a parameter rather than a constant because this package's
 * own source and its built output sit at different depths; a caller names the
 * roster it means, and no path is guessed at load time.
 * @param directory - directory holding golden-case documents.
 * @returns the validated cases, ordered by file name.
 * @throws {@link GoldenCaseError} for a document that does not satisfy the contract.
 */
export function loadGoldenCases(directory: string): GoldenCase[] {
  return readdirSync(directory)
    .filter(entry => entry.endsWith('.json'))
    .sort()
    .map(entry => parseGoldenCase(readDocument(join(directory, entry)), entry))
}

/** Read one JSON document, so a malformed file fails as a parse error naming nothing it does not know. */
function readDocument(path: string): unknown {
  const text = readFileSync(path, 'utf8')
  return JSON.parse(text)
}

/** Members each object of the contract admits, so a typo cannot read as absence. */
const CASE_KEYS = ['schemaVersion', 'id', 'description', 'turns']
const TURN_KEYS = ['user', 'expect']
const EXPECT_KEYS = ['toolRouting', 'caseState', 'mutation']
const ROUTING_KEYS = ['kind', 'calls']
const CALL_KEYS = ['name', 'arguments']
const CASE_STATE_KEYS = ['symptoms', 'duration', 'age', 'additionalNotes', 'revision', 'missingFields']
const MUTATION_KEYS = ['changed', 'eventCountDelta', 'operations']

/** Durable verbs an expectation may name, as a lookup rather than a narrowing cast. */
const OPERATIONS: Readonly<Record<string, CaseOperation | undefined>> = {
  create: 'create',
  update: 'update',
}

/** Required facts an expectation may name. */
const MISSING_FIELDS: Readonly<Record<string, MissingField | undefined>> = {
  symptoms: 'symptoms',
  duration: 'duration',
  age: 'age',
}

/**
 * Read one golden case.
 * @param value - the candidate document, typically `JSON.parse` output.
 * @param source - where it came from, used as the root of every error path.
 * @returns the validated case.
 * @throws {@link GoldenCaseError} naming the first member that does not satisfy the contract.
 */
export function parseGoldenCase(value: unknown, source: string): GoldenCase {
  const document = asRecord(value, source)
  rejectUnknownKeys(document, CASE_KEYS, source)
  if (document['schemaVersion'] !== GOLDEN_CASE_SCHEMA_VERSION) {
    throw new GoldenCaseError(
      `${source}.schemaVersion must be ${String(GOLDEN_CASE_SCHEMA_VERSION)}; received ${JSON.stringify(document['schemaVersion'])}`,
    )
  }
  const turns = asArray(document['turns'], `${source}.turns`)
    .map((turn, index) => parseGoldenTurn(turn, `${source}.turns[${String(index)}]`))
  if (turns.length === 0) throw new GoldenCaseError(`${source}.turns must hold at least one turn`)
  return {
    schemaVersion: GOLDEN_CASE_SCHEMA_VERSION,
    id: asText(document['id'], `${source}.id`),
    description: asText(document['description'], `${source}.description`),
    turns,
  }
}

/** Read one turn of a golden case. */
function parseGoldenTurn(value: unknown, path: string): GoldenTurn {
  const turn = asRecord(value, path)
  rejectUnknownKeys(turn, TURN_KEYS, path)
  return {
    user: asText(turn['user'], `${path}.user`),
    expect: parseTurnExpectation(turn['expect'], `${path}.expect`),
  }
}

/** Read what one turn is measured against. */
function parseTurnExpectation(value: unknown, path: string): TurnExpectation {
  const expectation = asRecord(value, path)
  rejectUnknownKeys(expectation, EXPECT_KEYS, path)
  const caseState = optionalMember(expectation, 'caseState', path, parseCaseStateExpectation)
  const mutation = optionalMember(expectation, 'mutation', path, parseMutationExpectation)
  const parsed: {
    toolRouting: ToolRoutingExpectation
    caseState?: CaseStateExpectation
    mutation?: MutationExpectation
  } = { toolRouting: parseToolRouting(expectation['toolRouting'], `${path}.toolRouting`) }
  if (caseState !== undefined) parsed.caseState = caseState
  if (mutation !== undefined) parsed.mutation = mutation
  return parsed
}

/** Read the tool calls one turn must produce. */
function parseToolRouting(value: unknown, path: string): ToolRoutingExpectation {
  const routing = asRecord(value, path)
  rejectUnknownKeys(routing, ROUTING_KEYS, path)
  if (routing['kind'] !== 'exact') {
    throw new GoldenCaseError(`${path}.kind must be "exact"; received ${JSON.stringify(routing['kind'])}`)
  }
  return {
    kind: 'exact',
    calls: asArray(routing['calls'], `${path}.calls`)
      .map((call, index) => parseExpectedToolCall(call, `${path}.calls[${String(index)}]`)),
  }
}

/** Read one pinned tool call. */
function parseExpectedToolCall(value: unknown, path: string): ExpectedToolCall {
  const call = asRecord(value, path)
  rejectUnknownKeys(call, CALL_KEYS, path)
  const args = optionalMember(call, 'arguments', path, asJsonRecord)
  const parsed: { name: string; arguments?: Readonly<Record<string, JsonValue>> } = {
    name: asText(call['name'], `${path}.name`),
  }
  if (args !== undefined) parsed.arguments = args
  return parsed
}

/** Read the case-state fields one turn pins. */
function parseCaseStateExpectation(value: unknown, path: string): CaseStateExpectation {
  const expectation = asRecord(value, path)
  rejectUnknownKeys(expectation, CASE_STATE_KEYS, path)
  const parsed: {
    symptoms?: readonly string[]
    duration?: string | null
    age?: number | null
    additionalNotes?: string | null
    revision?: number
    missingFields?: readonly MissingField[]
  } = {}
  const symptoms = optionalMember(expectation, 'symptoms', path, asTextArray)
  const duration = optionalMember(expectation, 'duration', path, asNullableText)
  const age = optionalMember(expectation, 'age', path, asNullableWholeNumber)
  const additionalNotes = optionalMember(expectation, 'additionalNotes', path, asNullableText)
  const revision = optionalMember(expectation, 'revision', path, asRevision)
  const missingFields = optionalMember(expectation, 'missingFields', path, asMissingFieldArray)
  if (symptoms !== undefined) parsed.symptoms = symptoms
  if (duration !== undefined) parsed.duration = duration
  if (age !== undefined) parsed.age = age
  if (additionalNotes !== undefined) parsed.additionalNotes = additionalNotes
  if (revision !== undefined) parsed.revision = revision
  if (missingFields !== undefined) parsed.missingFields = missingFields
  return parsed
}

/** Read what one turn must do to the durable record. */
function parseMutationExpectation(value: unknown, path: string): MutationExpectation {
  const expectation = asRecord(value, path)
  rejectUnknownKeys(expectation, MUTATION_KEYS, path)
  const parsed: {
    changed?: boolean
    eventCountDelta?: number
    operations?: readonly CaseOperation[]
  } = {}
  const changed = optionalMember(expectation, 'changed', path, asBoolean)
  const eventCountDelta = optionalMember(expectation, 'eventCountDelta', path, asWholeNumber)
  const operations = optionalMember(expectation, 'operations', path, asOperationArray)
  if (changed !== undefined) parsed.changed = changed
  if (eventCountDelta !== undefined) parsed.eventCountDelta = eventCountDelta
  if (operations !== undefined) parsed.operations = operations
  return parsed
}

/** Whether a value is a JSON record rather than an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require a JSON record, rejecting arrays and null. */
function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GoldenCaseError(`${path} must be an object`)
  return value
}

/** Reject any member the contract does not define at this level. */
function rejectUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new GoldenCaseError(`${path}.${key} is not a member of the golden-case contract`)
    }
  }
}

/** Require an array. */
function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new GoldenCaseError(`${path} must be an array`)
  return value
}

/** Require non-blank text. */
function asText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GoldenCaseError(`${path} must be a non-empty string`)
  }
  return value
}

/** Require a boolean. */
function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new GoldenCaseError(`${path} must be a boolean`)
  return value
}

/** Require a whole number of at least `minimum`. */
function asInteger(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new GoldenCaseError(`${path} must be a whole number of at least ${String(minimum)}`)
  }
  return value
}

/** Require a whole count. */
function asWholeNumber(value: unknown, path: string): number {
  return asInteger(value, path, 0)
}

/** Require a positive revision, which the durable contract defines as one or more. */
function asRevision(value: unknown, path: string): number {
  return asInteger(value, path, 1)
}

/** Require text or an explicit null, which is how a golden case pins "not recorded". */
function asNullableText(value: unknown, path: string): string | null {
  return value === null ? null : asText(value, path)
}

/** Require a whole number or an explicit null. */
function asNullableWholeNumber(value: unknown, path: string): number | null {
  return value === null ? null : asWholeNumber(value, path)
}

/** Require an array of symptom texts. */
function asTextArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((entry, index) => asText(entry, `${path}[${String(index)}]`))
}

/** Require an array naming required facts. */
function asMissingFieldArray(value: unknown, path: string): MissingField[] {
  return asArray(value, path).map((entry, index) => asMissingField(entry, `${path}[${String(index)}]`))
}

/** Require an array naming durable verbs. */
function asOperationArray(value: unknown, path: string): CaseOperation[] {
  return asArray(value, path).map((entry, index) => asOperation(entry, `${path}[${String(index)}]`))
}

/** Require one of the required facts the read model reports. */
function asMissingField(value: unknown, path: string): MissingField {
  const field = MISSING_FIELDS[asText(value, path)]
  if (field === undefined) {
    throw new GoldenCaseError(`${path} must be one of ${Object.keys(MISSING_FIELDS).join(', ')}`)
  }
  return field
}

/** Require one of the durable verbs. */
function asOperation(value: unknown, path: string): CaseOperation {
  const operation = OPERATIONS[asText(value, path)]
  if (operation === undefined) {
    throw new GoldenCaseError(`${path} must be one of ${Object.keys(OPERATIONS).join(', ')}`)
  }
  return operation
}

/**
 * Require an object whose every value survives a JSON round trip. The compared
 * arguments travel through the session log, so an expectation holding a value
 * that could not have been logged could never match.
 */
function asJsonRecord(value: unknown, path: string): Record<string, JsonValue> {
  const record = asRecord(value, path)
  const parsed: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (!isJson(entry)) throw new GoldenCaseError(`${path}.${key} must be a JSON value`)
    parsed[key] = entry
  }
  return parsed
}

/**
 * Read one optional member, delegating its shape to `parse` and its path to
 * this level of the document.
 */
function optionalMember<T>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | undefined {
  const raw = record[key]
  return raw === undefined ? undefined : parse(raw, `${path}.${key}`)
}
