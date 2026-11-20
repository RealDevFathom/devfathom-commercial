import { selectFieldControl } from '@/lib/testing/select-field';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule);

import { linksInStepOrder, type SopOccurrence } from './sop-model';
import { REWORK_NOTE_HINT } from './sop-runner';
import {
  due,
  occurrence,
  recordDetail,
  recordLink,
  REVIEWER_ACCESS,
  reworkOccurrence,
  RunnerHarness,
  step,
} from './sop-test-harness';
import { mockState as h, refusal } from './sop-trpc-mock';

/**
 * DEV-751 — browser re-check follow-ups: a refused change's message is brought
 * into view and focus, the rework-note copy matches the rule, a sent-back
 * procedure says "start again" once, and the reviewer reads linked records in
 * step order.
 */

const CHECKED = 'This procedure has already been checked.';
const scrollIntoView = vi.fn();

function reducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: matches && query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

beforeEach(() => {
  h.reset();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function reviewRace() {
  let state: Record<string, unknown> = occurrence({
    status: 'SUBMITTED',
    viewer: { isOwner: false, canClaim: false, canVerify: true },
    steps: [step({ completed: true, completedAt: due })],
  });
  h.queries.occurrence = () => ({ data: state });
  h.outcomes.verify = () => {
    state = { ...state, status: 'VERIFIED' };
    return refusal(CHECKED, 'CONFLICT');
  };
  render(<RunnerHarness access={REVIEWER_ACCESS} from="review" />);
  fireEvent.click(screen.getByRole('button', { name: 'Mark as checked' }));
}

describe('a refused change after the procedure changed elsewhere', () => {
  it('moves focus to the message and scrolls it into view once re-read', async () => {
    reviewRace();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(CHECKED);
    expect(alert).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    expect(scrollIntoView.mock.contexts[0]).toBe(alert);
    // The screen shows where it stands now.
    expect(screen.getByText('Checked')).toBeVisible();
  });

  it('does not scroll smoothly under reduced motion', async () => {
    reducedMotion(true);
    reviewRace();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it.each([
    ['start', 'Start', { status: 'SCHEDULED' }],
    ['submit', 'Send for review', { steps: [step({ completed: true, completedAt: due })] }],
  ])('brings the message into view after a %s race, too', async (name, button, overrides) => {
    h.queries.occurrence = { data: occurrence(overrides) };
    h.outcomes[name] = () => refusal(CHECKED, 'CONFLICT');
    render(<RunnerHarness />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('leaves focus alone for a refusal that is not a race', async () => {
    h.queries.occurrence = { data: occurrence({ status: 'SCHEDULED' }) };
    h.outcomes.start = () => refusal('Try again in a moment.', 'INTERNAL_SERVER_ERROR');
    render(<RunnerHarness />);
    const start = screen.getByRole('button', { name: 'Start' });
    start.focus();
    fireEvent.click(start);
    expect(screen.getByRole('alert')).toHaveTextContent('Try again in a moment.');
    await Promise.resolve();
    expect(start).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(h.invalidated).toEqual([]);
  });

  it('shows a refused record link at the top of the procedure, where it stays seen', async () => {
    h.queries.occurrence = {
      data: occurrence({ steps: [step({ requiredRecordType: 'TEMPERATURE_LOG' })] }),
    };
    h.queries.linkableRecords = {
      data: [
        { id: 'temp-2', recordType: 'TEMPERATURE_LOG', occurredAt: due, detail: recordDetail() },
      ],
    };
    h.outcomes.linkRecord = () => refusal(CHECKED, 'CONFLICT');
    render(<RunnerHarness />);
    fireEvent.change(
      selectFieldControl(screen.getByLabelText(
        'temperature log for Confirm the refrigerator temperature was recorded', { selector: ':not([data-select-field-native][aria-hidden="true"])' }
      )),
      { target: { value: 'temp-2' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Link record' }));
    // One message, not one in the picker and another at the top.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(CHECKED);
    await waitFor(() => expect(alerts[0]).toHaveFocus());
    expect(h.invalidated.map(([name]) => name)).toEqual(['occurrence', 'board']);
  });
});

describe('proof refused because the procedure moved on (a stale rework tab)', () => {
  const CHANGED =
    'This procedure has changed since you opened it. Refresh to see its current state.';

  /** Just enough of the browser upload request to answer one upload. */
  class FakeRequest {
    static sent: FakeRequest[] = [];
    status = 0;
    responseText = '';
    upload = { addEventListener: vi.fn() };
    private listeners: Record<string, Array<() => void>> = {};
    open() {}
    addEventListener(type: string, listener: () => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    send() {
      FakeRequest.sent.push(this);
    }
    answer(status: number, body: string) {
      this.status = status;
      this.responseText = body;
      for (const listener of this.listeners.load ?? []) listener();
    }
  }

  beforeEach(() => {
    FakeRequest.sent = [];
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the server’s words at the top, focused, offers no retry and re-reads it', async () => {
    h.queries.occurrence = { data: reworkOccurrence() };
    h.queries.linkableRecords = { data: [] };
    render(<RunnerHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a change to step 1' }));
    fireEvent.change(
      selectFieldControl(screen.getByLabelText('Photo for Confirm the refrigerator temperature was recorded', { selector: ':not([data-select-field-native][aria-hidden="true"])' })),
      { target: { files: [new File(['fridge'], 'fridge.jpg', { type: 'image/jpeg' })] } }
    );
    expect(FakeRequest.sent).toHaveLength(1);
    act(() => FakeRequest.sent[0]!.answer(409, JSON.stringify({ error: CHANGED, conflict: true })));
    // One message, at the top of the procedure, not one inside the upload too.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(CHANGED);
    expect(alerts[0]).not.toHaveTextContent(/occurrence/i);
    await waitFor(() => expect(alerts[0]).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
    expect(h.invalidated.map(([name]) => name)).toEqual(['occurrence', 'board']);
  });
});

describe('a sent-back procedure', () => {
  it('says what starting again does once', () => {
    h.queries.occurrence = { data: reworkOccurrence({ status: 'REJECTED' }) };
    render(<RunnerHarness />);
    expect(screen.getAllByText(/Start again to fix it/)).toHaveLength(1);
    expect(
      screen.queryByText('This was sent back. Start again to fix it.')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start again' })).toBeVisible();
  });

  it('says a note here or on a step meets the rework-note rule', () => {
    h.queries.occurrence = { data: reworkOccurrence() };
    h.queries.linkableRecords = { data: [] };
    render(<RunnerHarness />);
    const section = screen.getByRole('region', { name: 'What did you change?' });
    expect(within(section).getByLabelText('Your note', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAccessibleDescription(
      REWORK_NOTE_HINT
    );
    expect(REWORK_NOTE_HINT).toBe(
      'Add at least one note — here or on a step — saying what you changed before sending it for review again.'
    );
    expect(section).not.toHaveTextContent(/It is needed before/);
  });
});

describe('linked records for the reviewer', () => {
  const steps = [
    step({ completed: true, completedAt: due, requiredRecordType: 'TEMPERATURE_LOG' }),
    step({
      id: 'step-2',
      templateStepId: 'tstep-2',
      stepOrder: 2,
      title: 'Check the second fridge',
      completed: true,
      completedAt: due,
      requiredRecordType: 'TEMPERATURE_LOG',
    }),
  ];
  const links = [
    recordLink({
      id: 'l-step2',
      occurrenceStepId: 'step-2',
      createdAt: new Date('2026-11-04T04:10:00Z'),
      detail: recordDetail({ label: 'Second fridge reading' }),
    }),
    recordLink({
      id: 'l-step1-late',
      occurrenceStepId: 'step-1',
      createdAt: new Date('2026-11-04T05:30:00Z'),
      detail: recordDetail({ label: 'Later first fridge reading' }),
    }),
    recordLink({
      id: 'l-step1-early',
      occurrenceStepId: 'step-1',
      createdAt: new Date('2026-11-04T04:05:00Z'),
      detail: recordDetail({ label: 'Earlier first fridge reading' }),
    }),
  ];

  it('orders them by step, then by when each was linked', () => {
    expect(
      linksInStepOrder({ steps, recordLinks: links } as unknown as SopOccurrence).map(
        (link) => link.id
      )
    ).toEqual(['l-step1-early', 'l-step1-late', 'l-step2']);

    h.queries.occurrence = {
      data: occurrence({
        status: 'SUBMITTED',
        viewer: { isOwner: false, canClaim: false, canVerify: true },
        steps,
        recordLinks: links,
      }),
    };
    render(<RunnerHarness access={REVIEWER_ACCESS} from="review" />);
    const list = screen.getByRole('list', { name: 'Linked records to check' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      expect.stringMatching(/^Step 1 · .*Earlier first fridge reading/),
      expect.stringMatching(/^Step 1 · .*Later first fridge reading/),
      expect.stringMatching(/^Step 2 · Check the second fridgeSecond fridge reading/),
    ]);
  });
});
