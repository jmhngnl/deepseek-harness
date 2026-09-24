/**
 * Evaluator coverage: one spec per rule the evaluator enforces, driven from
 * plain observations.
 *
 * The observations are built by hand rather than by running an agent, because
 * what is under test is the comparison, not the runtime. A rule that could only
 * be reached through a real model would be a rule nobody could regression-test,
 * which is the reason the evaluator is a pure function in the first place.
 */

import { describe, expect, it } from 'vitest'
import { CaseId } from '@deepseek-ai/dsh-medical-case'
import type { CaseView } from '@deepseek-ai/dsh-medical-case'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { evaluateCase, evaluateTurn } from '../src/index.ts'
import type {
  EvaluationResult,
  FailureType,
  GoldenCase,
  ObservedCaseEvent,
  ObservedToolCall,
  ObservedToolResult,
  ObservedTurn,
  ToolRoutingExpectation,
  TurnExpectation,
} from '../src/index.ts'

/** A case view with every field defaulted, so one test states one difference. */
function view(revision: number, patch: Partial<Omit<CaseView, 'revision'>> = {}): CaseView {
  return {
    caseId: CaseId('case-1'),
    revision,
    symptoms: ['头疼'],
    duration: null,
    age: null,
    additionalNotes: null,
    createdAt: 1,
    updatedAt: revision,
    missingFields: [],
    ...patch,
  }
}

/** One observed tool call whose arguments parsed. */
function callOf(name: string, args: JsonValue, seq = 1): ObservedToolCall {
  return {
    name,
    rawArguments: JSON.stringify(args),
    parsedArguments: args,
    eventSeq: seq,
    callId: `call-${String(seq)}`,
  }
}

/** One observed tool result. */
function resultOf(callId: string, isError: boolean, errorCode?: string, seq = 2): ObservedToolResult {
  return errorCode === undefined
    ? { callId, isError, eventSeq: seq }
    : { callId, isError, errorCode, eventSeq: seq }
}

/** One durable case record a turn appended. */
function caseEventOf(operation: 'create' | 'update', revision: number, seq = 3): ObservedCaseEvent {
  return { operation, revision, eventSeq: seq }
}

/** An observation with nothing observed, so one test states one difference. */
function observedTurn(patch: Partial<ObservedTurn> = {}): ObservedTurn {
  return {
    turnIndex: 0,
    user: '我头疼',
    toolCalls: [],
    toolResults: [],
    caseState: null,
    caseEvents: [],
    usage: null,
    timing: null,
    timedOut: false,
    runtimeError: null,
    ...patch,
  }
}

/** A turn expectation that routes through the given calls and asserts nothing else. */
function routing(calls: ToolRoutingExpectation['calls']): ToolRoutingExpectation {
  return { kind: 'exact', calls }
}

/** A turn expectation, defaulting to "the turn calls nothing". */
function expectation(patch: Partial<TurnExpectation> = {}): TurnExpectation {
  return { toolRouting: routing([]), ...patch }
}

/** A synthetic golden case built from one expectation per turn. */
function goldenCase(expectations: readonly TurnExpectation[], id = 'synthetic'): GoldenCase {
  return {
    schemaVersion: 1,
    id,
    description: 'A synthetic case used to pin one evaluation rule.',
    turns: expectations.map((expect, index) => ({ user: `提问 ${String(index + 1)}`, expect })),
  }
}

/** The failure types a result set produced, in order. */
function failures(results: readonly EvaluationResult[]): FailureType[] {
  return failed(results).flatMap(result => result.failureType === null ? [] : [result.failureType])
}

/** The assertions that failed. */
function failed(results: readonly EvaluationResult[]): EvaluationResult[] {
  return results.filter(result => result.failureType !== null)
}

/** The first result of an assertion set, which is the routing sequence. */
function first(results: readonly EvaluationResult[]): EvaluationResult {
  const [head] = results
  if (head === undefined) throw new Error('the expectation produced no assertion')
  return head
}

/** The single assertion a failing expectation produced. */
function onlyFailure(results: readonly EvaluationResult[]): EvaluationResult {
  const [head] = failed(results)
  if (head === undefined) throw new Error('the expectation produced no failure')
  return head
}

const INTAKE = callOf('medical_case_intake', { symptoms: ['头疼'] })

describe('a turn that satisfies its expectation', () => {
  it('passes every assertion the expectation called for', () => {
    const results = evaluateTurn(
      expectation({
        toolRouting: routing([{ name: 'medical_case_intake', arguments: { symptoms: ['头疼'] } }]),
        caseState: {
          symptoms: ['头疼'],
          duration: null,
          age: null,
          additionalNotes: null,
          revision: 1,
          missingFields: ['duration', 'age'],
        },
        mutation: { changed: true },
      }),
      observedTurn({
        toolCalls: [INTAKE],
        toolResults: [resultOf('call-1', false)],
        caseState: view(1, { missingFields: ['duration', 'age'] }),
        caseEvents: [caseEventOf('create', 1)],
      }),
    )

    expect(failures(results)).toEqual([])
    expect(results.map(result => result.kind)).toEqual([
      'toolRouting',
      'toolRouting',
      'caseState',
      'caseState',
      'caseState',
      'caseState',
      'caseState',
      'missingFields',
      'mutation',
    ])
    expect(first(results).detail).toBe('the turn called ["medical_case_intake"], matching the expectation')
    expect(results[1]?.detail).toBe('the pinned arguments matched')
    expect(first(results).evidence).toEqual({ toolCallSeqs: [1], toolResultSeqs: [2], caseEventSeqs: [3] })
  })

  it('asserts nothing about a case or a mutation the expectation does not mention', () => {
    const results = evaluateTurn(expectation(), observedTurn())

    expect(failures(results)).toEqual([])
    expect(results).toHaveLength(1)
    expect(first(results).kind).toBe('toolRouting')
  })
})

describe('tool routing', () => {
  it('reports a tool the turn never called', () => {
    const results = evaluateTurn(
      expectation({ toolRouting: routing([{ name: 'medical_case_intake' }]) }),
      observedTurn(),
    )

    expect(failures(results)).toEqual(['TOOL_NOT_CALLED'])
    expect(first(results).detail).toContain('the call at position 0 ("medical_case_intake") is missing')
  })

  it('reports a call the turn never reached', () => {
    const results = evaluateTurn(
      expectation({ toolRouting: routing([{ name: 'medical_case_intake' }, { name: 'medical_case_get' }]) }),
      observedTurn({ toolCalls: [INTAKE] }),
    )

    expect(failures(results)).toEqual(['TOOL_NOT_CALLED'])
  })

  it('reports the wrong tool at a position', () => {
    const results = evaluateTurn(
      expectation({ toolRouting: routing([{ name: 'medical_case_intake' }]) }),
      observedTurn({ toolCalls: [callOf('medical_case_update', { age: 25 })] }),
    )

    expect(failures(results)).toEqual(['WRONG_TOOL'])
    expect(first(results).expected).toEqual(['medical_case_intake'])
    expect(first(results).actual).toEqual(['medical_case_update'])
    expect(first(results).detail).toContain('the model called "medical_case_update"')
  })

  it('reports a call the expectation does not describe', () => {
    const results = evaluateTurn(
      expectation({ toolRouting: routing([{ name: 'medical_case_intake' }]) }),
      observedTurn({ toolCalls: [INTAKE, callOf('medical_case_get', {}, 4)] }),
    )

    expect(failures(results)).toEqual(['EXTRA_TOOL_CALL'])
    expect(first(results).detail).toContain('"medical_case_get" at position 1 is not expected')
  })

  it('reports an unexpected call on a turn that must call nothing', () => {
    const results = evaluateTurn(expectation(), observedTurn({ toolCalls: [INTAKE] }))

    expect(failures(results)).toEqual(['EXTRA_TOOL_CALL'])
  })

  it('judges arguments only where the call the expectation names was actually made', () => {
    const results = evaluateTurn(
      expectation({
        toolRouting: routing([
          { name: 'medical_case_intake', arguments: { symptoms: ['头疼'] } },
          { name: 'medical_case_get' },
        ]),
      }),
      observedTurn({ toolCalls: [INTAKE] }),
    )

    // The matched position is judged; the position the turn never reached is
    // already reported by the sequence assertion rather than twice.
    expect(results).toHaveLength(2)
    expect(failures(results)).toEqual(['TOOL_NOT_CALLED'])
  })

  it('does not judge arguments of a position the turn filled with another tool', () => {
    const results = evaluateTurn(
      expectation({ toolRouting: routing([{ name: 'medical_case_intake', arguments: { symptoms: ['头疼'] } }]) }),
      observedTurn({ toolCalls: [callOf('medical_case_update', { age: 25 })] }),
    )

    expect(results).toHaveLength(1)
    expect(failures(results)).toEqual(['WRONG_TOOL'])
  })
})

describe('tool arguments', () => {
  const pinned = routing([{ name: 'medical_case_update', arguments: { age: 25 } }])

  it('reports arguments that never parsed', () => {
    const malformed: ObservedToolCall = {
      name: 'medical_case_update',
      rawArguments: '{',
      argumentParseError: 'tool arguments are not valid JSON',
      eventSeq: 1,
      callId: 'call-1',
    }
    const results = evaluateTurn(
      expectation({ toolRouting: pinned }),
      observedTurn({ toolCalls: [malformed] }),
    )

    expect(failures(results)).toEqual(['ARGUMENT_EXTRACTION_ERROR'])
    expect(onlyFailure(results).detail).toBe('tool arguments are not valid JSON')
    expect(onlyFailure(results).actual).toBe('{')
  })

  it('reports arguments that parsed into something other than an object', () => {
    for (const value of ['头疼', null, ['头疼']]) {
      const results = evaluateTurn(
        expectation({ toolRouting: pinned }),
        observedTurn({ toolCalls: [callOf('medical_case_update', value)] }),
      )
      expect(failures(results), JSON.stringify(value)).toEqual(['ARGUMENT_EXTRACTION_ERROR'])
      expect(onlyFailure(results).detail).toContain('must be a JSON object')
    }
  })

  it('reports an argument the expectation pinned but the call did not carry', () => {
    const results = evaluateTurn(
      expectation({ toolRouting: pinned }),
      observedTurn({ toolCalls: [callOf('medical_case_update', { duration: '两天' })] }),
    )

    expect(failures(results)).toEqual(['ARGUMENT_EXTRACTION_ERROR'])
    expect(onlyFailure(results).detail).toContain('["age"] did not match')
  })

  it('ignores arguments the expectation does not pin', () => {
    const results = evaluateTurn(
      expectation({ toolRouting: pinned }),
      observedTurn({ toolCalls: [callOf('medical_case_update', { age: 25, additionalNotes: '餐后服用' })] }),
    )

    expect(failures(results)).toEqual([])
  })
})

describe('tool results', () => {
  it('reports a tool that failed, with and without a published code', () => {
    const results = evaluateTurn(
      expectation(),
      observedTurn({
        toolResults: [resultOf('call-1', true, 'CASE_INVALID_SYMPTOMS'), resultOf('call-2', true, undefined, 5)],
      }),
    )

    expect(failures(results)).toEqual(['TOOL_ERROR', 'TOOL_ERROR'])
    expect(failed(results)[0]?.detail).toBe('the tool reported CASE_INVALID_SYMPTOMS')
    expect(failed(results)[0]?.actual).toBe('CASE_INVALID_SYMPTOMS')
    expect(failed(results)[1]?.detail).toBe('the tool reported a failed result')
    expect(failed(results)[1]?.actual).toBe('a failed result')
  })

  it('does not report a tool that succeeded', () => {
    const results = evaluateTurn(expectation(), observedTurn({ toolResults: [resultOf('call-1', false)] }))

    expect(failures(results)).toEqual([])
    expect(results).toHaveLength(1)
  })
})

describe('case state', () => {
  it('reports a case the expectation describes but the session never recorded', () => {
    const results = evaluateTurn(expectation({ caseState: { symptoms: ['头疼'] } }), observedTurn())

    expect(failures(results)).toEqual(['CASE_STATE_MISMATCH'])
    expect(onlyFailure(results).assertion).toBe('case presence')
    expect(onlyFailure(results).actual).toBeNull()
  })

  it('reports the field that differs, one assertion per pinned field', () => {
    const results = evaluateTurn(
      expectation({
        caseState: {
          symptoms: ['头疼', '发烧'],
          duration: '两天',
          age: 26,
          additionalNotes: '餐后服用',
        },
      }),
      observedTurn({
        caseState: view(1, { symptoms: ['头疼'], duration: '三天', age: 25, additionalNotes: null }),
      }),
    )

    expect(results.map(result => result.assertion)).toEqual([
      'tool call sequence',
      'symptoms',
      'duration',
      'age',
      'additionalNotes',
    ])
    expect(failures(results)).toEqual([
      'CASE_STATE_MISMATCH',
      'CASE_STATE_MISMATCH',
      'CASE_STATE_MISMATCH',
      'CASE_STATE_MISMATCH',
    ])
    expect(failed(results)[0]?.detail).toContain('the case holds ["头疼"]')
  })

  it('reports a revision the turn did not reach', () => {
    const results = evaluateTurn(expectation({ caseState: { revision: 1 } }), observedTurn({ caseState: view(2) }))

    expect(failures(results)).toEqual(['REVISION_MISMATCH'])
    expect(onlyFailure(results).expected).toBe(1)
    expect(onlyFailure(results).actual).toBe(2)
  })

  it('reports a gap report that disagrees with the expectation', () => {
    const results = evaluateTurn(
      expectation({ caseState: { missingFields: ['duration', 'age'] } }),
      observedTurn({ caseState: view(1, { missingFields: ['duration'] }) }),
    )

    expect(failures(results)).toEqual(['MISSING_FIELDS_MISMATCH'])
    expect(onlyFailure(results).kind).toBe('missingFields')
  })
})

describe('durable mutation', () => {
  it('reports a change the turn never made', () => {
    const results = evaluateTurn(expectation({ mutation: { changed: true } }), observedTurn())

    expect(failures(results)).toEqual(['EXPECTED_MUTATION_MISSING'])
  })

  it('reports a change the expectation forbade', () => {
    const unchanged = evaluateTurn(
      expectation({ mutation: { changed: false } }),
      observedTurn({ caseEvents: [caseEventOf('update', 2)] }),
    )
    const noDelta = evaluateTurn(
      expectation({ mutation: { eventCountDelta: 0 } }),
      observedTurn({ caseEvents: [caseEventOf('update', 2)] }),
    )

    expect(failures(unchanged)).toEqual(['UNEXPECTED_CASE_MUTATION'])
    expect(failures(noDelta)).toEqual(['UNEXPECTED_CASE_MUTATION'])
    expect(onlyFailure(noDelta).expected).toBe(0)
    expect(onlyFailure(noDelta).actual).toBe(1)
  })

  it('reports fewer records than the expectation requires', () => {
    const results = evaluateTurn(
      expectation({ mutation: { eventCountDelta: 2 } }),
      observedTurn({ caseEvents: [caseEventOf('update', 2)] }),
    )

    expect(failures(results)).toEqual(['EXPECTED_MUTATION_MISSING'])
  })

  it('reports the operations the turn wrote against the ones expected', () => {
    const wrong = evaluateTurn(
      expectation({ mutation: { operations: ['update'] } }),
      observedTurn({ caseEvents: [caseEventOf('create', 1)] }),
    )
    const short = evaluateTurn(
      expectation({ mutation: { operations: ['create', 'update'] } }),
      observedTurn({ caseEvents: [caseEventOf('create', 1)] }),
    )

    // Same number of records, a different record: a count alone would pass this.
    expect(failures(wrong)).toEqual(['UNEXPECTED_CASE_MUTATION'])
    expect(onlyFailure(wrong).expected).toEqual(['update'])
    expect(onlyFailure(wrong).actual).toEqual(['create'])
    expect(failures(short)).toEqual(['EXPECTED_MUTATION_MISSING'])
  })

  it('passes a mutation that matches', () => {
    const results = evaluateTurn(
      expectation({ mutation: { changed: true, eventCountDelta: 1, operations: ['create'] } }),
      observedTurn({ caseEvents: [caseEventOf('create', 1)] }),
    )

    expect(failures(results)).toEqual([])
    expect(results.filter(result => result.kind === 'mutation').map(result => result.detail)).toEqual([
      'durable change matched',
      'case records appended matched',
      'operations matched',
    ])
  })
})

describe('a turn that did not finish', () => {
  it('reports a turn that never reached quiescence, and judges nothing else', () => {
    const results = evaluateTurn(
      expectation({
        toolRouting: routing([{ name: 'medical_case_intake' }]),
        caseState: { revision: 1 },
        mutation: { changed: true },
      }),
      observedTurn({ timedOut: true }),
    )

    expect(failures(results)).toEqual(['SESSION_TIMEOUT'])
    expect(first(results).actual).toBe('a turn that never settled')
  })

  it('reports a runtime fault, and judges nothing else', () => {
    const results = evaluateTurn(
      expectation({
        toolRouting: routing([{ name: 'medical_case_intake' }]),
        caseState: { revision: 1 },
      }),
      observedTurn({ runtimeError: { name: 'REQUEST_FAILED', message: 'the provider refused the request' } }),
    )

    expect(failures(results)).toEqual(['RUNTIME_ERROR'])
    expect(first(results).actual).toBe('a turn that failed')
    expect(first(results).detail).toContain('REQUEST_FAILED: the provider refused the request')
  })
})

describe('invariants across a case', () => {
  it('reports a revision that changed the case identity', () => {
    const evaluation = evaluateCase({
      golden: goldenCase([expectation(), expectation()]),
      observed: [
        observedTurn({ turnIndex: 0, caseState: view(1) }),
        observedTurn({ turnIndex: 1, caseState: view(2, { caseId: CaseId('case-2') }) }),
      ],
      sessionId: 'session-1',
    })

    expect(evaluation.passed).toBe(false)
    expect(evaluation.failures.map(failure => failure.failureType)).toEqual(['CASE_ID_CHANGED'])
    expect(evaluation.failures[0]?.assertion).toBe('case identity')
    expect(evaluation.failures[0]?.turnIndex).toBe(1)
    expect(evaluation.failures[0]?.sessionId).toBe('session-1')
    expect(evaluation.failures[0]?.goldenCaseId).toBe('synthetic')
    expect(evaluation.turns[1]?.results).toHaveLength(2)
  })

  it('reports a mutation clock that stepped backwards', () => {
    const evaluation = evaluateCase({
      golden: goldenCase([expectation(), expectation()]),
      observed: [
        observedTurn({ turnIndex: 0, caseState: view(1, { updatedAt: 500 }) }),
        observedTurn({ turnIndex: 1, caseState: view(2, { updatedAt: 400 }) }),
      ],
      sessionId: 'session-1',
    })

    expect(evaluation.failures.map(failure => failure.failureType)).toEqual(['CASE_STATE_MISMATCH'])
    expect(evaluation.failures[0]?.assertion).toBe('mutation clock')
  })

  it('passes revisions that kept their identity and moved forward', () => {
    const evaluation = evaluateCase({
      golden: goldenCase([expectation(), expectation()]),
      observed: [
        observedTurn({ turnIndex: 0, caseState: view(1) }),
        observedTurn({ turnIndex: 1, caseState: view(2) }),
      ],
      sessionId: 'session-1',
    })

    expect(evaluation.passed).toBe(true)
    expect(evaluation.failures).toEqual([])
    expect(evaluation.turns.map(turn => turn.passed)).toEqual([true, true])
  })

  it('has no continuity to assert before a case is recorded', () => {
    const evaluation = evaluateCase({
      golden: goldenCase([expectation(), expectation()]),
      observed: [observedTurn({ turnIndex: 0 }), observedTurn({ turnIndex: 1 })],
      sessionId: 'session-1',
    })

    expect(evaluation.passed).toBe(true)
  })
})

describe('assembling a case evaluation', () => {
  it('reports a turn the runner never observed', () => {
    const evaluation = evaluateCase({
      golden: goldenCase([expectation(), expectation()], 'never-observed'),
      observed: [observedTurn({ turnIndex: 0 })],
      sessionId: 'session-1',
    })

    expect(evaluation.passed).toBe(false)
    expect(evaluation.failures.map(failure => failure.failureType)).toEqual(['RUNTIME_ERROR'])
    expect(evaluation.failures[0]?.turnIndex).toBe(1)
    expect(evaluation.failures[0]?.detail).toContain('no observation')
    expect(evaluation.turns[1]?.toolCalls).toEqual([])
    expect(evaluation.turns[1]?.usage).toBeNull()
  })

  it('reports an observation that does not belong at its position', () => {
    const evaluation = evaluateCase({
      golden: goldenCase([expectation()], 'misplaced'),
      observed: [observedTurn({ turnIndex: 4 })],
      sessionId: 'session-1',
    })

    expect(evaluation.passed).toBe(false)
    expect(evaluation.failures[0]?.failureType).toBe('RUNTIME_ERROR')
    expect(evaluation.failures[0]?.detail).toContain('reports turn 4')
  })

  it('carries each turn tool calls, usage, and resulting case onto its evaluation', () => {
    const evaluation = evaluateCase({
      golden: goldenCase([expectation({ toolRouting: routing([{ name: 'medical_case_get' }]) })], 'reported'),
      observed: [observedTurn({
        toolCalls: [callOf('medical_case_get', {})],
        caseState: view(1),
        usage: { inputTokens: 12, outputTokens: 3 },
      })],
      sessionId: 'session-1',
    })

    expect(evaluation.id).toBe('reported')
    expect(evaluation.turns[0]?.toolCalls).toEqual(['medical_case_get'])
    expect(evaluation.turns[0]?.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
    expect(evaluation.turns[0]?.caseState?.revision).toBe(1)
  })
})
