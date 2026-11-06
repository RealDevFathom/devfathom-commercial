/**
 * @vitest-environment node
 *
 * Exercises resignation offboarding against a real migrated PostgreSQL database.
 * Requires TEST_DATABASE_URL to point at a disposable database; without it the
 * suite is explicitly skipped rather than using the application's DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const org = (name: string) => `offboarding_${name}_${suffix}`;
const id = (name: string) => `offboarding_${name}_${suffix}`;
const cutoff = new Date('2026-10-26T12:00:00.000Z');

let client: pg.Client;
let processDueResignationOffboarding: (now?: Date) => Promise<{ offboarded: number }>;

describeIfDatabase('resignation offboarding, against PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);

    for (const organizationId of [org('primary'), org('foreign')]) {
      await client.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, $1, $1, now())`,
        [organizationId]
      );
      await client.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'OPS', 'Operations', now())`,
        [id(`department_${organizationId}`), organizationId]
      );
    }

    await client.query(
      `INSERT INTO users
         (id, "organizationId", name, email, role, department, title, status, "tokenVersion", "updatedAt")
       VALUES
         ($1, $5, 'Due', $1 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Staff', 'ACTIVE', 4, now()),
         ($2, $5, 'Future', $2 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Staff', 'ACTIVE', 7, now()),
         ($3, $5, 'Pending', $3 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Staff', 'ACTIVE', 9, now()),
         ($4, $5, 'Cross tenant', $4 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Staff', 'ACTIVE', 11, now()),
         ($6, $5, 'Declined', $6 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Staff', 'ACTIVE', 13, now()),
         ($7, $5, 'Withdrawn', $7 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Staff', 'ACTIVE', 15, now()),
         ($8, $5, 'No confirmed day', $8 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Staff', 'ACTIVE', 17, now())`,
      [
        id('due'),
        id('future'),
        id('pending'),
        id('cross_tenant'),
        org('primary'),
        id('declined'),
        id('withdrawn'),
        id('null_day'),
      ]
    );
    for (const [name, status, day] of [
      ['due', 'APPROVED', cutoff],
      ['future', 'APPROVED', new Date(cutoff.getTime() + 1)],
      ['pending', 'PENDING', null],
      ['declined', 'DECLINED', cutoff],
      ['withdrawn', 'WITHDRAWN', cutoff],
      ['null_day', 'APPROVED', null],
    ] as const) {
      await client.query(
        `INSERT INTO resignations
           (id, "organizationId", "userId", reason, "proposedLastDay", status, "lastWorkingDay", "updatedAt")
         VALUES ($1, $2, $3, $3, $4, $5::"ResignationStatus", $6, now())`,
        [
          id(`resignation_${name}`),
          org('primary'),
          id(name),
          (day ?? cutoff).toISOString(),
          status,
          day?.toISOString() ?? null,
        ]
      );
    }

    ({ processDueResignationOffboarding } = await import('./resignation-offboarding'));
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(`DELETE FROM audit_logs WHERE "organizationId" = ANY($1::text[])`, [
      [org('primary'), org('foreign')],
    ]);
    await client.query(`DELETE FROM organizations WHERE id = ANY($1::text[])`, [
      [org('primary'), org('foreign')],
    ]);
    await client.end();
  });

  it('offboards only due approved users and is idempotent', async () => {
    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 1 });

    const firstRun = await client.query<{ id: string; status: string; tokenVersion: number }>(
      `SELECT id, status, "tokenVersion"
         FROM users
        WHERE "organizationId" = $1
        ORDER BY id`,
      [org('primary')]
    );
    expect(firstRun.rows).toEqual([
      { id: id('cross_tenant'), status: 'ACTIVE', tokenVersion: 11 },
      { id: id('declined'), status: 'ACTIVE', tokenVersion: 13 },
      { id: id('due'), status: 'INACTIVE', tokenVersion: 5 },
      { id: id('future'), status: 'ACTIVE', tokenVersion: 7 },
      { id: id('null_day'), status: 'ACTIVE', tokenVersion: 17 },
      { id: id('pending'), status: 'ACTIVE', tokenVersion: 9 },
      { id: id('withdrawn'), status: 'ACTIVE', tokenVersion: 15 },
    ]);

    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 0 });
    const repeated = await client.query<{ tokenVersion: number }>(
      `SELECT "tokenVersion" FROM users WHERE id = $1`,
      [id('due')]
    );
    expect(repeated.rows).toEqual([{ tokenVersion: 5 }]);

    await client.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [id('due')]);
    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 0 });
    const reactivated = await client.query<{ status: string; tokenVersion: number }>(
      `SELECT status, "tokenVersion" FROM users WHERE id = $1`,
      [id('due')]
    );
    expect(reactivated.rows).toEqual([{ status: 'ACTIVE', tokenVersion: 5 }]);
  });
  async function addMember(name: string, role = 'EMPLOYEE', day = cutoff) {
    await client.query(
      `INSERT INTO users
         (id, "organizationId", name, email, role, department, title, status, "tokenVersion", "updatedAt")
       VALUES ($1, $2, $1, $1 || '@test.invalid', $3::"Role", 'OPS', 'Staff', 'ACTIVE', 20, now())`,
      [id(name), org('primary'), role]
    );
    await client.query(
      `INSERT INTO resignations
         (id, "organizationId", "userId", reason, "proposedLastDay", status, "lastWorkingDay", "reviewedAt", "updatedAt")
       VALUES ($1, $2, $3, 'Approved notice', $4, 'APPROVED', $4, $5, now())`,
      [
        id(`resignation_${name}`),
        org('primary'),
        id(name),
        day.toISOString(),
        new Date(day.getTime() - 86400000).toISOString(),
      ]
    );
  }

  async function state(name: string) {
    return (
      await client.query(
        `SELECT u.status, u."tokenVersion", r."offboardedAt"
       FROM users u JOIN resignations r ON r."userId" = u.id AND r."organizationId" = u."organizationId"
       WHERE u.id = $1`,
        [id(name)]
      )
    ).rows[0];
  }

  it('rejects cross-tenant resignations at the composite foreign key', async () => {
    await expect(
      client.query(
        `INSERT INTO resignations
         (id, "organizationId", "userId", reason, "proposedLastDay", "updatedAt")
       VALUES ($1, $2, $3, 'Wrong tenant', $4, now())`,
        [id('invalid_cross_tenant'), org('foreign'), id('cross_tenant'), cutoff.toISOString()]
      )
    ).rejects.toMatchObject({ code: '23503', constraint: 'tenant_resignations_userId_users_fk' });
  });

  it('persists one tenant system audit for the status and session revocation', async () => {
    await addMember('audit');
    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 1 });
    const { rows } = await client.query(
      `SELECT "organizationId", "actorType", source, operation, "targetType", "targetId", changes, metadata
       FROM audit_logs WHERE "organizationId" = $1 AND action = 'resignations.offboard' AND "targetId" = $2`,
      [org('primary'), id('audit')]
    );
    expect(rows).toEqual([
      {
        organizationId: org('primary'),
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        operation: 'UPDATE',
        targetType: 'User',
        targetId: id('audit'),
        changes: {
          status: { before: 'ACTIVE', after: 'INACTIVE' },
          tokenVersion: { before: 20, after: 21 },
        },
        metadata: { resignationIds: [id('resignation_audit')] },
      },
    ]);
  });

  it('retains the last active admin without consuming their approval, including overlapping sweeps', async () => {
    await addMember('admin_a', 'ADMIN');
    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 0 });
    expect(await state('admin_a')).toMatchObject({
      status: 'ACTIVE',
      tokenVersion: 20,
      offboardedAt: null,
    });

    await addMember('admin_b', 'ADMIN');
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => processDueResignationOffboarding(cutoff))
    );
    expect(runs.reduce((total, run) => total + run.offboarded, 0)).toBe(1);
    expect(await state('admin_a')).toMatchObject({
      status: 'ACTIVE',
      tokenVersion: 20,
      offboardedAt: null,
    });
    expect(await state('admin_b')).toMatchObject({
      status: 'INACTIVE',
      tokenVersion: 21,
      offboardedAt: expect.any(Date),
    });

    await client.query(`UPDATE resignations SET status = 'WITHDRAWN' WHERE id = $1`, [
      id('resignation_admin_b'),
    ]);
    await client.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [id('admin_b')]);
    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 1 });
    expect(await state('admin_a')).toMatchObject({
      status: 'INACTIVE',
      offboardedAt: expect.any(Date),
    });
  });

  it('rolls back revocation and the claim if the audit cannot be persisted', async () => {
    await addMember('rollback');
    const scoped = await import('./tenancy/scoped-db');
    const withPlatformDb = scoped.withPlatformDb;
    const failAudit: typeof withPlatformDb = (run, options) =>
      withPlatformDb(async (db) => {
        const audit = vi
          .spyOn(db.auditLog, 'create')
          .mockRejectedValueOnce(new Error('audit unavailable'));
        try {
          return await run(db);
        } finally {
          audit.mockRestore();
        }
      }, options);
    const transaction = vi.spyOn(scoped, 'withPlatformDb').mockImplementation(failAudit);
    try {
      await expect(processDueResignationOffboarding(cutoff)).rejects.toThrow('audit unavailable');
      expect(await state('rollback')).toMatchObject({
        status: 'ACTIVE',
        tokenVersion: 20,
        offboardedAt: null,
      });
    } finally {
      transaction.mockRestore();
    }
    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 1 });
  });

  it('reconciles legacy offboarding without discarding the unprocessed overdue backlog', async () => {
    for (const name of [
      'legacy_router_reactivated',
      'legacy_assistant',
      'legacy_manual',
      'legacy_inactive',
      'legacy_backlog',
      'legacy_future',
    ]) {
      await addMember(name, 'EMPLOYEE', name === 'legacy_future' ? new Date('2099-01-01') : cutoff);
    }
    await client.query(
      `UPDATE resignations SET "reviewedAt" = "lastWorkingDay" WHERE id = ANY($1::text[])`,
      [[id('resignation_legacy_router_reactivated'), id('resignation_legacy_assistant')]]
    );
    // Only a tRPC router review deactivated the user at approval time; the
    // assistant tool recorded the decision without offboarding anyone.
    for (const [name, source, action] of [
      ['legacy_router_reactivated', 'TRPC', 'resignations.review'],
      ['legacy_assistant', 'SYSTEM', 'assistant.resignations.review'],
    ] as const) {
      await client.query(
        `INSERT INTO audit_logs (id, "organizationId", "actorType", source, category, operation, action, "targetType", "targetId")
         VALUES ($1, $2, 'USER', $3::"AuditSource", 'RESIGNATIONS', 'UPDATE', $4, 'Resignation', $5)`,
        [id(`${name}_review_audit`), org('primary'), source, action, id(`resignation_${name}`)]
      );
    }
    await client.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [
      id('legacy_inactive'),
    ]);
    await client.query(
      `INSERT INTO audit_logs (id, "organizationId", "actorType", source, category, operation, action, "targetType", "targetId", changes)
       VALUES ($1, $2, 'USER', 'TRPC', 'TEAM', 'UPDATE', 'team.updateMember', 'User', $3, $4::jsonb)`,
      [
        id('legacy_reactivation_audit'),
        org('primary'),
        id('legacy_manual'),
        JSON.stringify({ status: { before: 'INACTIVE', after: 'ACTIVE' } }),
      ]
    );
    const migration = await readFile(
      new URL(
        '../../prisma/migrations/20261026130000_resignation_offboarding_lifecycle/migration.sql',
        import.meta.url
      ),
      'utf8'
    );
    // Exercise the reconciliation DML on the already-migrated disposable DB.
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
    await client.query(
      migration.slice(migration.indexOf('SELECT set_config'), migration.lastIndexOf('COMMIT;'))
    );
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    for (const name of ['legacy_router_reactivated', 'legacy_manual', 'legacy_inactive']) {
      expect(await state(name)).toMatchObject({ offboardedAt: expect.any(Date) });
    }
    for (const name of ['legacy_future', 'legacy_backlog', 'legacy_assistant']) {
      expect(await state(name)).toMatchObject({ offboardedAt: null });
    }
    await expect(processDueResignationOffboarding(cutoff)).resolves.toEqual({ offboarded: 2 });
    for (const name of ['legacy_router_reactivated', 'legacy_manual']) {
      expect(await state(name)).toMatchObject({ status: 'ACTIVE', tokenVersion: 20 });
    }
    for (const name of ['legacy_backlog', 'legacy_assistant']) {
      expect(await state(name)).toMatchObject({ status: 'INACTIVE', tokenVersion: 21 });
    }
  });
});
