import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule);

import { submitBlockers, type SopOccurrence } from './sop-model';
import { historyEntries, REWORK_GUIDANCE } from './sop-runner';
import {
  BRANCH,
  evidenceRow,
  occurrence,
  REASON,
  recordDetail,
  recordLink,
  REVIEWER_ACCESS,
  reworkOccurrence,
  RunnerHarness,
  sentBackAt,
  step,
} from './sop-test-harness';
import { mockState as h } from './sop-trpc-mock';

/**
 * DEV-751 — after a send-back the reviewer's reason sits where the person acts
 * on it, every done step takes new proof, another record and a note, and the
 * procedure cannot go back for review until a note says what changed. The
 * reviewer then sees that reason, the notes and what each linked record says.
 */

function given(occ: Record<string, unknown>) {
  h.queries.occurrence = { data: occ };
  h.queries.linkableRecords = {
    data: [
      {
        id: 'temp-2',
        recordType: 'TEMPERATURE_LOG',
        occurredAt: new Date('2026-11-04T05:30:00Z'),
        detail: recordDetail({
          label: 'Vaccine fridge · 5.1 °C at 10:30',
          value: '5.1 °C',
          outOfRange: false,
        }),
      },
    ],
  };
}

beforeEach(() => h.reset());
afterEach(cleanup);

describe('a sent-back procedure, before starting again', () => {
  it('shows the reviewer’s reason beside "Start again", not only in History', () => {
    given(
      reworkOccurrence({
        status: 'REJECTED',
        rework: {
          latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
          notes: [],
        },
      })
    );
    render(<RunnerHarness />);
    const notice = screen.getByRole('region', { name: 'Why it was sent back' });
    expect(notice).toHaveTextContent('Sent back by Bilal');
    expect(notice).toHaveTextContent(REASON);
    expect(notice).toHaveTextContent(/Steps you already did stay done/);
    // The reason comes before the action that answers it.
    const start = screen.getByRole('button', { name: 'Start again' });
    expect(notice.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(start);
    expect(h.calls.start).toEqual([{ pharmacyBranchId: BRANCH, occurrenceId: 'occ-1' }]);
  });

  it('falls back to the review trail for the reason when the summary has none', () => {
    given(reworkOccurrence({ status: 'REJECTED', rework: undefined }));
    render(<RunnerHarness />);
    expect(screen.getByRole('region', { name: 'Why it was sent back' })).toHaveTextContent(REASON);
  });
});

describe('reworking a sent-back procedure', () => {
  it('says plainly that steps stay done, by the step list', () => {
    given(reworkOccurrence());
    render(<RunnerHarness />);
    const steps = screen.getByRole('region', { name: 'Steps' });
    const notice = within(steps).getByRole('region', { name: 'Why it was sent back' });
    expect(notice).toHaveTextContent(REASON);
    expect(notice).toHaveTextContent('Steps stay done; add what you changed.');
    expect(REWORK_GUIDANCE).not.toMatch(/block|status|IN_PROGRESS/);
    // Steps stay done; nothing offers to mark them again.
    expect(screen.queryByRole('button', { name: /Mark step \d done/ })).not.toBeInTheDocument();
  });

  it('offers new proof, another record and a note on every done step', () => {
    given(reworkOccurrence());
    render(<RunnerHarness />);
    const toggle = screen.getByRole('button', { name: 'Add a change to step 1' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Add a change to step 2' })).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // New photo proof on a done step that never needed one: optional, not "required".
    const photo = screen.getByLabelText(
      'Photo for Confirm the refrigerator temperature was recorded'
    );
    expect(photo).toHaveAttribute('type', 'file');
    expect(screen.getByText('Photo · optional')).toBeVisible();

    // Another record, offered in plain words.
    expect(screen.getByText('Link another temperature log')).toBeVisible();
    const picker = screen.getByLabelText(
      'temperature log for Confirm the refrigerator temperature was recorded'
    );
    fireEvent.change(picker, { target: { value: 'temp-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link record' }));
    expect(h.calls.linkRecord).toEqual([
      expect.objectContaining({ occurrenceStepId: 'step-1', recordId: 'temp-2' }),
    ]);

    // A note for this step.
    const save = screen.getByRole('button', { name: 'Save note for step 1' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What you changed on this step'), {
      target: { value: '  Linked this morning’s reading.  ' },
    });
    fireEvent.click(save);
    expect(h.calls.addReworkNote).toEqual([
      {
        pharmacyBranchId: BRANCH,
        occurrenceId: 'occ-1',
        occurrenceStepId: 'step-1',
        note: 'Linked this morning’s reading.',
      },
    ]);
    expect(screen.getAllByText('Note saved.')).toHaveLength(1);
  });

  it('asks what changed overall, and saves it without a step', () => {
    given(reworkOccurrence());
    render(<RunnerHarness />);
    const section = screen.getByRole('region', { name: 'What did you change?' });
    fireEvent.change(within(section).getByLabelText('Your note'), {
      target: { value: 'Replaced the reading with today’s.' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    expect(h.calls.addReworkNote).toEqual([
      {
        pharmacyBranchId: BRANCH,
        occurrenceId: 'occ-1',
        note: 'Replaced the reading with today’s.',
      },
    ]);
    expect(within(section).getByText('Note saved.')).toBeVisible();
  });

  it('lists the missing rework note as the reason it cannot go for review', () => {
    given(reworkOccurrence());
    render(<RunnerHarness />);
    expect(screen.getByRole('list', { name: 'What is still needed' })).toHaveTextContent(
      'Say what you changed after it was sent back.'
    );
    expect(screen.getByRole('button', { name: 'Send for review' })).toBeDisabled();
  });

  it('can go for review once a note after the send-back says what changed', () => {
    given(
      reworkOccurrence({
        rework: {
          latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
          notes: [
            {
              id: 'note-old',
              occurrenceStepId: null,
              note: 'From an earlier round.',
              createdAt: new Date('2026-11-03T05:00:00Z'),
              authorName: 'Asma',
              afterLatestRejection: false,
            },
          ],
        },
      })
    );
    const { unmount } = render(<RunnerHarness />);
    // A note from before this send-back does not answer it.
    expect(screen.getByRole('button', { name: 'Send for review' })).toBeDisabled();
    unmount();

    given(
      reworkOccurrence({
        rework: {
          latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
          notes: [
            {
              id: 'note-1',
              occurrenceStepId: 'step-1',
              note: 'Linked this morning’s reading.',
              createdAt: new Date('2026-11-04T06:00:00Z'),
              authorName: 'Asma',
              afterLatestRejection: true,
            },
          ],
        },
      })
    );
    render(<RunnerHarness />);
    expect(screen.queryByRole('list', { name: 'What is still needed' })).not.toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send for review' });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(h.calls.submit).toEqual([{ pharmacyBranchId: BRANCH, occurrenceId: 'occ-1' }]);
  });

  it('shows what is new since the send-back on the step', () => {
    given(
      reworkOccurrence({
        evidence: [
          evidenceRow({ id: 'ev-old' }),
          evidenceRow({ id: 'ev-new', createdAfterLatestRejection: true }),
        ],
        recordLinks: [
          recordLink(),
          recordLink({
            id: 'link-2',
            recordId: 'temp-2',
            detail: recordDetail({ value: '5.1 °C', outOfRange: false }),
            createdAfterLatestRejection: true,
          }),
        ],
        rework: {
          latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
          notes: [
            {
              id: 'note-1',
              occurrenceStepId: 'step-1',
              note: 'Linked this morning’s reading.',
              createdAt: new Date('2026-11-04T06:00:00Z'),
              authorName: 'Asma',
              afterLatestRejection: true,
            },
          ],
        },
      })
    );
    render(<RunnerHarness />);
    const links = screen.getByRole('list', { name: 'Linked records for step 1' });
    const [first, second] = within(links).getAllByRole('listitem');
    expect(first).not.toHaveTextContent('New since sent back');
    expect(second).toHaveTextContent('New since sent back');
    expect(screen.getByText('2 photos').parentElement).toHaveTextContent('New since sent back');
    const notes = screen.getByRole('list', { name: 'What changed on step 1' });
    expect(notes).toHaveTextContent('Linked this morning’s reading.');
    expect(notes).toHaveTextContent('New since sent back');
  });

  it('asks what happened before linking an out-of-range reading to a done step without an excursion step', () => {
    given(
      reworkOccurrence({
        steps: [
          step({ requiredRecordType: 'TEMPERATURE_LOG', completed: true, completedByName: 'Asma' }),
          step({
            id: 'step-2',
            templateStepId: 'tstep-2',
            stepOrder: 2,
            title: 'Open the counter',
            completed: true,
            completedByName: 'Asma',
          }),
        ],
      })
    );
    h.queries.linkableRecords = {
      data: [
        {
          id: 'temp-hot',
          recordType: 'TEMPERATURE_LOG',
          occurredAt: new Date('2026-11-04T05:30:00Z'),
          detail: recordDetail({ label: 'Vaccine fridge · 9.4 °C', outOfRange: true }),
        },
        {
          id: 'temp-ok',
          recordType: 'TEMPERATURE_LOG',
          occurredAt: new Date('2026-11-04T05:40:00Z'),
          detail: recordDetail({ label: 'Vaccine fridge · 5.0 °C', outOfRange: false }),
        },
      ],
    };
    render(<RunnerHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a change to step 1' }));
    const picker = screen.getByLabelText(
      'temperature log for Confirm the refrigerator temperature was recorded'
    );
    const noteLabel = /What happened and what you did · required/;

    // An in-range reading links as before, with no note.
    fireEvent.change(picker, { target: { value: 'temp-ok' } });
    expect(screen.queryByLabelText(noteLabel)).not.toBeInTheDocument();

    // An out-of-range one needs the note first, then carries it.
    fireEvent.change(picker, { target: { value: 'temp-hot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link record' }));
    expect(h.calls.linkRecord ?? []).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This reading is out of range. Write what happened and what you did.'
    );
    fireEvent.change(screen.getByLabelText(noteLabel), {
      target: { value: '  Door left open; moved stock.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link record' }));
    expect(h.calls.linkRecord).toEqual([
      expect.objectContaining({ recordId: 'temp-hot', note: 'Door left open; moved stock.' }),
    ]);
  });

  it('needs no link note when the procedure records excursions on their own step', () => {
    given(reworkOccurrence());
    h.queries.linkableRecords = {
      data: [
        {
          id: 'temp-hot',
          recordType: 'TEMPERATURE_LOG',
          occurredAt: new Date('2026-11-04T05:30:00Z'),
          detail: recordDetail({ label: 'Vaccine fridge · 9.4 °C', outOfRange: true }),
        },
      ],
    };
    render(<RunnerHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a change to step 1' }));
    fireEvent.change(
      screen.getByLabelText(
        'temperature log for Confirm the refrigerator temperature was recorded'
      ),
      { target: { value: 'temp-hot' } }
    );
    expect(screen.queryByLabelText(/What happened and what you did/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Link record' }));
    expect(h.calls.linkRecord).toEqual([expect.not.objectContaining({ note: expect.anything() })]);
  });

  it('adds the rework note blocker only while reworking', () => {
    const plain = occurrence({ steps: [] }) as unknown as SopOccurrence;
    expect(submitBlockers(plain)).toEqual([]);
    const rework = reworkOccurrence() as unknown as SopOccurrence;
    expect(submitBlockers(rework)).toEqual(['Say what you changed after it was sent back.']);
  });
});

describe('the reviewer of a reworked procedure', () => {
  function asReviewer(overrides: Record<string, unknown> = {}) {
    given(
      reworkOccurrence({
        status: 'SUBMITTED',
        submittedAt: new Date('2026-11-04T06:30:00Z'),
        viewer: { isOwner: false, canClaim: false, canVerify: true },
        recordLinks: [
          recordLink({ createdAfterLatestRejection: true }),
          recordLink({
            id: 'link-2',
            occurrenceStepId: 'step-2',
            recordType: 'GOODS_RECEIPT',
            recordId: 'gr-1',
            detail: recordDetail({
              kind: 'GOODS_RECEIPT',
              label: 'Delivery GR-1042',
              value: null,
              location: null,
              outOfRange: null,
              statusLabel: 'Received',
            }),
          }),
        ],
        rework: {
          latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
          notes: [
            {
              id: 'note-1',
              occurrenceStepId: 'step-1',
              note: 'Linked this morning’s reading.',
              createdAt: new Date('2026-11-04T06:00:00Z'),
              authorName: 'Asma',
              afterLatestRejection: true,
            },
          ],
        },
        ...overrides,
      })
    );
    render(<RunnerHarness access={REVIEWER_ACCESS} from="review" />);
    return screen.getByRole('region', { name: 'Your review' });
  }

  it('sees the reason it answers and what changed', () => {
    const review = asReviewer();
    expect(within(review).getByRole('region', { name: 'Why it was sent back' })).toHaveTextContent(
      REASON
    );
    const changed = within(review).getByRole('list', {
      name: 'What they changed since it was sent back',
    });
    expect(changed).toHaveTextContent('Step 1 · Confirm the refrigerator temperature was recorded');
    expect(changed).toHaveTextContent('Linked this morning’s reading.');
  });

  it('sees what each linked record says, with out-of-range readings marked', () => {
    const review = asReviewer();
    const links = within(review).getByRole('list', { name: 'Linked records to check' });
    const [reading, receipt] = within(links).getAllByRole('listitem');
    expect(reading).toHaveTextContent('Vaccine fridge · 9.4 °C at 09:30');
    // The label carries the place and reading; the line below adds only the time.
    expect(within(reading).getByText(/^Recorded /)).toHaveTextContent(
      /^Recorded Nov 4, 2026, 9:30\sAM$/
    );
    expect(reading.textContent?.match(/9\.4 °C/g)).toHaveLength(1);
    expect(reading).toHaveTextContent('Recorded Nov 4, 2026, 9:30 AM');
    expect(within(reading).getByText('Out of range')).toBeVisible();
    expect(reading).toHaveTextContent('New since sent back');
    expect(receipt).toHaveTextContent('Delivery GR-1042');
    expect(receipt).toHaveTextContent('Received');
    expect(within(receipt).queryByText('Out of range')).not.toBeInTheDocument();
    // The completed-step summary carries the same detail.
    expect(screen.getByRole('list', { name: 'Linked records for step 1' })).toHaveTextContent(
      'Vaccine fridge · 9.4 °C at 09:30'
    );
  });

  it('says when no note answers the send-back', () => {
    const review = asReviewer({
      rework: {
        latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
        notes: [],
      },
    });
    expect(review).toHaveTextContent('No note says what changed.');
  });
});

describe('history of a reworked procedure', () => {
  it('records linked records and rework notes, with step names', () => {
    const occ = reworkOccurrence({
      rework: {
        latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
        notes: [
          {
            id: 'note-1',
            occurrenceStepId: 'step-1',
            note: 'Linked this morning’s reading.',
            createdAt: new Date('2026-11-04T06:00:00Z'),
            authorName: 'Asma',
            afterLatestRejection: true,
          },
          {
            id: 'note-2',
            occurrenceStepId: null,
            note: 'Replaced the reading.',
            createdAt: new Date('2026-11-04T06:05:00Z'),
            authorName: 'Asma',
            afterLatestRejection: true,
          },
        ],
      },
    }) as unknown as SopOccurrence;
    const entries = historyEntries(occ);
    expect(entries.find((entry) => entry.id === 'link:link-1')).toMatchObject({
      label: 'Record linked',
      detail:
        'Step 1 · Confirm the refrigerator temperature was recorded · Vaccine fridge · 9.4 °C at 09:30',
    });
    expect(entries.find((entry) => entry.id === 'rework:note-1')).toMatchObject({
      label: 'Rework note added',
      actor: 'Asma',
      detail:
        'Step 1 · Confirm the refrigerator temperature was recorded\nLinked this morning’s reading.',
    });
    expect(entries.find((entry) => entry.id === 'rework:note-2')).toMatchObject({
      label: 'Rework note added',
      detail: 'Replaced the reading.',
    });

    given(occ as unknown as Record<string, unknown>);
    render(<RunnerHarness />);
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getAllByText('Rework note added')).toHaveLength(2);
    expect(within(history).getByText('Record linked')).toBeVisible();
  });
});
