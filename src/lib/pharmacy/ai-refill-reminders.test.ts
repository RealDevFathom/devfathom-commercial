import { describe, expect, it, vi } from 'vitest';
import {
  approveOrSkipReminder,
  safeReminderText,
  sendApprovedReminder,
  suggestRefillDate,
  type ReminderDependencies,
  type ReminderRecord,
} from './ai-refill-reminders';

const day = (value: string) => ({ purchasedAt: new Date(`${value}T00:00:00.000Z`) });

describe('refill cadence', () => {
  it('does not suggest from one purchase', () => {
    expect(suggestRefillDate([day('2026-01-01')], 3)).toBeNull();
  });

  it('uses the median interval and subtracts configurable lead time', () => {
    const result = suggestRefillDate(
      [day('2026-01-01'), day('2026-01-31'), day('2026-03-02'), day('2026-06-10')],
      5
    );
    expect(result?.medianIntervalDays).toBe(30);
    expect(result?.reminderAt.toISOString()).toBe('2026-07-05T00:00:00.000Z');
  });

  it('deduplicates same-day receipts rather than producing a zero interval', () => {
    expect(suggestRefillDate([day('2026-01-01'), day('2026-01-01')], 2)).toBeNull();
  });
});

describe('human and consent gates', () => {
  const actor = { id: 'owner-1', role: 'ADMIN', status: 'ACTIVE' };
  const base: ReminderRecord = {
    id: 'reminder-1',
    organizationId: 'org-1',
    status: 'DRAFT',
    customerId: 'customer-1',
    medicineName: 'Example medicine',
    reminderAt: new Date('2026-05-01T00:00:00Z'),
    draftText: 'Your 20 mg dose may treat symptoms. Please contact the pharmacy.',
  };

  function fixture(overrides: { allowed?: boolean; optedIn?: boolean } = {}) {
    let row = { ...base };
    const audits: unknown[] = [];
    const sends: unknown[] = [];
    const deps: ReminderDependencies = {
      authorize: vi.fn(async () => overrides.allowed ?? true) as never,
      db: {
        find: async (organizationId, id) =>
          row.organizationId === organizationId && row.id === id ? { ...row } : null,
        update: async (organizationId, id, expected, patch) => {
          if (organizationId !== row.organizationId || id !== row.id || row.status !== expected)
            throw new Error('CONFLICT');
          row = { ...row, ...patch };
          return { ...row };
        },
        optedIn: async () => overrides.optedIn ?? true,
      },
      audit: async (entry) => void audits.push(entry),
      send: async (...args) => void sends.push(args),
    };
    return { deps, audits, sends, row: () => row };
  }

  it('requires approval before sending', async () => {
    const state = fixture();
    await expect(
      sendApprovedReminder(state.deps, { organizationId: 'org-1', reminderId: 'reminder-1' }, actor)
    ).rejects.toThrow('APPROVAL_REQUIRED');
    expect(state.sends).toEqual([]);
  });

  it('re-checks WhatsApp opt-in when sending', async () => {
    const state = fixture({ optedIn: false });
    await approveOrSkipReminder(state.deps, { organizationId: 'org-1', reminderId: 'reminder-1', decision: 'APPROVED' }, actor);
    await expect(sendApprovedReminder(state.deps, { organizationId: 'org-1', reminderId: 'reminder-1' }, actor)).rejects.toThrow('OPT_IN_REQUIRED');
    expect(state.sends).toEqual([]);
  });

  it('honours central permission DENY and writes approval/send audits with old and new state', async () => {
    const denied = fixture({ allowed: false });
    await expect(approveOrSkipReminder(denied.deps, { organizationId: 'org-1', reminderId: 'reminder-1', decision: 'APPROVED' }, actor)).rejects.toThrow('FORBIDDEN');

    const state = fixture();
    await approveOrSkipReminder(state.deps, { organizationId: 'org-1', reminderId: 'reminder-1', decision: 'APPROVED' }, actor);
    await sendApprovedReminder(state.deps, { organizationId: 'org-1', reminderId: 'reminder-1' }, actor);
    expect(state.audits).toHaveLength(2);
    expect(state.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'owner-1', organizationId: 'org-1', action: 'refill.approved', old: expect.objectContaining({ status: 'DRAFT' }), new: expect.objectContaining({ status: 'APPROVED' }), tier: 'standard' }),
      expect.objectContaining({ action: 'refill.send', old: expect.objectContaining({ status: 'APPROVED' }), new: expect.objectContaining({ status: 'SENT' }) }),
    ]));
    expect(state.sends).toEqual([['customer-1', 'Your may symptoms. Please contact the pharmacy.']]);
  });

  it('removes dosage and clinical language from model output', () => {
    expect(safeReminderText('Take 2 tablets daily to treat pain. Contact the pharmacy.')).toBe('daily to pain. Contact the pharmacy.');
  });
});
