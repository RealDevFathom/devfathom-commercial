import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  status: 'CAPTURED',
  reason: null as string | null,
  organizationId: 'org_a',
  branchId: 'branch_a',
  outboxConflict: false,
  outboxWrites: 0,
  executions: [] as Array<{ sql: string; values: unknown[] }>,
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  tenantCalls: [] as string[],
}));

vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      state.queries.push(query);
      if (query.sql.includes('ORDER BY "reminderAt"')) {
        return state.status === 'CAPTURED'
          ? [
              {
                id: 'capture_a',
                organizationId: state.organizationId,
                branchId: state.branchId,
                patientId: 'patient_a',
              },
            ]
          : [];
      }
      if (query.sql.includes('INSERT INTO "pharmacy_message_logs"')) {
        if (state.outboxConflict) return [];
        state.outboxWrites++;
        return [{ id: 'message_a' }];
      }
      if (query.sql.includes('FROM "pharmacy_patients"')) return [{ id: 'patient_a' }];
      return state.status === 'CAPTURED'
        ? [
            {
              id: 'capture_a',
              patientId: 'patient_a',
              reminderAt: new Date('2026-10-22T00:00:00.000Z'),
              reason: state.reason,
            },
          ]
        : [];
    },
    $executeRaw: async (query: { sql: string; values: unknown[] }) => {
      state.executions.push(query);
      const correctBranch = query.values.includes(state.branchId);
      if (correctBranch && query.sql.includes('SET "status" = \'QUEUED\'')) state.status = 'QUEUED';
      if (correctBranch && query.sql.includes('SET "status" = \'SKIPPED\''))
        state.status = 'SKIPPED';
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

/**
 * The value bound to `column = $n` in a statement, read from the PostgreSQL
 * text of the Prisma `Sql` object (whitespace-insensitive).
 */
function bound(query: { sql: string; values: unknown[] }, column: string) {
  const text = (query as { text?: string }).text ?? '';
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped} = \\$(\\d+)\\b`).exec(flat(text));
  return match ? query.values[Number(match[1]) - 1] : undefined;
}

function flat(sql: string) {
  return sql.replace(/\s+/g, ' ');
}

beforeEach(() => {
  state.status = 'CAPTURED';
  state.reason = null;
  state.organizationId = 'org_a';
  state.branchId = 'branch_a';
  state.outboxConflict = false;
  state.outboxWrites = 0;
  state.executions = [];
  state.queries = [];
  state.tenantCalls = [];
});

describe('refill reminder transactional queue', () => {
  it('selects a due capture, queues it once, and re-enters its tenant context', async () => {
    await expect(
      queueDueRefillReminders({ now: new Date('2026-10-23T00:00:00Z') })
    ).resolves.toEqual({ scanned: 1, queued: 1, skipped: 0, duplicate: 0 });
    await expect(
      queueDueRefillReminders({ now: new Date('2026-10-23T00:00:00Z') })
    ).resolves.toEqual({ scanned: 0, queued: 0, skipped: 0, duplicate: 0 });
    expect(state.tenantCalls).toEqual(['org_a']);
    expect(state.outboxWrites).toBe(1);
  });

  it.each(['CONSENT_MISSING', 'CONSENT_REVOKED', 'PATIENT_OPTED_OUT'])(
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
  });

  it.each([null, 'PATIENT_OPTED_OUT'])(
    'binds both organization and branch in every lock, read and update (reason %s)',
    async (reason) => {
      state.organizationId = 'org_bound';
      state.branchId = 'branch_bound';
      state.reason = reason;
      await queueDueRefillReminders();
      const lock = state.queries.find((query) => query.sql.includes('FOR UPDATE OF p, b'));
      const read = state.queries.find((query) => query.sql.includes('FOR UPDATE OF c'));
      const updates = state.executions.filter((query) =>
        query.sql.includes('UPDATE "pharmacy_refill_reminder_captures"')
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]!.sql).toContain(reason ? `"status" = 'SKIPPED'` : `"status" = 'QUEUED'`);
      // Each statement compares the tenant and the branch columns to bound
      // parameters carrying exactly this capture's organization and branch.
      for (const [query, organizationColumn, branchColumn] of [
        [lock, 'p."organizationId"', 'b."id"'],
        [read, 'c."organizationId"', 'c."branchId"'],
        [updates[0], '"organizationId"', '"branchId"'],
      ] as const) {
        expect(bound(query!, organizationColumn)).toBe('org_bound');
        expect(bound(query!, branchColumn)).toBe('branch_bound');
      }
      // The lock joins the branch inside the same tenant, not by id alone.
      expect(flat(lock!.sql)).toContain('b."organizationId" = p."organizationId"');
    }
  );

  it('does not queue a capture when its outbox claim conflicts', async () => {
    state.outboxConflict = true;
    await expect(queueDueRefillReminders()).resolves.toMatchObject({ duplicate: 1, queued: 0 });
    expect(state.status).toBe('CAPTURED');
  });

  it('marks a capture sent only against its own accepted outbox log', async () => {
    const executions: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      $executeRaw: async (query: { sql: string; values: unknown[] }) => {
        executions.push(query);
        return 1;
      },
    };
    const sentAt = new Date('2026-10-23T09:00:00.000Z');
    await markRefillReminderSent(db as never, {
      organizationId: 'org_a',
      branchId: 'branch_a',
      captureId: 'capture_a',
      messageLogId: 'log_a',
      providerMessageId: 'wamid.a',
      sentAt,
    });
    const [update] = executions;
    for (const [column, value] of [
      ['c."organizationId"', 'org_a'],
      ['c."branchId"', 'branch_a'],
      ['c."id"', 'capture_a'],
      ['l."id"', 'log_a'],
      ['l."providerMessageId"', 'wamid.a'],
    ] as const) {
      expect(bound(update!, column)).toBe(value);
    }
    // The log must be the capture's own claim, in the same tenant and branch,
    // and in a state the provider accepted.
    for (const clause of [
      `c."status" = 'QUEUED'`,
      'l."organizationId" = c."organizationId"',
      'l."branchId" = c."branchId"',
      'l."refillCaptureId" = c."id"',
      `l."dedupeKey" = 'refill-capture:' || c."id"`,
      `l."status" IN ('SENT', 'DELIVERED', 'READ')`,
    ]) {
      expect(flat(update!.sql)).toContain(clause);
    }
  });

  it('orders a keyword preference write against the stored decision', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      $queryRaw: async (query: { sql: string; values: unknown[] }) => {
        queries.push(query);
        return query.sql.includes('RETURNING') ? [] : [{ id: 'patient_a' }];
      },
    };
    const input = {
      organizationId: 'org_a',
      patientId: 'patient_a',
      optedOut: true,
      source: 'KEYWORD' as const,
      now: new Date('2026-10-23T09:00:00.000Z'),
    };
    await expect(
      setRefillReminderPreference(db as never, { ...input, ordered: true })
    ).resolves.toBe(false);
    expect(flat(queries[1]!.sql)).toContain(
      'WHERE pref."changedAt" < EXCLUDED."changedAt" OR (pref."changedAt" = EXCLUDED."changedAt" AND EXCLUDED."optedOut")'
    );
    await setRefillReminderPreference(db as never, input);
    expect(queries[3]!.sql).not.toContain('WHERE pref."changedAt"');
    // Both lock the patient row inside the tenant first.
    expect(bound(queries[0]!, '"organizationId"')).toBe('org_a');
    expect(bound(queries[0]!, '"id"')).toBe('patient_a');
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
