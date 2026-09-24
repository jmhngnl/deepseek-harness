/**
 * Contract coverage for the golden-case reader: the shipped roster satisfies
 * the contract, and every member the contract defines is rejected when it does
 * not.
 *
 * The violations are driven from a table rather than written as separate
 * specs, because what matters is that each *rule* is enforced — thirty
 * near-identical specs would say the same thing while making it harder to see
 * which rule has no coverage.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { GoldenCaseError, loadGoldenCases, parseGoldenCase } from '../src/index.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** The directory the shipped roster lives in. */
const ROSTER = fileURLToPath(new URL('../golden/', import.meta.url))

/**
 * The three tools a golden case may route to. A case that named anything else
 * would be measuring a coding agent's surface, which this harness's subject
 * does not have.
 */
const MEDICAL_TOOLS = ['medical_case_intake', 'medical_case_update', 'medical_case_get']

/** A mutable golden-case document, so one test can break exactly one member. */
interface MutableTurn {
  user: string
  expect: {
    toolRouting: { kind: string; calls: { name: string; arguments?: unknown }[] }
    caseState?: unknown
    mutation?: unknown
  }
}

interface MutableCase {
  schemaVersion: number
  id: string
  description: string
  turns: MutableTurn[]
}

/** The smallest document that satisfies the contract. */
function validCase(): MutableCase {
  return {
    schemaVersion: 1,
    id: 'restatement',
    description: 'A minimal document that isolates one contract violation at a time.',
    turns: [{
      user: '我头疼',
      expect: { toolRouting: { kind: 'exact', calls: [{ name: 'medical_case_intake' }] } },
    }],
  }
}

/** The fixture's turn, which every case starts with exactly one of. */
function turnOf(document: MutableCase): MutableTurn {
  const [turn] = document.turns
  if (turn === undefined) throw new Error('the fixture has no turn')
  return turn
}

/** The fixture's pinned call, which every case starts with exactly one of. */
function callOf(document: MutableCase): { name: string; arguments?: unknown } {
  const [call] = turnOf(document).expect.toolRouting.calls
  if (call === undefined) throw new Error('the fixture has no call')
  return call
}

/** One rule, the mutation that breaks it, and the error the reader must raise. */
type Violation = readonly [rule: string, mutate: (document: MutableCase) => void, message: string]

const VIOLATIONS: readonly Violation[] = [
  ['a document version the reader does not know', (d) => { d.schemaVersion = 2 }, 'doc.schemaVersion must be 1'],
  ['a blank case id', (d) => { d.id = '  ' }, 'doc.id must be a non-empty string'],
  ['a missing case id', (d) => { Reflect.deleteProperty(d, 'id') }, 'doc.id must be a non-empty string'],
  ['a blank description', (d) => { d.description = '' }, 'doc.description must be a non-empty string'],
  ['turns that are not a list', (d) => { Reflect.set(d, 'turns', {}) }, 'doc.turns must be an array'],
  ['no turns at all', (d) => { d.turns = [] }, 'doc.turns must hold at least one turn'],
  ['a member the contract does not define', (d) => { Reflect.set(d, 'notes', 'x') }, 'doc.notes is not a member'],
  ['a turn member the contract does not define', (d) => { Reflect.set(turnOf(d), 'text', 'x') }, 'doc.turns[0].text is not a member'],
  ['a blank user utterance', (d) => { turnOf(d).user = ' ' }, 'doc.turns[0].user must be a non-empty string'],
  ['a turn without an expectation', (d) => { Reflect.deleteProperty(turnOf(d), 'expect') }, 'doc.turns[0].expect must be an object'],
  ['an expectation member the contract does not define', (d) => { Reflect.set(turnOf(d).expect, 'tools', []) }, 'doc.turns[0].expect.tools is not a member'],
  ['a routing member the contract does not define', (d) => { Reflect.set(turnOf(d).expect.toolRouting, 'mode', 'exact') }, 'doc.turns[0].expect.toolRouting.mode is not a member'],
  ['a routing kind other than exact', (d) => { turnOf(d).expect.toolRouting.kind = 'oneOf' }, 'doc.turns[0].expect.toolRouting.kind must be "exact"'],
  ['calls that are not a list', (d) => { Reflect.set(turnOf(d).expect.toolRouting, 'calls', 'medical_case_get') }, 'doc.turns[0].expect.toolRouting.calls must be an array'],
  ['a call member the contract does not define', (d) => { Reflect.set(callOf(d), 'args', {}) }, 'doc.turns[0].expect.toolRouting.calls[0].args is not a member'],
  ['a blank tool name', (d) => { callOf(d).name = '' }, 'doc.turns[0].expect.toolRouting.calls[0].name must be a non-empty string'],
  ['arguments that are not an object', (d) => { callOf(d).arguments = 'symptoms' }, 'doc.turns[0].expect.toolRouting.calls[0].arguments must be an object'],
  ['arguments holding a value JSON cannot carry', (d) => {
    callOf(d).arguments = { age: Number.POSITIVE_INFINITY }
  }, 'doc.turns[0].expect.toolRouting.calls[0].arguments.age must be a JSON value'],
  ['a state expectation that is not an object', (d) => { turnOf(d).expect.caseState = 'complete' }, 'doc.turns[0].expect.caseState must be an object'],
  ['a state member the contract does not define', (d) => { turnOf(d).expect.caseState = { caseId: 'x' } }, 'doc.turns[0].expect.caseState.caseId is not a member'],
  ['symptoms that are not a list', (d) => { turnOf(d).expect.caseState = { symptoms: '头疼' } }, 'doc.turns[0].expect.caseState.symptoms must be an array'],
  ['a blank symptom', (d) => { turnOf(d).expect.caseState = { symptoms: ['  '] } }, 'doc.turns[0].expect.caseState.symptoms[0] must be a non-empty string'],
  ['a duration that is not text', (d) => { turnOf(d).expect.caseState = { duration: 2 } }, 'doc.turns[0].expect.caseState.duration must be a non-empty string'],
  ['a duration that is blank rather than null', (d) => { turnOf(d).expect.caseState = { duration: '' } }, 'doc.turns[0].expect.caseState.duration must be a non-empty string'],
  ['an age that is not whole', (d) => { turnOf(d).expect.caseState = { age: 25.5 } }, 'doc.turns[0].expect.caseState.age must be a whole number'],
  ['a negative age', (d) => { turnOf(d).expect.caseState = { age: -1 } }, 'doc.turns[0].expect.caseState.age must be a whole number'],
  ['blank notes', (d) => { turnOf(d).expect.caseState = { additionalNotes: '' } }, 'doc.turns[0].expect.caseState.additionalNotes must be a non-empty string'],
  ['a revision below one', (d) => { turnOf(d).expect.caseState = { revision: 0 } }, 'doc.turns[0].expect.caseState.revision must be a whole number of at least 1'],
  ['a missing field the read model cannot report', (d) => { turnOf(d).expect.caseState = { missingFields: ['fever'] } }, 'doc.turns[0].expect.caseState.missingFields[0] must be one of'],
  ['missing fields that are not a list', (d) => { turnOf(d).expect.caseState = { missingFields: 'age' } }, 'doc.turns[0].expect.caseState.missingFields must be an array'],
  ['a mutation expectation that is not an object', (d) => { turnOf(d).expect.mutation = true }, 'doc.turns[0].expect.mutation must be an object'],
  ['a mutation member the contract does not define', (d) => { turnOf(d).expect.mutation = { appended: 1 } }, 'doc.turns[0].expect.mutation.appended is not a member'],
  ['a changed flag that is not boolean', (d) => { turnOf(d).expect.mutation = { changed: 'yes' } }, 'doc.turns[0].expect.mutation.changed must be a boolean'],
  ['a negative record count', (d) => { turnOf(d).expect.mutation = { eventCountDelta: -1 } }, 'doc.turns[0].expect.mutation.eventCountDelta must be a whole number'],
  ['an operation the domain does not record', (d) => { turnOf(d).expect.mutation = { operations: ['delete'] } }, 'doc.turns[0].expect.mutation.operations[0] must be one of'],
  ['operations that are not a list', (d) => { turnOf(d).expect.mutation = { operations: 'create' } }, 'doc.turns[0].expect.mutation.operations must be an array'],
]

describe('the golden-case contract', () => {
  it('refuses anything that is not a document', () => {
    for (const value of [null, 7, true, 'case', [], undefined]) {
      expect(() => parseGoldenCase(value, 'doc')).toThrow('doc must be an object')
    }
  })

  it.each(VIOLATIONS)('refuses %s', (_rule, mutate, message) => {
    const document = validCase()
    mutate(document)
    expect(() => parseGoldenCase(document, 'doc')).toThrow(message)
  })

  it('names the rejection as a contract error rather than a parse error', () => {
    expect(() => parseGoldenCase('case', 'doc')).toThrow(GoldenCaseError)
  })

  it('reads every member the contract defines', () => {
    const document = validCase()
    callOf(document).arguments = { symptoms: ['头疼'], age: 25 }
    turnOf(document).expect.caseState = {
      symptoms: ['头疼'],
      duration: '2 days',
      age: 25,
      additionalNotes: '餐后服用',
      revision: 2,
      missingFields: ['duration', 'age'],
    }
    turnOf(document).expect.mutation = { changed: true, eventCountDelta: 2, operations: ['create', 'update'] }

    expect(parseGoldenCase(document, 'doc')).toEqual({
      schemaVersion: 1,
      id: 'restatement',
      description: 'A minimal document that isolates one contract violation at a time.',
      turns: [{
        user: '我头疼',
        expect: {
          toolRouting: {
            kind: 'exact',
            calls: [{ name: 'medical_case_intake', arguments: { symptoms: ['头疼'], age: 25 } }],
          },
          caseState: {
            symptoms: ['头疼'],
            duration: '2 days',
            age: 25,
            additionalNotes: '餐后服用',
            revision: 2,
            missingFields: ['duration', 'age'],
          },
          mutation: { changed: true, eventCountDelta: 2, operations: ['create', 'update'] },
        },
      }],
    })
  })

  it('leaves an expectation out entirely when the document omits it', () => {
    const expectation = parseGoldenCase(validCase(), 'doc').turns[0]?.expect
    expect(expectation).not.toHaveProperty('caseState')
    expect(expectation).not.toHaveProperty('mutation')
  })

  it('leaves a member out when the document does not pin it', () => {
    const document = validCase()
    turnOf(document).expect.caseState = { symptoms: ['头疼'] }

    const state = parseGoldenCase(document, 'doc').turns[0]?.expect.caseState

    // What a document does not say is absent rather than null: a turn that does
    // not pin the revision must not be read as pinning it to nothing.
    expect(state).toEqual({ symptoms: ['头疼'] })
  })
})

describe('loading a roster', () => {
  it('reads the JSON documents in file-name order and ignores the rest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-golden-'))
    roots.push(directory)
    writeFileSync(join(directory, '002-second.json'), JSON.stringify({ ...validCase(), id: 'second' }))
    writeFileSync(join(directory, '001-first.json'), JSON.stringify({ ...validCase(), id: 'first' }))
    writeFileSync(join(directory, 'notes.md'), 'not a case')

    expect(loadGoldenCases(directory).map(golden => golden.id)).toEqual(['first', 'second'])
  })

  it('reads the shipped roster, whose ids are unique', () => {
    const cases = loadGoldenCases(ROSTER)
    expect(cases).toHaveLength(8)
    expect(new Set(cases.map(golden => golden.id)).size).toBe(8)
    expect(cases.every(golden => golden.schemaVersion === 1)).toBe(true)
  })

  it('names every file after the case it holds', () => {
    const files = readdirSync(ROSTER).filter(entry => entry.endsWith('.json'))
    for (const id of loadGoldenCases(ROSTER).map(golden => golden.id)) {
      const named = files.filter(entry => entry.endsWith(`${id}.json`))
      expect(named, `${id} has no document of its own`).toHaveLength(1)
    }
  })
})

describe('what the shipped roster is allowed to say', () => {
  const cases = loadGoldenCases(ROSTER)

  it('never routes outside the medical tool surface', () => {
    for (const golden of cases) {
      for (const turn of golden.turns) {
        for (const call of turn.expect.toolRouting.calls) {
          expect(MEDICAL_TOOLS, `${golden.id} must not route to ${call.name}`).toContain(call.name)
        }
      }
    }
  })

  it('states every case from a fresh session rather than assuming one', () => {
    for (const golden of cases) {
      const first = golden.turns[0]
      expect(first?.expect.caseState, `${golden.id} must state the case its own first turn records`).toBeDefined()
      expect(first?.expect.caseState?.revision, `${golden.id} must open the case at revision one`).toBe(1)
    }
  })

  it('gives every turn a non-empty utterance to replay', () => {
    for (const golden of cases) {
      for (const turn of golden.turns) {
        expect(turn.user.trim(), `${golden.id} has an empty utterance`).not.toBe('')
      }
    }
  })

  it('covers a single-turn and a multi-turn case, and both written verbs', () => {
    const operations = cases.flatMap(golden =>
      golden.turns.flatMap(turn => turn.expect.mutation?.operations ?? []))
    expect(cases.some(golden => golden.turns.length === 1)).toBe(true)
    expect(cases.some(golden => golden.turns.length > 1)).toBe(true)
    expect(operations).toContain('create')
    expect(operations).toContain('update')
  })
})
