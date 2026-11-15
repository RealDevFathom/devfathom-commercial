import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule);

import { SopBoardView } from './sop-board';
import { OVERDUE_ESCALATION_COPY, overdueEscalationNotice, SopSetupView } from './sop-setup';
import { BRANCH, due, OWNER_ACCESS } from './sop-test-harness';
import { mockState as h } from './sop-trpc-mock';

/**
 * DEV-751 — opt-in overdue escalation in the Procedures workspace. Setup shows
 * it OFF by default and turns it on or off for this branch only, sending a
 * delay and nothing about who is notified (the server takes that from the
 * session). The board marks an item whose manager was notified.
 */

const SETUP_BRANCH = {
  pharmacyBranchId: BRANCH,
  name: 'Main Street',
  sopBranchId: 'sop_1',
  timezone: 'Asia/Karachi',
};

function renderSetup() {
  render(<SopSetupView branch={SETUP_BRANCH} onChanged={vi.fn()} onNotice={vi.fn()} />);
  return screen.getByRole('group', { name: 'Overdue escalation' });
}

beforeEach(() => {
  h.reset();
  h.queries.templates = { data: [] };
  h.queries.roleHoldings = { data: [] };
  h.queries.assignments = { data: [] };
  h.queries.siteSettings = {
    data: { pharmacyBranchId: BRANCH, autoScheduleEnabled: false, changedAt: null, reason: null },
  };
});
afterEach(cleanup);

describe('Overdue escalation in Setup', () => {
  it('is off by default and says overdue work is only flagged', () => {
    h.queries.overdueEscalation = {
      data: { pharmacyBranchId: BRANCH, enabled: false, delayMinutes: 30, changedAt: null },
    };
    const group = renderSetup();
    expect(within(group).getByText('Escalation off')).toBeVisible();
    expect(group).toHaveAccessibleDescription(OVERDUE_ESCALATION_COPY);
    expect(within(group).getByLabelText('Minutes after the window closes')).toHaveValue('30');
    expect(within(group).getByRole('button', { name: 'Turn on escalation' })).toBeEnabled();
    expect(
      within(group).queryByRole('button', { name: 'Turn off escalation' })
    ).not.toBeInTheDocument();
    expect(h.calls.setOverdueEscalation).toBeUndefined();
  });

  it('turns on for this branch with the chosen delay and no person in the input', () => {
    h.queries.overdueEscalation = {
      data: { pharmacyBranchId: BRANCH, enabled: false, delayMinutes: 30, changedAt: null },
    };
    h.outcomes.setOverdueEscalation = () => ({ enabled: true, delayMinutes: 45 });
    const group = renderSetup();
    fireEvent.change(within(group).getByLabelText('Minutes after the window closes'), {
      target: { value: '45' },
    });
    fireEvent.click(within(group).getByRole('button', { name: 'Turn on escalation' }));
    expect(h.calls.setOverdueEscalation).toEqual([
      { pharmacyBranchId: BRANCH, enabled: true, delayMinutes: 45 },
    ]);
    expect(group).toHaveTextContent(overdueEscalationNotice({ enabled: true, delayMinutes: 45 }));
    expect(h.invalidated).toContainEqual(['overdueEscalation', { pharmacyBranchId: BRANCH }]);
  });

  it('refuses a delay that is not whole minutes in range, sending nothing', () => {
    h.queries.overdueEscalation = {
      data: { pharmacyBranchId: BRANCH, enabled: false, delayMinutes: 30, changedAt: null },
    };
    const group = renderSetup();
    const input = within(group).getByLabelText('Minutes after the window closes');
    for (const value of ['', '-5', '2.5', '1441']) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(within(group).getByRole('button', { name: 'Turn on escalation' }));
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    expect(h.calls.setOverdueEscalation).toBeUndefined();
  });

  it('turns off when on', () => {
    h.queries.overdueEscalation = {
      data: { pharmacyBranchId: BRANCH, enabled: true, delayMinutes: 30, changedAt: due },
    };
    h.outcomes.setOverdueEscalation = () => ({ enabled: false, delayMinutes: 30 });
    const group = renderSetup();
    expect(within(group).getByText('Escalation on')).toBeVisible();
    fireEvent.click(within(group).getByRole('button', { name: 'Turn off escalation' }));
    expect(h.calls.setOverdueEscalation).toEqual([{ pharmacyBranchId: BRANCH, enabled: false }]);
    expect(group).toHaveTextContent(overdueEscalationNotice({ enabled: false, delayMinutes: 30 }));
  });

  it('keeps the controls disabled while the setting cannot be read, and offers a retry', () => {
    h.queries.overdueEscalation = { error: new Error('boom') };
    const group = renderSetup();
    expect(within(group).getByRole('button', { name: 'Turn on escalation' })).toBeDisabled();
    expect(within(group).getByRole('alert')).toHaveTextContent(/could not be loaded|boom/);
    expect(within(group).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('says a refusal beside the control', () => {
    h.queries.overdueEscalation = {
      data: { pharmacyBranchId: BRANCH, enabled: false, delayMinutes: 30, changedAt: null },
    };
    h.outcomes.setOverdueEscalation = () =>
      new Error('This pharmacy branch is outside your scope.');
    const group = renderSetup();
    fireEvent.click(within(group).getByRole('button', { name: 'Turn on escalation' }));
    expect(within(group).getByRole('alert')).toHaveTextContent(
      'This pharmacy branch is outside your scope.'
    );
  });
});

describe('the board', () => {
  function item(overrides: Record<string, unknown>) {
    return {
      occurrenceId: 'occ',
      status: 'SCHEDULED',
      businessDate: new Date('2026-11-04T00:00:00Z'),
      dueAt: due,
      windowEndsAt: new Date('2026-11-04T05:00:00Z'),
      startedAt: null,
      submittedAt: null,
      templateId: 'tpl',
      templateName: 'Pharmacy — opening',
      category: 'Opening',
      packKey: 'opening',
      roleKey: 'pharmacy-assistant',
      poolRoleKey: null,
      claimed: false,
      stepsTotal: 2,
      stepsCompleted: 0,
      overdue: true,
      escalated: false,
      missedRisk: false,
      ...overrides,
    };
  }

  it('marks only an item whose manager was notified', () => {
    h.queries.onDemandTemplates = { data: [] };
    h.queries.board = {
      data: {
        businessDate: '2026-11-04',
        canReview: false,
        mine: [
          item({ occurrenceId: 'occ-flagged', templateName: 'Pharmacy — opening' }),
          item({
            occurrenceId: 'occ-escalated',
            templateName: 'Pharmacy — closing',
            escalated: true,
          }),
        ],
        pool: [],
        review: [],
        counts: { overdue: 2, dueToday: 2, awaitingReview: 0 },
      },
    };
    render(
      <SopBoardView
        pharmacyBranchId={BRANCH}
        timezone="Asia/Karachi"
        access={OWNER_ACCESS}
        onOpen={vi.fn()}
        onSetup={vi.fn()}
        onNotice={vi.fn()}
      />
    );
    // Both are flagged overdue; only the escalated one says a manager was told.
    expect(screen.getAllByText('Manager notified')).toHaveLength(1);
    expect(screen.queryAllByText('Overdue').length).toBeGreaterThanOrEqual(2);
  });
});
