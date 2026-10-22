import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  status: 'CAPTURED',
  reason: null as string | null,
  organizationId: 'org_a',
  branchId: 'branch_a',
  outboxConflict: false,
  outboxWrites: 0,
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  executions: [] as Array<{ sql: string; values: unknown[] }>,
  tenantCalls: [] as string[],
}));

vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      state.queries.push(query);
      if (query.sql.includes('ORDER BY "reminderAt"')) {
        return state.status === 'CAPTURED'
          ? [{
              id: 'capture_a', organizationId: state.organizationId,
              branchId: state.branchId, patientId: 'patient_a',
            }]
          : [];
      }
      if (query.sql.includes('INSERT INTO "pharmacy_message_logs"')) {
        if (state.outboxConflict) return [];
        state.outboxWrites++;
        return [{ id: 'message_a' }];
      }
      if (query.sql.includes('FROM "pharmacy_patients"')) return [{ id: 'patient_a' }];
      return state.status === 'CAPTURED'
        ? [{
            id: 'capture_a', patientId: 'patient_a',
            reminderAt: new Date('2026-10-22T00:00:00.000Z'), reason: state.reason,
          }]
        : [];
    },
    $executeRaw: async (query: { sql: string; values: unknown[] }) => {
      state.executions.push(query);
      const correctBranch = query.values.includes(state.branchId);
      if (correctBranch && query.sql.includes('SET "status" = \'QUEUED\'')) state.status = 'QUEUED';
      if (correctBranch && query.sql.includes('SET "status" = \'SKIPPED\'')) state.status = 'SKIPPED';
      if (correctBranch && query.sql.includes('SET "status" = \'SENT\'')) state.status = 'SENT';
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

import {
  markRefillReminderSent,
  queueDueRefillReminders,
  refillReminderPayload,
  setRefillReminderPreference,
} from './refill-reminder-sender';

beforeEach(() => {
  state.status = 'CAPTURED';
  state.reason = null;
  state.organizationId = 'org_a';
  state.branchId = 'branch_a';
  state.outboxConflict = false;
  state.outboxWrites = 0;
  state.queries = [];
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
    expect(state.outboxWrites).toBe(1);
  });

  it.each(['CONSENT_MISSING', 'CONSENT_REVOKED', 'PATIENT_OPTED_OUT', 'BRANCH_UNAVAILABLE'])(
    'marks the capture skipped for %s without creating an outbox row',
    async (reason) => {
      state.reason = reason;
      await expect(queueDueRefillReminders()).resolves.toMatchObject({ skipped: 1, queued: 0 });
      expect(state.outboxWrites).toBe(0);
      expect(state.executions.flatMap((query) => query.values)).toContain(reason);
    }
  );

  it('binds organization and branch to the locked eligibility read', async () => {
    state.organizationId = 'tenant_b';
    state.branchId = 'branch_b';
    await queueDueRefillReminders();
    expect(state.tenantCalls).toEqual(['tenant_b']);
    const eligibilityRead = state.queries.find((query) =>
      query.sql.includes('FROM "pharmacy_refill_reminder_captures" c')
    );
    expect(eligibilityRead?.values).toEqual(expect.arrayContaining(['tenant_b', 'branch_b']));
  });

  it('does not queue a capture when its outbox claim conflicts', async () => {
    state.outboxConflict = true;
    await expect(queueDueRefillReminders()).resolves.toMatchObject({ duplicate: 1, queued: 0 });
    expect(state.status).toBe('CAPTURED');
  });

  it('does not mark a queued capture sent through another branch', async () => {
    state.status = 'QUEUED';
    const db = {
      $executeRaw: async (query: { values: unknown[] }) => {
        if (query.values.includes(state.branchId)) state.status = 'SENT';
        return Number(query.values.includes(state.branchId));
      },
    };
    await markRefillReminderSent(db as never, 'org_a', 'branch_b', 'capture_a');
    expect(state.status).toBe('QUEUED');
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

  it('writes the refill-only preference with tenant and patient predicates', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
        queries.push(query);
        return [{ id: 'patient_a' }];
      }),
      $executeRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
        queries.push(query);
        return 1;
      }),
    };

    await setRefillReminderPreference(db as never, {
      organizationId: 'org_a',
      patientId: 'patient_a',
      optedOut: true,
      source: 'STAFF',
      actorUserId: 'staff_a',
      now: new Date('2026-10-23T12:00:00Z'),
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain('"organizationId" =');
    expect(queries[0]?.sql).toContain('"id" =');
    expect(queries[0]?.values).toEqual(['org_a', 'patient_a']);
    expect(queries[1]?.sql).toContain('ON CONFLICT ("organizationId", "patientId")');
    expect(queries[1]?.values).toEqual(expect.arrayContaining([
      'org_a', 'patient_a', true, 'STAFF', 'staff_a', new Date('2026-10-23T12:00:00Z'),
    ]));
  });

  it('records one tenant-scoped outbox audit row before advancing the capture', async () => {
    await queueDueRefillReminders({ now: new Date('2026-10-23T00:00:00Z') });

    expect(state.outboxWrites).toBe(1);
    const outboxInsert = state.queries.find((query) =>
      query.sql.includes('INSERT INTO "pharmacy_message_logs"')
    );
    expect(outboxInsert?.values).toEqual(expect.arrayContaining([
      'org_a', 'branch_a', 'capture_a', 'refill-capture:capture_a',
    ]));
    expect(state.status).toBe('QUEUED');
    await queueDueRefillReminders({ now: new Date('2026-10-23T00:00:00Z') });
    expect(state.outboxWrites).toBe(1);
  });
});
