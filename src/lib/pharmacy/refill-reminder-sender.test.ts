import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  status: 'CAPTURED',
  reason: null as string | null,
  organizationId: 'org_a',
  branchId: 'branch_a',
  executions: [] as Array<{ sql: string; values: unknown[] }>,
  tenantCalls: [] as string[],
}));

vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes('ORDER BY "reminderAt"')) {
        return state.status === 'CAPTURED'
          ? [{ id: 'capture_a', organizationId: state.organizationId, branchId: state.branchId }]
          : [];
      }
      return state.status === 'CAPTURED'
        ? [{
            id: 'capture_a', patientId: 'patient_a',
            reminderAt: new Date('2026-10-22T00:00:00.000Z'), reason: state.reason,
          }]
        : [];
    },
    $executeRaw: async (query: { sql: string; values: unknown[] }) => {
      state.executions.push(query);
      if (query.sql.includes('SET "status" = \'QUEUED\'')) state.status = 'QUEUED';
      if (query.sql.includes('SET "status" = \'SKIPPED\'')) state.status = 'SKIPPED';
      return 1;
    },
  };
  return {
    withPlatformDb: (run: (value: unknown) => unknown) => run(db),
    withTenantDb: (organizationId: string, run: (value: unknown) => unknown) => {
      state.tenantCalls.push(organizationId);
      return run(db);
    },
  };
});

import { queueDueRefillReminders, refillReminderPayload } from './refill-reminder-sender';

beforeEach(() => {
  state.status = 'CAPTURED';
  state.reason = null;
  state.organizationId = 'org_a';
  state.branchId = 'branch_a';
  state.executions = [];
  state.tenantCalls = [];
});

describe('refill reminder transactional queue', () => {
  it('selects a due capture, queues it once, and re-enters its tenant context', async () => {
    await expect(queueDueRefillReminders({ now: new Date('2026-10-23T00:00:00Z') }))
      .resolves.toEqual({ scanned: 1, queued: 1, skipped: 0, duplicate: 0 });
    await expect(queueDueRefillReminders({ now: new Date('2026-10-23T00:00:00Z') }))
      .resolves.toEqual({ scanned: 0, queued: 0, skipped: 0, duplicate: 0 });
    expect(state.tenantCalls).toEqual(['org_a']);
    expect(state.executions.some((query) => query.sql.includes('pharmacy_message_logs'))).toBe(true);
  });

  it.each(['CONSENT_MISSING', 'CONSENT_REVOKED', 'PATIENT_OPTED_OUT'])(
    'marks the capture skipped for %s without creating an outbox row',
    async (reason) => {
      state.reason = reason;
      await expect(queueDueRefillReminders()).resolves.toMatchObject({ skipped: 1, queued: 0 });
      expect(state.executions.some((query) => query.sql.includes('pharmacy_message_logs'))).toBe(false);
      expect(state.executions.flatMap((query) => query.values)).toContain(reason);
    }
  );

  it('binds organization and branch to the locked eligibility read', async () => {
    state.organizationId = 'tenant_b';
    state.branchId = 'branch_b';
    await queueDueRefillReminders();
    expect(state.tenantCalls).toEqual(['tenant_b']);
  });

  it('keeps clinical PHI out of the bilingual transactional payload', () => {
    const payload = refillReminderPayload(new Date('2026-10-23T12:00:00Z'));
    const serialized = JSON.stringify(payload);
    expect(payload).toMatchObject({
      locale: 'en_UR',
      parameters: { reminderDate: '2026-10-23', optOutKeyword: 'STOP REFILL' },
    });
    expect(serialized).not.toMatch(/patient|medicine|dosage|direction|name|phone/i);
  });
});
