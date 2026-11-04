import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule);

import { autoScheduleNotice, PAUSE_COPY, SopSetupView, SWITCH_CONTRAST } from './sop-setup';
import { mockState as h } from './sop-trpc-mock';

/**
 * DEV-751 — Setup switches: a visible off state, names that say whose schedule
 * a switch pauses, and what a change did, said beside the switch.
 */

const BRANCH = {
  pharmacyBranchId: 'pb_1',
  name: 'Main Street',
  sopBranchId: 'sop_1',
  timezone: 'Asia/Karachi',
};

function assignment(overrides: Record<string, unknown>) {
  return {
    id: 'as_1',
    templateId: 'tpl_1',
    templateName: 'Pharmacy — training attestation',
    packKey: 'training-attestation',
    target: { type: 'PERSON', userId: 'u_1', displayName: 'QA Reviewer' },
    frequency: 'ONCE',
    interval: 1,
    daysOfWeek: [],
    monthDay: null,
    dueTimeMinutes: 9 * 60,
    intervalEndTimeMinutes: null,
    windowMinutes: 1440,
    graceMinutes: 0,
    startDate: new Date('2026-11-04T00:00:00Z'),
    endDate: null,
    active: true,
    superseded: false,
    ...overrides,
  };
}

function renderSetup() {
  render(<SopSetupView branch={BRANCH} onChanged={vi.fn()} onNotice={vi.fn()} />);
}

beforeEach(() => {
  h.reset();
  h.queries = {
    templates: { data: [] },
    roleHoldings: { data: [] },
    assignments: {
      data: [
        assignment({}),
        assignment({
          id: 'as_2',
          templateName: 'Pharmacy — temperature log',
          target: { type: 'ROLE', roleKey: 'pharmacy-assistant' },
          frequency: 'INTERVAL',
          interval: 240,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          dueTimeMinutes: 9 * 60,
          intervalEndTimeMinutes: 21 * 60,
          active: false,
        }),
      ],
    },
    siteSettings: {
      data: { pharmacyBranchId: 'pb_1', autoScheduleEnabled: false, changedAt: null, reason: null },
    },
  };
});
afterEach(cleanup);

describe('Setup switches', () => {
  it('gives every switch a visible off state from existing tokens', () => {
    renderSetup();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(3);
    for (const control of switches) {
      for (const token of SWITCH_CONTRAST.split(' ')) expect(control.className).toContain(token);
      // The shared low-contrast off track is replaced, not stacked.
      expect(control.className).not.toContain('data-unchecked:bg-input');
    }
    expect(SWITCH_CONTRAST).toContain('data-unchecked:border-text-muted');
  });

  it('names whose schedule each switch pauses or resumes', () => {
    renderSetup();
    expect(
      screen.getByRole('switch', { name: 'Pause Pharmacy — training attestation for QA Reviewer' })
    ).toBeChecked();
    expect(
      screen.getByRole('switch', {
        name: 'Resume Pharmacy — temperature log for Pharmacy assistant',
      })
    ).not.toBeChecked();
    expect(
      screen.getByText('Every 4 hours from 09:00 to 21:00 · Anyone holding Pharmacy assistant')
    ).toBeVisible();
  });

  it('says pausing keeps work already created, and confirms a pause and a resume', () => {
    renderSetup();
    expect(screen.getByText(PAUSE_COPY)).toBeVisible();
    expect(PAUSE_COPY).toMatch(/Work already created stays/);

    fireEvent.click(
      screen.getByRole('switch', { name: 'Pause Pharmacy — training attestation for QA Reviewer' })
    );
    expect(h.calls.setAssignmentActive).toEqual([
      { pharmacyBranchId: 'pb_1', assignmentId: 'as_1', active: false },
    ]);
    expect(
      screen.getByText(
        'Paused Pharmacy — training attestation for QA Reviewer. Work already created stays and can still be done.'
      )
    ).toHaveAttribute('role', 'status');

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Resume Pharmacy — temperature log for Pharmacy assistant',
      })
    );
    expect(
      screen.getByText(
        'Resumed Pharmacy — temperature log for Pharmacy assistant. New work will be created from it again.'
      )
    ).toHaveAttribute('role', 'status');
  });

  it('shows the next automatic run while it is on, when the server knows it', () => {
    h.queries.siteSettings = {
      data: {
        pharmacyBranchId: 'pb_1',
        autoScheduleEnabled: true,
        nextRunAt: new Date('2026-11-04T07:00:00Z'),
      },
    };
    renderSetup();
    expect(screen.getByText('Next automatic run at 12:00.')).toBeVisible();
  });

  it('words every automatic-scheduling result plainly', () => {
    const tz = 'Asia/Karachi';
    const next = new Date('2026-11-04T07:00:00Z');
    expect(
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 1, nextRunAt: next }, tz)
    ).toBe('Turned on. 1 procedure was created for today; next automatic run at 12:00.');
    expect(
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 0, nextRunAt: next }, tz)
    ).toBe('Turned on. No procedures were due to be created yet; next automatic run at 12:00.');
    expect(
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 2, nextRunAt: null }, tz)
    ).toBe('Turned on. 2 procedures were created for today. It checks every hour.');
    for (const text of [
      autoScheduleNotice({ autoScheduleEnabled: true }, tz),
      autoScheduleNotice({ autoScheduleEnabled: false }, tz),
    ]) {
      expect(text).not.toMatch(/background|job|worker/i);
    }
  });
});
