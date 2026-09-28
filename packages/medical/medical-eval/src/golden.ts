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
import type { ImageObservationOperation, ImageQualityIssue } from '@deepseek-ai/dsh-medical-image'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { fixtureIds } from './fixtures.ts'
import { GOLDEN_CASE_SCHEMA_VERSION, GoldenCaseError, isJson } from './runtime.ts'
import type {
  CaseStateExpectation,
  ExpectedToolCall,
  GoldenCase,
  GoldenImageInput,
  GoldenTurn,
  ImageMutationEventExpectation,
  ImageMutationExpectation,
  ImageObservationExpectation,
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
const TURN_KEYS = ['user', 'images', 'expect']
const EXPECT_KEYS = ['toolRouting', 'caseState', 'mutation', 'imageObservations', 'imageMutation']
const ROUTING_KEYS = ['kind', 'calls']
const CALL_KEYS = ['name', 'arguments']
const CASE_STATE_KEYS = ['symptoms', 'duration', 'age', 'additionalNotes', 'revision', 'missingFields']
const MUTATION_KEYS = ['changed', 'eventCountDelta', 'operations']
const IMAGE_INPUT_KEYS = ['key', 'fixture']
const IMAGE_OBSERVATION_KEYS = [
  'imageKey', 'bodyRegion', 'findings', 'minimumFindings', 'usable', 'qualityIssues', 'uncertainty', 'revision',
]
const IMAGE_MUTATION_KEYS = ['changed', 'eventCountDelta', 'events']
const IMAGE_MUTATION_EVENT_KEYS = ['imageKey', 'operation', 'revision']

/** Durable image verbs an expectation may name, as a lookup rather than a narrowing cast. */
const IMAGE_OPERATIONS: Readonly<Record<string, ImageObservationOperation | undefined>> = {
  observe: 'observe',
  update: 'update',
}

/** Quality limitations an expectation may name, as a lookup rather than a narrowing cast. */
const QUALITY_ISSUES: Readonly<Record<string, ImageQualityIssue | undefined>> = {
  blur: 'blur',
  poor_lighting: 'poor_lighting',
  occlusion: 'occlusion',
  too_distant: 'too_distant',
  unable_to_assess: 'unable_to_assess',
}

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
  assertImageKeys(turns, source)
  return {
    schemaVersion: GOLDEN_CASE_SCHEMA_VERSION,
    id: asText(document['id'], `${source}.id`),
    description: asText(document['description'], `${source}.description`),
    turns,
  }
}

/**
 * Assert the image keys a case uses are unambiguous.
 *
 * Two rules, both about what a key means. A key is unique inside one turn,
 * because one message cannot carry the same logical image twice and still have
 * the runner resolve it. And a key names ONE fixture for the whole case, because
 * an expectation refers to the key alone: a key that meant one image in turn one
 * and another in turn two would make every expectation written against it
 * meaningless.
 *
 * The same fixture under two keys is allowed, and so is one key across several
 * turns — that is how a case says "the same image, looked at again".
 */
function assertImageKeys(turns: readonly GoldenTurn[], source: string): void {
  const fixtureByKey = new Map<string, string>()
  for (const [turnIndex, turn] of turns.entries()) {
    const path = `${source}.turns[${String(turnIndex)}].images`
    const seenHere = new Set<string>()
    for (const [imageIndex, image] of (turn.images ?? []).entries()) {
      if (seenHere.has(image.key)) {
        throw new GoldenCaseError(`${path}[${String(imageIndex)}].key ${JSON.stringify(image.key)} is used twice in this turn`)
      }
      seenHere.add(image.key)
      const named = fixtureByKey.get(image.key)
      if (named === undefined) {
        fixtureByKey.set(image.key, image.fixture)
        continue
      }
      if (named !== image.fixture) {
        throw new GoldenCaseError(
          `${path}[${String(imageIndex)}].key ${JSON.stringify(image.key)} names fixture ${JSON.stringify(image.fixture)},`
          + ` but an earlier turn named ${JSON.stringify(named)} for the same key`,
        )
      }
    }
  }
}

/** Read one turn of a golden case. */
function parseGoldenTurn(value: unknown, path: string): GoldenTurn {
  const turn = asRecord(value, path)
  rejectUnknownKeys(turn, TURN_KEYS, path)
  const images = optionalMember(turn, 'images', path, parseImageInputs)
  const parsed: { user: string; images?: readonly GoldenImageInput[]; expect: TurnExpectation } = {
    user: asText(turn['user'], `${path}.user`),
    expect: parseTurnExpectation(turn['expect'], `${path}.expect`),
  }
  if (images !== undefined) parsed.images = images
  return parsed
}

/** Read the synthetic images one turn attaches, in message order. */
function parseImageInputs(value: unknown, path: string): GoldenImageInput[] {
  const images = asArray(value, path)
  if (images.length === 0) throw new GoldenCaseError(`${path} must name at least one image; omit the member for a text-only turn`)
  return images.map((image, index) => {
    const at = `${path}[${String(index)}]`
    const input = asRecord(image, at)
    rejectUnknownKeys(input, IMAGE_INPUT_KEYS, at)
    const fixture = asText(input['fixture'], `${at}.fixture`)
    // The registry is the only authority on what a fixture id may be, so an id
    // it does not hold fails here rather than at replay time — and a case can
    // never name a file the package does not own.
    if (!fixtureIds().includes(fixture)) {
      throw new GoldenCaseError(
        `${at}.fixture ${JSON.stringify(fixture)} is not a registered fixture;`
        + ` the registry holds ${fixtureIds().join(', ')}`,
      )
    }
    return { key: asText(input['key'], `${at}.key`), fixture }
  })
}

/** Read what one turn is measured against. */
function parseTurnExpectation(value: unknown, path: string): TurnExpectation {
  const expectation = asRecord(value, path)
  rejectUnknownKeys(expectation, EXPECT_KEYS, path)
  const caseState = optionalMember(expectation, 'caseState', path, parseCaseStateExpectation)
  const mutation = optionalMember(expectation, 'mutation', path, parseMutationExpectation)
  const imageObservations = optionalMember(expectation, 'imageObservations', path, parseImageObservations)
  const imageMutation = optionalMember(expectation, 'imageMutation', path, parseImageMutationExpectation)
  const parsed: {
    toolRouting: ToolRoutingExpectation
    caseState?: CaseStateExpectation
    mutation?: MutationExpectation
    imageObservations?: readonly ImageObservationExpectation[]
    imageMutation?: ImageMutationExpectation
  } = { toolRouting: parseToolRouting(expectation['toolRouting'], `${path}.toolRouting`) }
  if (caseState !== undefined) parsed.caseState = caseState
  if (mutation !== undefined) parsed.mutation = mutation
  if (imageObservations !== undefined) parsed.imageObservations = imageObservations
  if (imageMutation !== undefined) parsed.imageMutation = imageMutation
  return parsed
}

/** Read the authoritative image observations one turn must produce. */
function parseImageObservations(value: unknown, path: string): ImageObservationExpectation[] {
  const entries = asArray(value, path)
  if (entries.length === 0) throw new GoldenCaseError(`${path} must name at least one image; omit the member when the turn asserts none`)
  const parsed = entries.map((entry, index) => parseImageObservation(entry, `${path}[${String(index)}]`))
  const keys = parsed.map(entry => entry.imageKey)
  if (new Set(keys).size !== keys.length) {
    throw new GoldenCaseError(`${path} must not name the same imageKey twice`)
  }
  return parsed
}

/** Read the fields of one authoritative image observation an expectation pins. */
function parseImageObservation(value: unknown, path: string): ImageObservationExpectation {
  const expectation = asRecord(value, path)
  rejectUnknownKeys(expectation, IMAGE_OBSERVATION_KEYS, path)
  const findings = optionalMember(expectation, 'findings', path, asTextArray)
  const minimumFindings = optionalMember(expectation, 'minimumFindings', path, asWholeNumber)
  // Mutually exclusive on purpose: an exact list and a lower bound are two
  // different assertions, and accepting both would leave the evaluator choosing
  // which one the author meant.
  if (findings !== undefined && minimumFindings !== undefined) {
    throw new GoldenCaseError(`${path} must not carry both findings and minimumFindings`)
  }
  const parsed: {
    imageKey: string
    bodyRegion?: string | null
    findings?: readonly string[]
    minimumFindings?: number
    usable?: boolean
    qualityIssues?: readonly ImageQualityIssue[]
    uncertainty?: readonly string[]
    revision?: number
  } = { imageKey: asText(expectation['imageKey'], `${path}.imageKey`) }
  const bodyRegion = optionalMember(expectation, 'bodyRegion', path, asNullableText)
  const usable = optionalMember(expectation, 'usable', path, asBoolean)
  const qualityIssues = optionalMember(expectation, 'qualityIssues', path, asQualityIssueArray)
  const uncertainty = optionalMember(expectation, 'uncertainty', path, asTextArray)
  const revision = optionalMember(expectation, 'revision', path, asRevision)
  if (bodyRegion !== undefined) parsed.bodyRegion = bodyRegion
  if (findings !== undefined) parsed.findings = findings
  if (minimumFindings !== undefined) parsed.minimumFindings = minimumFindings
  if (usable !== undefined) parsed.usable = usable
  if (qualityIssues !== undefined) parsed.qualityIssues = qualityIssues
  if (uncertainty !== undefined) parsed.uncertainty = uncertainty
  if (revision !== undefined) parsed.revision = revision
  return parsed
}

/** Read what one turn must do to the durable image-observation records. */
function parseImageMutationExpectation(value: unknown, path: string): ImageMutationExpectation {
  const expectation = asRecord(value, path)
  rejectUnknownKeys(expectation, IMAGE_MUTATION_KEYS, path)
  const parsed: {
    changed?: boolean
    eventCountDelta?: number
    events?: readonly ImageMutationEventExpectation[]
  } = {}
  const changed = optionalMember(expectation, 'changed', path, asBoolean)
  const eventCountDelta = optionalMember(expectation, 'eventCountDelta', path, asWholeNumber)
  const events = optionalMember(expectation, 'events', path, asImageMutationEventArray)
  if (changed !== undefined) parsed.changed = changed
  if (eventCountDelta !== undefined) parsed.eventCountDelta = eventCountDelta
  if (events !== undefined) parsed.events = events
  return parsed
}

/** Read the durable image records an expectation pins, in order. */
function asImageMutationEventArray(value: unknown, path: string): ImageMutationEventExpectation[] {
  return asArray(value, path).map((entry, index) => {
    const at = `${path}[${String(index)}]`
    const event = asRecord(entry, at)
    rejectUnknownKeys(event, IMAGE_MUTATION_EVENT_KEYS, at)
    const revision = optionalMember(event, 'revision', at, asRevision)
    const parsed: { imageKey: string; operation: ImageObservationOperation; revision?: number } = {
      imageKey: asText(event['imageKey'], `${at}.imageKey`),
      operation: asImageOperation(event['operation'], `${at}.operation`),
    }
    if (revision !== undefined) parsed.revision = revision
    return parsed
  })
}

/** Require one of the durable image verbs. */
function asImageOperation(value: unknown, path: string): ImageObservationOperation {
  const operation = IMAGE_OPERATIONS[asText(value, path)]
  if (operation === undefined) {
    throw new GoldenCaseError(`${path} must be one of ${Object.keys(IMAGE_OPERATIONS).join(', ')}`)
  }
  return operation
}

/** Require an array of quality limitations. */
function asQualityIssueArray(value: unknown, path: string): ImageQualityIssue[] {
  return asArray(value, path).map((entry, index) => {
    const at = `${path}[${String(index)}]`
    const issue = QUALITY_ISSUES[asText(entry, at)]
    if (issue === undefined) {
      throw new GoldenCaseError(`${at} must be one of ${Object.keys(QUALITY_ISSUES).join(', ')}`)
    }
    return issue
  })
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
