// @vitest-environment jsdom
/**
 * Product coverage for the intake surface: what a person actually sees after
 * they describe a symptom, answer a follow-up, attach a photo, or reload.
 *
 * The components are pure renderers over finished projection values, so these
 * cases drive them with the exact values the host publishes and assert the
 * rendered text. They are the product half of the guarantee: the host tests
 * prove the projections are right, and these prove the page shows them without
 * adding, merging, or inventing anything.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { MedicalCaseWireView } from '@deepseek-ai/dsh-medical-case/client'
import type { MedicalImageWireView } from '@deepseek-ai/dsh-medical-image/client'
import { ImageObservations } from '../src/client/ImageObservations.tsx'
import { PatientReport } from '../src/client/PatientReport.tsx'
import { MedharnessIntake } from '../src/client/MedharnessIntake.tsx'
import type { MedharnessIntakeProps } from '../src/client/MedharnessIntake.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)

// The column seat is framework-injected and never touched here, so one
// documented cast keeps the harness to the props these cases exercise.
const seat = {} as unknown as MedharnessIntakeProps

// The suite runs without globals, so testing-library's automatic cleanup is not
// installed: without this, every render stays in the document and a role query
// counts the previous case's rows too.
afterEach(cleanup)

// The suite runs without globals, so testing-library's automatic cleanup is not
// installed: without this, every render stays in the document and a role query
// counts the previous case's rows too.
afterEach(cleanup)

/** The case value the host publishes after the first turn of the example flow. */
const AFTER_FIRST_ANSWER: MedicalCaseWireView = {
  caseId: 'case-1' as MedicalCaseWireView['caseId'],
  revision: 1,
  symptoms: ['头疼'],
  duration: null,
  age: null,
  additionalNotes: null,
  missingFields: ['duration', 'age'],
  updatedAt: 1_700_000_000_000,
}

/** The same case after the follow-up supplied the two missing facts. */
const AFTER_FOLLOW_UP: MedicalCaseWireView = {
  ...AFTER_FIRST_ANSWER,
  revision: 2,
  duration: '两天',
  age: 25,
  missingFields: [],
  updatedAt: 1_700_000_100_000,
}

/** One observation of one attached image. */
const OBSERVED: MedicalImageWireView = {
  observations: [{
    attachmentId: 'sha256:aaaa',
    displayName: 'photo.png',
    mediaType: 'image/png',
    revision: 1,
    bodyRegion: '前臂',
    findings: ['红色斑块'],
    usable: true,
    qualityIssues: ['blur'],
    uncertainty: ['无法判断深度'],
    updatedAt: 1_700_000_200_000,
  }],
}

/** The body's projection stub: a fixed value per key, exactly as the host sends it. */
function useProjectionOf(values: Record<string, unknown>) {
  return (key: string) => values[key]
}

describe('patient report', () => {
  it('shows the recorded facts and marks the facts still missing', () => {
    render(<PatientReport view={AFTER_FIRST_ANSWER} t={t} />)

    const panel = screen.getByTestId('patient-report')
    expect(within(panel).getByText('头疼')).toBeTruthy()
    expect(within(panel).getByText('记录版本 1')).toBeTruthy()
    // The two unanswered required facts are marked as still needed, and the
    // value cells say "not provided" rather than showing an empty row.
    const marks = (): (string | null)[] => within(panel).getAllByRole('listitem').map(item => item.textContent)
    expect(marks().filter(text => text?.startsWith('○'))).toHaveLength(2)
    expect(marks().filter(text => text?.startsWith('✓'))).toHaveLength(1)
  })

  it('drives completeness from the host gap report, never from its own arithmetic', () => {
    const { rerender } = render(<PatientReport view={AFTER_FIRST_ANSWER} t={t} />)
    const marks = (): (string | null)[] => screen.getAllByRole('listitem').map(item => item.textContent)
    expect(marks().filter(text => text?.startsWith('○'))).toHaveLength(2)

    rerender(<PatientReport view={AFTER_FOLLOW_UP} t={t} />)
    expect(marks().filter(text => text?.startsWith('○'))).toHaveLength(0)
    expect(marks().filter(text => text?.startsWith('✓'))).toHaveLength(3)
    expect(screen.getByTestId('patient-report').textContent).toContain('必填信息已齐备')
  })

  it('keeps the revision a no-op did not move', () => {
    // A restatement publishes the same revision; the page must not imply growth.
    render(<PatientReport view={AFTER_FIRST_ANSWER} t={t} />)
    const text = screen.getByTestId('patient-report').textContent ?? ''
    expect(text).toContain('记录版本 1')
    expect(text).not.toContain('记录版本 2')
  })

  it('says so plainly before anything is recorded', () => {
    render(<PatientReport view={null} t={t} />)
    expect(screen.getByTestId('patient-report').textContent).toContain('还没有记录')
  })
})

describe('image observations', () => {
  it('shows what the model saw, with the limits it stated', () => {
    render(<ImageObservations view={OBSERVED} t={t} />)

    const card = screen.getByTestId('image-observation')
    expect(within(card).getByText('photo.png')).toBeTruthy()
    expect(within(card).getByText('版本 1')).toBeTruthy()
    expect(within(card).getByText('前臂')).toBeTruthy()
    expect(within(card).getByText('红色斑块')).toBeTruthy()
    expect(within(card).getByText('blur')).toBeTruthy()
    expect(within(card).getByText('无法判断深度')).toBeTruthy()
  })

  it('reports an unusable image as a result rather than hiding it', () => {
    const unusable: MedicalImageWireView = {
      observations: [{ ...OBSERVED.observations[0]!, usable: false, qualityIssues: ['unable_to_assess'] }],
    }
    render(<ImageObservations view={unusable} t={t} />)
    expect(screen.getByText('无法可靠评估')).toBeTruthy()
  })

  it('shows nothing for an attachment that was refused', () => {
    // A refused identifier appends no domain event, so the host publishes an
    // empty list and the page must not fabricate a card for the attempt.
    render(<ImageObservations view={{ observations: [] }} t={t} />)
    expect(screen.queryByTestId('image-observation')).toBeNull()
    expect(screen.getByTestId('image-observations').textContent).toContain('还没有图像观察')
  })

  it('falls back to a positional label when the attachment carried no name', () => {
    const unnamed: MedicalImageWireView = {
      observations: [{ ...OBSERVED.observations[0]!, displayName: null }],
    }
    render(<ImageObservations view={unnamed} t={t} />)
    expect(screen.getByText('图片 1')).toBeTruthy()
  })
})

describe('the intake surface', () => {
  it('keeps the two kinds of evidence in separate, labelled panels', () => {
    render(<MedharnessIntake
      {...seat}
      useProjection={useProjectionOf({ medicalCase: AFTER_FOLLOW_UP, medicalImage: OBSERVED })}
      t={t}
    />)

    const reported = document.querySelector('[data-evidence="patient-reported"]')
    const observed = document.querySelector('[data-evidence="model-observed"]')
    expect(reported).not.toBeNull()
    expect(observed).not.toBeNull()

    // The patient's own words appear only under the patient panel, and what the
    // model saw only under the observation panel: one merged list would destroy
    // the distinction the two panels exist to draw.
    expect(within(reported as HTMLElement).getByText('头疼')).toBeTruthy()
    expect(within(reported as HTMLElement).queryByText('红色斑块')).toBeNull()
    expect(within(observed as HTMLElement).getByText('红色斑块')).toBeTruthy()
    expect(within(observed as HTMLElement).queryByText('头疼')).toBeNull()
  })

  it('renders the same state a reload would, because both values are projections', () => {
    const values = { medicalCase: AFTER_FOLLOW_UP, medicalImage: OBSERVED }
    const first = render(<MedharnessIntake {...seat} useProjection={useProjectionOf(values)} t={t} />)
    const firstText = first.container.textContent
    first.unmount()

    // Re-mounting with the value the host re-publishes on resume is the reload
    // path: nothing is kept in component state, so the page is a pure function
    // of the projections.
    const second = render(<MedharnessIntake {...seat} useProjection={useProjectionOf(values)} t={t} />)
    expect(second.container.textContent).toBe(firstText)
  })

  it('renders an empty intake without inventing evidence', () => {
    render(<MedharnessIntake
      {...seat}
      useProjection={useProjectionOf({ medicalCase: null, medicalImage: { observations: [] } })}
      t={t}
    />)
    expect(screen.getByTestId('patient-report').textContent).toContain('还没有记录')
    expect(screen.getByTestId('image-observations').textContent).toContain('还没有图像观察')
  })

  it('shows a plain loading line while a projection value has not arrived', () => {
    render(<MedharnessIntake {...seat} useProjection={useProjectionOf({})} t={t} />)
    expect(screen.getAllByText('正在读取…')).toHaveLength(2)
  })
})
