import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule);

import {
  autoScheduleNotice,
  generateNotice,
  PAUSE_COPY,
  scheduleSwitchNames,
  SopSetupView,
  SWITCH_CONTRAST,
  SWITCH_HIT_AREA,
} from './sop-setup';
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

function renderSetup(onNotice = vi.fn()) {
  render(<SopSetupView branch={BRANCH} onChanged={vi.fn()} onNotice={onNotice} />);
}

const TRAINING = 'Schedule active: Pharmacy — training attestation for QA Reviewer';
const TEMPERATURE = 'Schedule active: Pharmacy — temperature log for Pharmacy assistant';

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

  it('gives every switch a hit area at least 44px tall, without a <label> wrapper', () => {
    renderSetup();
    // 18.4px track + 2 × 14px overlay = 46.4px tall; the overlay is 56px wide.
    expect(SWITCH_HIT_AREA).toBe('after:-inset-y-3.5');
    for (const control of screen.getAllByRole('switch')) {
      expect(control.className).toContain(SWITCH_HIT_AREA);
      // The shared 34px overlay is replaced, not stacked; its width stays.
      expect(control.className).not.toContain('after:-inset-y-2');
      expect(control.className).toContain('after:-inset-x-3');
    }
    const schedule = screen.getByRole('switch', { name: TRAINING });
    expect(schedule.closest('label')).toBeNull();
    // Still the shared, focusable switch: it takes keyboard focus and toggles.
    schedule.focus();
    expect(schedule).toHaveFocus();
    fireEvent.click(schedule);
    expect(h.calls.setAssignmentActive).toEqual([
      {
        pharmacyBranchId: 'pb_1',
        assignmentId: 'as_1',
        active: false,
      },
    ]);
  });

  it('names each switch by what it controls, so checked reads as active', () => {
    renderSetup();
    const active = screen.getByRole('switch', { name: TRAINING });
    expect(active).toBeChecked();
    const paused = screen.getByRole('switch', { name: TEMPERATURE });
    expect(paused).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: /^(Pause|Resume) / })).not.toBeInTheDocument();
    // The visible word still says the state.
    expect(within(active.parentElement!).getByText('Active')).toBeVisible();
    expect(within(paused.parentElement!).getByText('Paused')).toBeVisible();
    expect(
      screen.getByText('Every 4 hours from 09:00 to 21:00 · Anyone holding Pharmacy assistant')
    ).toBeVisible();
  });

  it('tells two schedules for the same procedure and people apart by when they run', () => {
    const hygiene = {
      templateName: 'Pharmacy — hygiene',
      target: { type: 'ROLE', roleKey: 'pharmacy-assistant' },
      frequency: 'DAILY',
    };
    h.queries.assignments = {
      data: [
        assignment({ ...hygiene, id: 'as_a', dueTimeMinutes: 9 * 60 }),
        assignment({ ...hygiene, id: 'as_b', dueTimeMinutes: 15 * 60 }),
        assignment({ id: 'as_c' }),
      ],
    };
    renderSetup();
    const base = 'Schedule active: Pharmacy — hygiene for Pharmacy assistant';
    expect(screen.getByRole('switch', { name: `${base}, every day at 09:00` })).toBeChecked();
    expect(screen.getByRole('switch', { name: `${base}, every day at 15:00` })).toBeChecked();
    // A schedule with a name of its own keeps the short one.
    expect(screen.getByRole('switch', { name: TRAINING })).toBeVisible();

    // Identical in every way: numbered, so no two switches share a name.
    type Row = Parameters<typeof scheduleSwitchNames>[0][number];
    const same = assignment(hygiene) as unknown as Row;
    expect(scheduleSwitchNames([same, same])).toEqual([
      `${base}, every day at 09:00 (1)`,
      `${base}, every day at 09:00 (2)`,
    ]);
  });

  it('says pausing keeps work already created, and confirms a pause and a resume', () => {
    renderSetup();
    expect(screen.getByText(PAUSE_COPY)).toBeVisible();
    expect(PAUSE_COPY).toMatch(/Work already created stays/);

    fireEvent.click(screen.getByRole('switch', { name: TRAINING }));
    expect(h.calls.setAssignmentActive).toEqual([
      { pharmacyBranchId: 'pb_1', assignmentId: 'as_1', active: false },
    ]);
    expect(
      screen.getByText(
        'Paused Pharmacy — training attestation for QA Reviewer. Work already created stays and can still be done.'
      )
    ).toHaveAttribute('role', 'status');

    fireEvent.click(screen.getByRole('switch', { name: TEMPERATURE }));
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
    ).toBe('Turned on. 1 procedure was created from your schedules; next automatic run at 12:00.');
    expect(
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 0, nextRunAt: next }, tz)
    ).toBe('Turned on. No procedures were due to be created yet; next automatic run at 12:00.');
    expect(
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 2, nextRunAt: null }, tz)
    ).toBe('Turned on. 2 procedures were created from your schedules. It checks every hour.');
    for (const text of [
      autoScheduleNotice({ autoScheduleEnabled: true }, tz),
      autoScheduleNotice({ autoScheduleEnabled: false }, tz),
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 1, nextRunAt: next }, tz),
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 0, nextRunAt: next }, tz),
    ]) {
      expect(text).not.toMatch(/background|job|worker/i);
    }
    // Work it creates can be due tomorrow, so a count is never called "today's".
    expect(
      autoScheduleNotice({ autoScheduleEnabled: true, generated: 1, nextRunAt: next }, tz)
    ).not.toMatch(/today/i);
  });

  it('says what creating work by hand made, from what the server created', () => {
    expect(generateNotice({ created: 1 })).toBe('Created 1 procedure from your schedules.');
    expect(generateNotice({ created: 3 })).toBe('Created 3 procedures from your schedules.');
    expect(generateNotice({ created: 0 })).toBe(
      'Nothing new to create from your schedules right now.'
    );
    for (const created of [0, 1, 3]) expect(generateNotice({ created })).not.toMatch(/today/i);

    const onNotice = vi.fn();
    h.outcomes.generate = () => ({ assignmentsProcessed: 2, created: 1, skipped: 1 });
    renderSetup(onNotice);
    fireEvent.click(screen.getByRole('button', { name: "Create today's work now" }));
    expect(h.calls.generate).toEqual([{ pharmacyBranchId: 'pb_1' }]);
    expect(onNotice).toHaveBeenCalledWith({
      tone: 'success',
      text: 'Created 1 procedure from your schedules.',
    });
  });
});
