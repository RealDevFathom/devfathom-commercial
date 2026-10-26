/**
 * @vitest-environment node
 *
 * Exercises resignation offboarding against a real migrated PostgreSQL database.
 * Requires TEST_DATABASE_URL to point at a disposable database; without it the
 * suite is explicitly skipped rather than using the application's DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';

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
    await client.query(
      `INSERT INTO resignations
         (id, "organizationId", "userId", reason, "proposedLastDay", status, "lastWorkingDay", "updatedAt")
       VALUES
         ($1, $9, $5, 'Due', $10, 'APPROVED', $10, now()),
         ($2, $9, $6, 'Future', $11, 'APPROVED', $11, now()),
         ($3, $9, $7, 'Pending', $10, 'PENDING', NULL, now()),
         ($4, $12, $8, 'Wrong tenant', $10, 'APPROVED', $10, now()),
         ($13, $9, $14, 'Declined', $10, 'DECLINED', $10, now()),
         ($15, $9, $16, 'Withdrawn', $10, 'WITHDRAWN', $10, now()),
         ($17, $9, $18, 'No confirmed day', $10, 'APPROVED', NULL, now())`,
      [
        id('resignation_due'),
        id('resignation_future'),
        id('resignation_pending'),
        id('resignation_cross_tenant'),
        id('due'),
        id('future'),
        id('pending'),
        id('cross_tenant'),
        org('primary'),
        cutoff,
        new Date(cutoff.getTime() + 1),
        org('foreign'),
        id('resignation_declined'),
        id('declined'),
        id('resignation_withdrawn'),
        id('withdrawn'),
        id('resignation_null_day'),
        id('null_day'),
      ]
    );

    ({ processDueResignationOffboarding } = await import('./resignation-offboarding'));
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
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
  });
});
