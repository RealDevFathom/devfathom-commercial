import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule);

import { SopBoardView } from './sop-board';
import { CONFLICT_MESSAGE, errorMessage, recurrenceLabel } from './sop-model';
import { outOfRangeAdvice, recordOptionLabel } from './sop-record-picker';
import {
  BRANCH,
  due,
  evidenceRow,
  occurrence,
  OWNER_ACCESS,
  recordDetail,
  recordLink,
  REVIEWER_ACCESS,
  RunnerHarness,
  step,
} from './sop-test-harness';
import { mockState as h, refusal } from './sop-trpc-mock';

/**
 * DEV-751 — what a linked record says, stale-state recovery, and the smaller
 * plain-language fixes from the browser QA pass.
 */

beforeEach(() => h.reset());
afterEach(cleanup);

const EXCURSION = 'Record any excursion and the corrective action taken, or confirm none';

describe('linked records in the runner', () => {
  it('lists the picker’s records by label and state, never by code', () => {
    type Option = Parameters<typeof recordOptionLabel>[0];
    const option = (overrides: Record<string, unknown>) =>
      ({ detail: recordDetail(overrides) }) as unknown as Option;
    expect(
      recordOptionLabel(
        option({ label: 'Delivery GR-1042', statusLabel: 'Received', outOfRange: null })
      )
    ).toBe('Delivery GR-1042 · Received');
    expect(recordOptionLabel(option({ label: 'Vaccine fridge reading' }))).toBe(
      'Vaccine fridge reading · Out of range'
    );
    // A state that only repeats "out of range" is said once, capitalised like
    // the server's own states.
    expect(
      recordOptionLabel(option({ label: 'QA Fridge · 11.5 °C', statusLabel: 'Out of range' }))
    ).toBe('QA Fridge · 11.5 °C · Out of range');
    expect(
      recordOptionLabel(
        option({ label: 'QA Fridge · 5.0 °C', statusLabel: 'In range', outOfRange: false })
      )
    ).toBe('QA Fridge · 5.0 °C · In range');

    h.queries.occurrence = {
      data: occurrence({
        steps: [step({ title: 'Match the delivery', requiredRecordType: 'GOODS_RECEIPT' })],
      }),
    };
    h.queries.linkableRecords = {
      data: [
        {
          id: 'gr-1',
          recordType: 'GOODS_RECEIPT',
          occurredAt: due,
          detail: recordDetail({
            kind: 'GOODS_RECEIPT',
            label: 'Delivery GR-1042',
            statusLabel: 'Received',
            outOfRange: null,
          }),
        },
      ],
    };
    render(<RunnerHarness />);
    const select = screen.getByLabelText('goods receipt for Match the delivery', {
      selector: ':not([data-select-field-native][aria-hidden="true"])',
    });
    const options = within(selectFieldControl(select))
      .getAllByRole('option', { hidden: true })
      .map((option) => option.textContent);
    expect(options).toEqual(['Select…', 'Delivery GR-1042 · Received']);
    expect(select).not.toHaveTextContent(/RECEIVED|GOODS_RECEIPT/);
  });

  it('points an out-of-range reading at the step that records what was done', () => {
    h.queries.occurrence = {
      data: occurrence({
        steps: [
          step({ requiredRecordType: 'TEMPERATURE_LOG' }),
          step({
            id: 'step-3',
            templateStepId: 'tstep-3',
            stepOrder: 3,
            title: EXCURSION,
            requiresNote: true,
          }),
        ],
        recordLinks: [recordLink()],
      }),
    };
    h.queries.linkableRecords = { data: [] };
    render(<RunnerHarness />);
    expect(
      screen.getByText(
        `A linked reading is out of range. On step 3, “${EXCURSION}”, write what happened and what you did before sending this for review.`
      )
    ).toBeVisible();
    expect(screen.queryByText(/in the note before/)).not.toBeInTheDocument();
    // Without such a step, the reading's own step takes the note.
    expect(outOfRangeAdvice(null, 'Check the fridge')).toMatch(
      /in this step’s note before marking it done\./
    );
  });

  it('summarises a done step with each link’s detail and plain proof words', () => {
    h.queries.occurrence = {
      data: occurrence({
        status: 'SUBMITTED',
        steps: [
          step({
            requiresSignature: true,
            requiresPhoto: true,
            requiredRecordType: 'TEMPERATURE_LOG',
            completed: true,
            completedAt: due,
          }),
        ],
        evidence: [
          evidenceRow(),
          evidenceRow({ id: 'ev-2', mimeType: 'image/png; evidence=signature' }),
        ],
        recordLinks: [recordLink()],
      }),
    };
    render(<RunnerHarness />);
    expect(screen.getByText('1 photo · Signature added')).toBeVisible();
    expect(screen.queryByText(/signed/)).not.toBeInTheDocument();
    const links = screen.getByRole('list', { name: 'Linked records for step 1' });
    expect(links).toHaveTextContent('Vaccine fridge · 9.4 °C at 09:30');
    // Only when it was recorded is added below the label; value and place are not repeated.
    expect(within(links).getByText(/^Recorded /)).toHaveTextContent(
      /^Recorded Nov 4, 2026, 9:30\sAM$/
    );
    expect(links.textContent?.match(/Vaccine fridge/g)).toHaveLength(1);
    expect(links.textContent?.match(/9\.4 °C/g)).toHaveLength(1);
    expect(within(links).getByText('Out of range')).toBeVisible();
  });
});

describe('when the procedure changed underneath the person', () => {
  it('shows the server’s words after a review race and re-reads the procedure and board', () => {
    let state: Record<string, unknown> = occurrence({
      status: 'SUBMITTED',
      viewer: { isOwner: false, canClaim: false, canVerify: true },
      steps: [step({ completed: true, completedAt: due })],
    });
    h.queries.occurrence = () => ({ data: state });
    h.outcomes.verify = () => {
      // Someone else checked it first; the next read shows that.
      state = { ...state, status: 'VERIFIED' };
      return refusal('This procedure has already been checked.', 'CONFLICT');
    };
    const onBack = vi.fn();
    render(<RunnerHarness access={REVIEWER_ACCESS} from="review" onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark as checked' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This procedure has already been checked.');
    expect(h.invalidated).toEqual(
      expect.arrayContaining([
        ['occurrence', { pharmacyBranchId: BRANCH, occurrenceId: 'occ-1' }],
        ['board', { pharmacyBranchId: BRANCH }],
      ])
    );
    // The screen shows where it stands now, and nothing is left to decide.
    expect(screen.getByText('Checked')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark as checked' })).not.toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('re-reads after a refused send-back race, too', () => {
    h.queries.occurrence = {
      data: occurrence({
        status: 'SUBMITTED',
        viewer: { isOwner: false, canClaim: false, canVerify: true },
        steps: [step({ completed: true, completedAt: due })],
      }),
    };
    h.outcomes.reject = () => refusal('This procedure has already been sent back.', 'CONFLICT');
    render(<RunnerHarness access={REVIEWER_ACCESS} from="review" />);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Wrong reading' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This procedure has already been sent back.'
    );
    expect(h.invalidated.map(([name]) => name)).toEqual(['occurrence', 'board']);
  });

  it.each([
    ['start', 'Start', { status: 'SCHEDULED' }],
    ['submit', 'Send for review', { steps: [step({ completed: true, completedAt: due })] }],
  ])('handles a %s race the same way', (name, button, overrides) => {
    h.queries.occurrence = { data: occurrence(overrides) };
    h.outcomes[name] = () =>
      refusal('This procedure was changed. It now shows the latest.', 'CONFLICT');
    render(<RunnerHarness />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(screen.getByRole('alert')).toHaveTextContent('This procedure was changed.');
    expect(h.invalidated.map(([procedure]) => procedure)).toEqual(['occurrence', 'board']);
  });

  it('handles a step race, keeping the typed note', () => {
    h.queries.occurrence = { data: occurrence({ steps: [step({ requiresNote: true })] }) };
    h.outcomes.completeStep = () => refusal('status SUBMITTED: Expected IN_PROGRESS', 'CONFLICT');
    render(<RunnerHarness />);
    fireEvent.change(screen.getByLabelText(/Note · required/), {
      target: { value: 'Fridge 5 °C' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark step 1 done' }));
    // Raw engine text never reaches the screen.
    expect(screen.getByRole('alert')).toHaveTextContent(CONFLICT_MESSAGE);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/SUBMITTED|Expected/);
    expect(screen.getByLabelText(/Note · required/)).toHaveValue('Fridge 5 °C');
    expect(h.invalidated.map(([procedure]) => procedure)).toEqual(['occurrence', 'board']);
  });

  it('filters engine wording from any refusal', () => {
    const fallback = 'Plain fallback.';
    for (const raw of [
      'CONFLICT',
      'Occurrence is in status SUBMITTED',
      'Expected IN_PROGRESS but got SUBMITTED',
      'Cannot move from IN_PROGRESS',
    ]) {
      expect(errorMessage(new Error(raw), fallback)).toBe(fallback);
    }
    expect(errorMessage(new Error('This procedure has already been checked.'), fallback)).toBe(
      'This procedure has already been checked.'
    );
  });
});

describe('plain-language follow-ups', () => {
  it('tells the owner of a submitted procedure where it stands, without a dead button', () => {
    h.queries.occurrence = {
      data: occurrence({
        status: 'SUBMITTED',
        steps: [step({ completed: true, completedAt: due })],
      }),
    };
    render(<RunnerHarness access={OWNER_ACCESS} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sent for review. A reviewer will check it.'
    );
    expect(screen.queryByRole('button', { name: 'Send for review' })).not.toBeInTheDocument();
    expect(screen.queryByText(/You can send this/)).not.toBeInTheDocument();
  });

  it('falls back to an icon and an "Open file" link when a proof image will not load', () => {
    const ref = '/api/files/pharmacy-sop-1-abc.png';
    h.queries.occurrence = {
      data: occurrence({
        status: 'SUBMITTED',
        steps: [step({ requiresPhoto: true, completed: true, completedAt: due })],
        evidence: [evidenceRow()],
        auditTrail: [
          {
            id: 'ev-1',
            occurrenceId: 'occ-1',
            action: 'EVIDENCE_CAPTURED',
            at: new Date('2026-11-04T04:20:00Z'),
            actorStaffProfileId: 'sp',
            actorName: 'Asma',
            proofRef: { kind: 'EVIDENCE', evidenceId: 'ev-1', contentHash: 'h', storageRef: ref },
            claimRef: null,
            detail: null,
          },
        ],
      }),
    };
    render(<RunnerHarness />);
    const history = screen.getByRole('region', { name: 'History' });
    fireEvent.error(within(history).getByRole('img'));
    expect(within(history).queryByRole('img')).not.toBeInTheDocument();
    expect(within(history).getByText('Preview unavailable')).toBeVisible();
    const open = within(history).getByRole('link', {
      name: 'Open file: photo for Step 1 · Confirm the refrigerator temperature was recorded',
    });
    expect(open).toHaveTextContent('Open file');
    expect(open).toHaveAttribute('href', ref);
  });

  it('names a repeating check by its first and last time, in hours', () => {
    expect(
      recurrenceLabel({
        frequency: 'INTERVAL',
        interval: 240,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        dueTimeMinutes: 9 * 60,
        intervalEndTimeMinutes: 21 * 60,
      })
    ).toBe('Every 4 hours from 09:00 to 21:00');
    expect(
      recurrenceLabel({
        frequency: 'INTERVAL',
        interval: 90,
        daysOfWeek: [1, 3],
        dueTimeMinutes: 8 * 60,
        intervalEndTimeMinutes: 17 * 60,
      })
    ).toBe('Every 90 minutes from 08:00 to 17:00 on Mon, Wed');
    expect(
      recurrenceLabel({
        frequency: 'INTERVAL',
        interval: 60,
        daysOfWeek: [],
        dueTimeMinutes: null,
      })
    ).toBe('Every hour');
  });

  it('hides the "Awaiting review" figure from people who cannot review here', () => {
    const board = {
      businessDate: '2026-11-04',
      canReview: false,
      mine: [],
      pool: [],
      review: [],
      counts: { overdue: 1, dueToday: 2, awaitingReview: 3 },
    };
    h.queries.board = { data: board };
    h.queries.onDemandTemplates = { data: [] };
    const props = {
      pharmacyBranchId: BRANCH,
      timezone: 'Asia/Karachi',
      onOpen: vi.fn(),
      onSetup: vi.fn(),
      onNotice: vi.fn(),
    };
    const { unmount } = render(<SopBoardView {...props} access={OWNER_ACCESS} />);
    const today = screen.getByRole('region', { name: 'Today at this branch' });
    expect(today).toHaveTextContent('Overdue');
    expect(today).not.toHaveTextContent('Awaiting review');
    unmount();

    h.queries.board = { data: { ...board, canReview: true } };
    render(
      <SopBoardView
        {...props}
        access={{ ...OWNER_ACCESS, canVerify: true } as typeof OWNER_ACCESS}
      />
    );
    expect(screen.getByRole('region', { name: 'Today at this branch' })).toHaveTextContent(
      'Awaiting review'
    );
  });
});
