/**
 * @vitest-environment node
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing at a disposable, migrated PostgreSQL
 * database.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const organizationId = `project_dates_${suffix}`;
const projectId = `project_dates_project_${suffix}`;
let client: pg.Client;

describeIfDatabase('project date range database constraint', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
       VALUES ($1, $1, $1, $1, now())`,
      [organizationId]
    );
    await client.query(
      `INSERT INTO projects (id, "organizationId", name, type, "startDate", "endDate", "updatedAt")
       VALUES ($1, $2, 'Date constraint', 'INTERNAL', '2026-10-10', '2026-10-20', now())`,
      [projectId, organizationId]
    );
  });

  beforeEach(async () => {
    await client.query(
      `UPDATE projects SET "startDate" = '2026-10-10', "endDate" = '2026-10-20' WHERE id = $1`,
      [projectId]
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await client.end();
  });

  it('rejects an invalid range regardless of interleaved application validation', async () => {
    await client.query(`UPDATE projects SET "startDate" = '2026-10-15' WHERE id = $1`, [projectId]);

    await expect(
      client.query(`UPDATE projects SET "endDate" = '2026-10-12' WHERE id = $1`, [projectId])
    ).rejects.toMatchObject({ constraint: 'projects_date_range_check' });

    const result = await client.query<{ startDate: Date; endDate: Date }>(
      `SELECT "startDate", "endDate" FROM projects WHERE id = $1`,
      [projectId]
    );
    expect(result.rows[0]?.startDate.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(result.rows[0]?.endDate.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('allows equal dates and either nullable bound', async () => {
    await expect(
      client.query(
        `UPDATE projects SET "startDate" = '2026-10-20', "endDate" = '2026-10-20' WHERE id = $1`,
        [projectId]
      )
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      client.query(`UPDATE projects SET "startDate" = NULL WHERE id = $1`, [projectId])
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      client.query(
        `UPDATE projects SET "startDate" = '2026-10-21', "endDate" = NULL WHERE id = $1`,
        [projectId]
      )
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
