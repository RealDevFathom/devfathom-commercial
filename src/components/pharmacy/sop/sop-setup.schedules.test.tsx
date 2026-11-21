import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-751 — Setup scheduling is opt-in and assumes no time of day: the
 * per-branch "Automatic scheduling" switch starts off, its copy says plainly
 * what turning it on does (procedures created from this branch's schedules,
 * checked every hour), and every schedule time starts empty and must be chosen.
 */

type QueryValue = { data?: unknown; error?: unknown; loading?: boolean };

const h = vi.hoisted(() => ({
  queries: {} as Record<string, QueryValue>,
  outcomes: {} as Record<string, (input: unknown) => unknown>,
  calls: {} as Record<string, unknown[]>,
}));

vi.mock('@/lib/trpc', () => {
  const procedure = (name: string) => ({
    useQuery: () => {
      const value = h.queries[name] ?? {};
      return {
        data: value.data,
        error: value.error ?? null,
        isLoading: Boolean(value.loading),
        refetch: vi.fn(async () => ({ data: value.data })),
      };
    },
    useMutation: (options?: {
      onSuccess?: (result: unknown) => unknown;
      onError?: (error: unknown) => unknown;
    }) => ({
      isPending: false,
      isSuccess: false,
      mutate: (input: unknown) => {
        (h.calls[name] ??= []).push(input);
        const result = h.outcomes[name]?.(input) ?? {};
        if (result instanceof Error) options?.onError?.(result);
        else options?.onSuccess?.(result);
      },
    }),
  });
  const invalidate = { invalidate: vi.fn(async () => undefined) };
  return {
    trpc: {
      pharmacySop: new Proxy({}, { get: (_target, name: string) => procedure(name) }),
      useUtils: () => ({ pharmacySop: new Proxy({}, { get: () => invalidate }) }),
    },
  };
});

import { AUTO_SCHEDULE_COPY, SopSetupView } from './sop-setup';

const BRANCH = {
  pharmacyBranchId: 'pb_1',
  name: 'Main Street',
  sopBranchId: 'sop_1',
  timezone: 'Asia/Karachi',
};

function template(overrides: {
  key: string;
  name: string;
  trigger: 'SHIFT' | 'INTERVAL' | 'ASSIGNED';
  frequency: 'DAILY' | 'INTERVAL' | 'ONCE';
}) {
  return {
    id: `tpl_${overrides.key}`,
    name: overrides.name,
    category: 'Opening',
    isActive: true,
    publishedVersion: { id: 'v1', versionNumber: 1 },
    steps: [],
    pack: {
      key: overrides.key,
      name: overrides.name,
      category: 'Opening',
      description: '',
      roleKey: 'pharmacy-qualified-person',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: ['pharmacy-manager'],
      trigger: overrides.trigger,
      // As the library now ships it: frequency and window only, no time of day.
      suggestedRecurrence: {
        frequency: overrides.frequency,
        interval: overrides.frequency === 'INTERVAL' ? 240 : 1,
        daysOfWeek: overrides.frequency === 'INTERVAL' ? [0, 1, 2, 3, 4, 5, 6] : [],
        monthDay: null,
        dueTimeMinutes: null,
        intervalEndTimeMinutes: null,
        windowMinutes: overrides.frequency === 'INTERVAL' ? 240 : 120,
        graceMinutes: 30,
      },
    },
  };
}

const OPENING = template({
  key: 'opening',
  name: 'Pharmacy — opening',
  trigger: 'SHIFT',
  frequency: 'DAILY',
});
const TEMPERATURE = template({
  key: 'temperature-log',
  name: 'Pharmacy — temperature log',
  trigger: 'INTERVAL',
  frequency: 'INTERVAL',
});

function renderSetup() {
  const onNotice = vi.fn();
  render(<SopSetupView branch={BRANCH} onChanged={vi.fn()} onNotice={onNotice} />);
  return { onNotice };
}

function openForm(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Create schedule for ${name}` }));
  return screen.getByRole('form', { name: `Schedule for ${name}` });
}

beforeEach(() => {
  h.queries = {
    templates: { data: [OPENING, TEMPERATURE] },
    roleHoldings: { data: [] },
    assignments: { data: [] },
    siteSettings: {
      data: {
        pharmacyBranchId: 'pb_1',
        autoScheduleEnabled: false,
        changedAt: null,
        reason: null,
      },
    },
  };
  h.outcomes = {};
  h.calls = {};
});

afterEach(() => cleanup());

describe('Automatic scheduling switch', () => {
  it('is off by default, with plain copy that procedures never block work', () => {
    renderSetup();
    const toggle = screen.getByRole('switch', { name: 'Automatic scheduling' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription(AUTO_SCHEDULE_COPY);
    expect(AUTO_SCHEDULE_COPY).toBe(
      "When on, this branch's procedures are created automatically from its schedules, due at the times you set. It checks every hour. When off, use 'Create work from schedules now'. Procedures never block pharmacy work."
    );
    expect(AUTO_SCHEDULE_COPY).not.toMatch(/background|job|worker/i);
    expect(screen.getByText('Off')).toBeVisible();
  });

  it('turns on for this branch only, and says so beside the switch', () => {
    h.outcomes.setAutoSchedule = () => ({
      autoScheduleEnabled: true,
      changed: true,
      generated: 3,
      nextRunAt: new Date('2026-11-04T07:00:00Z'),
    });
    renderSetup();
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic scheduling' }));
    expect(h.calls.setAutoSchedule).toEqual([{ pharmacyBranchId: 'pb_1', enabled: true }]);
    // Asia/Karachi is UTC+5.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Turned on. 3 procedures were created from your schedules; next automatic run at 12:00.'
    );
  });

  it('turns off for this branch only, and points to creating work by hand', () => {
    h.queries.siteSettings = { data: { pharmacyBranchId: 'pb_1', autoScheduleEnabled: true } };
    h.outcomes.setAutoSchedule = () => ({
      autoScheduleEnabled: false,
      changed: true,
      generated: null,
      nextRunAt: null,
    });
    renderSetup();
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic scheduling' }));
    expect(h.calls.setAutoSchedule).toEqual([{ pharmacyBranchId: 'pb_1', enabled: false }]);
    expect(screen.getByRole('status')).toHaveTextContent(
      "Turned off. Use 'Create work from schedules now' when you are ready."
    );
  });

  it('shows the saved state when it is on', () => {
    h.queries.siteSettings = { data: { pharmacyBranchId: 'pb_1', autoScheduleEnabled: true } };
    renderSetup();
    expect(screen.getByRole('switch', { name: 'Automatic scheduling' })).toBeChecked();
    expect(screen.getByText('On')).toBeVisible();
  });

  it('stays off and disabled while loading or when the setting cannot be read', () => {
    h.queries.siteSettings = { loading: true };
    renderSetup();
    const loading = screen.getByRole('switch', { name: 'Automatic scheduling' });
    expect(loading).not.toBeChecked();
    expect(loading).toHaveAttribute('aria-disabled', 'true');
    cleanup();

    h.queries.siteSettings = { error: new Error('boom') };
    renderSetup();
    const failed = screen.getByRole('switch', { name: 'Automatic scheduling' });
    expect(failed).not.toBeChecked();
    expect(failed).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('reports a refused change without flipping', () => {
    h.outcomes.setAutoSchedule = () => new Error('This pharmacy branch is outside your scope.');
    renderSetup();
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic scheduling' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/outside your scope|could not be changed/);
  });
});

describe('schedule form times', () => {
  it('shows only the suggested frequency, never a time of day', () => {
    renderSetup();
    expect(screen.getByText(/Suggested: Every day\./)).toBeVisible();
    // Every day of the week reads as a plain repeat, in hours.
    expect(screen.getByText(/Suggested: Every 4 hours\./)).toBeVisible();
    expect(document.body).not.toHaveTextContent(/\b\d{2}:\d{2}\b/);
  });

  it('starts the due time empty and requires it', () => {
    renderSetup();
    const form = openForm(OPENING.name);
    const due = within(form).getByLabelText('Due at');
    expect(due).toHaveValue('');
    expect(due).toBeRequired();
    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(h.calls.createAssignment).toBeUndefined();
    expect(due).toHaveAttribute('aria-invalid', 'true');
    expect(due).toHaveAccessibleDescription(/Choose the time it is due\./);
    expect(due).toHaveFocus();
  });

  it('sends exactly the time the manager chose', () => {
    renderSetup();
    const form = openForm(OPENING.name);
    fireEvent.change(within(form).getByLabelText('Due at'), { target: { value: '07:45' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(h.calls.createAssignment).toEqual([
      expect.objectContaining({
        frequency: 'DAILY',
        dueTimeMinutes: 465,
        intervalEndTimeMinutes: null,
        windowMinutes: 120,
        graceMinutes: 30,
      }),
    ]);
  });

  it('starts both repeating-check times empty and requires each', () => {
    renderSetup();
    const form = openForm(TEMPERATURE.name);
    const first = within(form).getByLabelText('First one at');
    const last = within(form).getByLabelText('Last one by');
    expect(first).toHaveValue('');
    expect(last).toHaveValue('');
    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(h.calls.createAssignment).toBeUndefined();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAccessibleDescription(/Choose the time the first one is due\./);
    expect(last).toHaveAttribute('aria-invalid', 'true');
    expect(last).toHaveAccessibleDescription(/Choose the time the last one is due\./);

    fireEvent.change(first, { target: { value: '09:00' } });
    fireEvent.change(last, { target: { value: '08:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(h.calls.createAssignment).toBeUndefined();
    expect(last).toHaveAccessibleDescription(/later than the first one/);

    fireEvent.change(last, { target: { value: '17:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(h.calls.createAssignment).toEqual([
      expect.objectContaining({
        frequency: 'INTERVAL',
        dueTimeMinutes: 540,
        intervalEndTimeMinutes: 1020,
      }),
    ]);
  });

  it('maps a server refusal for a missing time to the plain field message', () => {
    h.outcomes.createAssignment = () =>
      Object.assign(new Error('Choose the time this procedure is due.'), {
        data: { code: 'BAD_REQUEST', validation: { dueTimeMinutes: ['missing'] } },
      });
    renderSetup();
    const form = openForm(OPENING.name);
    fireEvent.change(within(form).getByLabelText('Due at'), { target: { value: '07:45' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
    const due = within(form).getByLabelText('Due at');
    expect(due).toHaveAttribute('aria-invalid', 'true');
    expect(due).toHaveAccessibleDescription(/Choose the time it is due\./);
  });
});
