import { readFileSync } from 'node:fs';
import { generateText } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can } from '@/lib/abac';
import { routeAI } from '@/lib/ai/router';
import {
  aiProviderSecretConfigured, approveOrSkipReminder, draftReminderText, refillAIEnabled,
  safeReminderText, sendApprovedReminder, suggestRefillDate,
  type ReminderDependencies, type ReminderRecord,
} from './ai-refill-reminders';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('@/lib/ai/router', () => ({
  routeAI: vi.fn(async (options: { execute: (selection: unknown) => Promise<{ value: string }> }) =>
    (await options.execute({ model: 'stub-model', modelId: 'stub-model-v1' })).value),
}));

type EvalFixture = {
  name: string;
  input: { purchases?: string[]; leadDays?: number; modelOutput?: string };
  expected: { medianIntervalDays?: number; lastPurchasedAt?: string; reminderAt?: string; safeText?: string; suggestion?: null };
};
const evalFixtures = JSON.parse(readFileSync('tests/fixtures/ai/refill-reminders/representative-pharmacy-inputs.json', 'utf8')) as EvalFixture[];
const day = (value: string) => ({ purchasedAt: new Date(`${value}T00:00:00.000Z`) });
const actor = { id: 'owner-1', role: 'ADMIN', status: 'ACTIVE' };
const base: ReminderRecord = {
  id: 'reminder-1', organizationId: 'org-a', status: 'DRAFT', customerId: 'customer-1',
  medicineName: 'Example medicine', reminderAt: new Date('2026-05-01T00:00:00Z'),
  draftText: 'Your 20 mg dose may treat symptoms. Please contact the pharmacy.',
};

function fixture(overrides: { allowed?: boolean; optedIn?: boolean; permissionRows?: unknown } = {}) {
  let row = { ...base };
  const audits: Parameters<ReminderDependencies['audit']>[0][] = [];
  const sends: [string, string][] = [];
  const find = vi.fn(async (organizationId: string, id: string) =>
    row.organizationId === organizationId && row.id === id ? { ...row } : null);
  const update = vi.fn(async (organizationId: string, id: string, expected: ReminderRecord['status'], patch: Partial<ReminderRecord>) => {
    if (organizationId !== row.organizationId || id !== row.id || row.status !== expected) throw new Error('CONFLICT');
    row = { ...row, ...patch };
    return { ...row };
  });
  const optedIn = vi.fn(async () => overrides.optedIn ?? true);
  const db = {
    find, update, optedIn,
    user: { findUnique: vi.fn(async () => overrides.permissionRows ?? { organizationRole: null, permissionOverrides: [] }) },
  };
  const deps: ReminderDependencies = {
    authorize: vi.fn(async () => overrides.allowed ?? true) as never,
    db,
    audit: vi.fn(async (entry) => void audits.push(entry)),
    send: vi.fn(async (customerId, text) => void sends.push([customerId, text])),
  };
  return { deps, db, audits, sends };
}

beforeEach(() => vi.clearAllMocks());

describe('refill reminder evaluation fixtures', () => {
  it.each(evalFixtures)('$name', ({ input, expected }) => {
    if (input.purchases) {
      const result = suggestRefillDate(input.purchases.map(day), input.leadDays!);
      if (expected.suggestion === null) expect(result).toBeNull();
      else {
        expect(result).toMatchObject({ medianIntervalDays: expected.medianIntervalDays });
        expect(result?.lastPurchasedAt.toISOString()).toBe(expected.lastPurchasedAt);
        expect(result?.reminderAt.toISOString()).toBe(expected.reminderAt);
      }
    }
    if (input.modelOutput) expect(safeReminderText(input.modelOutput)).toBe(expected.safeText);
  });

  it('rejects invalid lead times and purchase histories', () => {
    expect(suggestRefillDate([day('2026-01-01'), day('2026-02-01')], -1)).toBeNull();
    expect(suggestRefillDate([day('2026-01-01'), day('2026-02-01')], 1.5)).toBeNull();
    expect(suggestRefillDate([day('2026-01-01'), day('2026-01-01')], 2)).toBeNull();
  });
});

describe('AI configuration is server-gated and off by default', () => {
  it('requires both an org opt-in and a configured provider secret', () => {
    const configured = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'server-secret' };
    expect(refillAIEnabled(false, configured)).toBe(false);
    expect(refillAIEnabled(true, {})).toBe(false);
    expect(refillAIEnabled(true, { AI_PROVIDER: 'anthropic' })).toBe(false);
    expect(refillAIEnabled(true, configured)).toBe(true);
  });

  it('accepts supported server credentials but not blanks or client-side values', () => {
    expect(aiProviderSecretConfigured({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  ' })).toBe(false);
    expect(aiProviderSecretConfigured({ AI_PROVIDER: 'bedrock', AWS_ACCESS_KEY_ID: 'credential' })).toBe(true);
    expect(aiProviderSecretConfigured({ AI_PROVIDER: 'bedrock', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials' })).toBe(true);
    expect(aiProviderSecretConfigured({ AI_PROVIDER: 'anthropic', NEXT_PUBLIC_ANTHROPIC_API_KEY: 'nope' })).toBe(false);
  });
});

describe('authorization and tenant isolation', () => {
  it('uses central can() and tenant-scopes every read and update', async () => {
    const state = fixture({ permissionRows: {
      organizationRole: { permissions: [{ capability: 'pharmacy:refill-reminders', effect: 'ALLOW' }] }, permissionOverrides: [],
    } });
    state.deps.authorize = can;
    await approveOrSkipReminder(state.deps, { organizationId: 'org-a', reminderId: 'reminder-1', decision: 'SKIPPED' }, actor);
    expect(state.db.find).toHaveBeenCalledWith('org-a', 'reminder-1');
    expect(state.db.update).toHaveBeenCalledWith('org-a', 'reminder-1', 'DRAFT', { status: 'SKIPPED' });
  });

  it('does not let organization A read or mutate organization B reminders', async () => {
    const state = fixture();
    await expect(approveOrSkipReminder(state.deps, { organizationId: 'org-b', reminderId: 'reminder-1', decision: 'APPROVED' }, actor)).rejects.toThrow('REMINDER_NOT_DRAFT');
    expect(state.db.find).toHaveBeenCalledWith('org-b', 'reminder-1');
    expect(state.db.update).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
  });

  it('honours explicit DENY over role ALLOW through central can()', async () => {
    const state = fixture({ permissionRows: {
      organizationRole: { permissions: [{ capability: 'pharmacy:refill-reminders', effect: 'ALLOW' }] },
      permissionOverrides: [{ capability: 'pharmacy:refill-reminders', effect: 'DENY' }],
    } });
    state.deps.authorize = can;
    await expect(approveOrSkipReminder(state.deps, { organizationId: 'org-a', reminderId: 'reminder-1', decision: 'APPROVED' }, actor)).rejects.toThrow('FORBIDDEN');
    expect(state.db.find).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
  });
});

describe('happy path, consent, idempotency, and audit log', () => {
  it('approves, sends safe copy, and audits before/after snapshots', async () => {
    const state = fixture();
    const approved = await approveOrSkipReminder(state.deps, { organizationId: 'org-a', reminderId: 'reminder-1', decision: 'APPROVED' }, actor);
    const sent = await sendApprovedReminder(state.deps, { organizationId: 'org-a', reminderId: 'reminder-1' }, actor);
    expect([approved.status, sent.status]).toEqual(['APPROVED', 'SENT']);
    expect(state.sends).toEqual([['customer-1', 'Your may symptoms. Please contact the pharmacy.']]);
    expect(state.audits).toEqual([
      expect.objectContaining({ actorId: 'owner-1', organizationId: 'org-a', action: 'refill.approved', old: expect.objectContaining({ status: 'DRAFT' }), new: expect.objectContaining({ status: 'APPROVED' }), model: null, tier: 'standard' }),
      expect.objectContaining({ action: 'refill.send', old: expect.objectContaining({ status: 'APPROVED' }), new: expect.objectContaining({ status: 'SENT' }), model: null, tier: 'standard' }),
    ]);
  });

  it('requires approval and re-checks customer opt-in before send', async () => {
    const draft = fixture();
    await expect(sendApprovedReminder(draft.deps, { organizationId: 'org-a', reminderId: 'reminder-1' }, actor)).rejects.toThrow('APPROVAL_REQUIRED');
    expect(draft.sends).toEqual([]);
    const optedOut = fixture({ optedIn: false });
    await approveOrSkipReminder(optedOut.deps, { organizationId: 'org-a', reminderId: 'reminder-1', decision: 'APPROVED' }, actor);
    await expect(sendApprovedReminder(optedOut.deps, { organizationId: 'org-a', reminderId: 'reminder-1' }, actor)).rejects.toThrow('OPT_IN_REQUIRED');
    expect(optedOut.db.optedIn).toHaveBeenCalledWith('org-a', 'customer-1');
    expect(optedOut.sends).toEqual([]);
  });

  it('is idempotent on repeated approval and send requests', async () => {
    const state = fixture();
    const approve = () => approveOrSkipReminder(state.deps, { organizationId: 'org-a', reminderId: 'reminder-1', decision: 'APPROVED' }, actor);
    await approve();
    await expect(approve()).rejects.toThrow('REMINDER_NOT_DRAFT');
    const send = () => sendApprovedReminder(state.deps, { organizationId: 'org-a', reminderId: 'reminder-1' }, actor);
    await send();
    await expect(send()).rejects.toThrow('APPROVAL_REQUIRED');
    expect(state.sends).toHaveLength(1);
    expect(state.audits).toHaveLength(2);
  });

  it('audits each AI draft with tenant, actor, model, tier, and safe output', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'Take 10 mg twice a day. Please contact the pharmacy.', usage: { inputTokens: 12, outputTokens: 8 } } as never);
    const audit = vi.fn<ReminderDependencies['audit']>(async () => undefined);
    const result = await draftReminderText({ organizationId: 'org-a', actorId: 'owner-1', customerFirstName: 'Ayesha', medicineName: 'Example medicine', audit });
    expect(routeAI).toHaveBeenCalledWith(expect.objectContaining({ feature: 'pharmacy-refill-reminders', organizationId: 'org-a', tier: 'standard' }));
    expect(result).toBe('Please contact the pharmacy.');
    expect(audit).toHaveBeenCalledWith({ actorId: 'owner-1', organizationId: 'org-a', action: 'refill.ai_draft', old: null, new: { draftText: 'Please contact the pharmacy.' }, model: 'stub-model-v1', tier: 'standard' });
  });
});
