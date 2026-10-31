import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, test } from 'vitest';

import { AGENCY_E2E } from './agency-e2e/agency-fixture';

const seed = readFileSync(resolve('scripts/seed-agency-e2e.ts'), 'utf8');
const runner = readFileSync(resolve('scripts/run-agency-e2e.ts'), 'utf8');
const preflight = readFileSync(resolve('scripts/preflight-agency-e2e.ts'), 'utf8');
const fixture = readFileSync(resolve('tests/agency-e2e/agency-fixture.ts'), 'utf8');

describe('Agency E2E owned fixture restoration', () => {
  test('uses exact owned IDs and restores the seed twice before execution', () => {
    expect(fixture).toContain("organizationId: 'org_agency_e2e_owned'");
    expect(fixture).toContain("clientId: 'client_agency_e2e_owned'");
    expect(fixture).toContain("taskId: 'task_agency_e2e_owned'");
    expect(seed).not.toMatch(/update:\s*\{\s*\}/);
    expect(runner.match(/seed-agency-e2e\.ts/g)).toHaveLength(2);
  });

  test('runs the database safety checks from a caught async entry point', () => {
    expect(seed).toContain('async function main()');
    expect(seed).toMatch(/main\(\)\.catch\(\(error: unknown\) => \{/);
    expect(seed).toContain('console.error(error)');
    expect(seed).toContain('process.exitCode = 1');
    expect(preflight).toContain('async function main()');
    expect(preflight).toMatch(/main\(\)\.catch\(\(error: unknown\) => \{/);
    expect(preflight).toContain('process.exitCode = 1');
    expect(preflight).toContain('LOGIN NOSUPERUSER NOBYPASSRLS');
    expect(preflight).toContain('canonical disposable target');
    expect(preflight).toContain('await pool.end()');
  });

  test.each([
    'organization',
    'user',
    'client',
    'project',
    'board',
    'column',
    'task',
    'meeting',
    'invoice',
    'transaction',
  ])('restores mutable %s values by upsert', (model) => {
    const upsertBody = seed.split(`tx.${model}.upsert({`)[1]?.split('});')[0];
    expect(upsertBody).toMatch(/update: \{/);
  });
});

const agencyDatabaseUrl = process.env.AGENCY_E2E_SEED_TEST_DATABASE_URL;
const describeAgencyDatabase = agencyDatabaseUrl ? describe : describe.skip;

describeAgencyDatabase('Agency E2E seed entitlements (real PostgreSQL)', () => {
  test('licenses effective Notes package access for both seeded organizations', async () => {
    const target = new URL(agencyDatabaseUrl!);
    if (
      !['127.0.0.1', 'localhost'].includes(target.hostname) ||
      !/(?:^|[_-])(test|e2e|disposable)(?:[_-]|$)/i.test(target.pathname)
    ) {
      throw new Error('Agency seed evidence requires a disposable loopback database.');
    }

    const result = spawnSync('bunx', ['tsx', 'scripts/seed-agency-e2e.ts'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        AGENCY_E2E: '1',
        AGENCY_E2E_DATABASE_URL: agencyDatabaseUrl,
        DATABASE_URL: agencyDatabaseUrl,
        TEST_DATABASE_URL: agencyDatabaseUrl,
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const client = new pg.Client({ connectionString: agencyDatabaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.is_platform_admin', 'true', true), set_config('app.current_organization_id', '', true)`
      );
      const evidence = await client.query<{
        organizationId: string;
        packageActive: boolean;
        moduleActive: boolean;
        enabled: boolean;
        hasOverride: boolean;
      }>(
        `SELECT o.id AS "organizationId", p.active AS "packageActive",
                m.active AS "moduleActive", pm.enabled,
                EXISTS (
                  SELECT 1 FROM organization_modules om
                   WHERE om."organizationId" = o.id AND om."moduleId" = m.id
                ) AS "hasOverride"
           FROM organizations o
           JOIN platform_packages p ON p.id = o."packageId"
           JOIN platform_package_modules pm ON pm."packageId" = p.id
           JOIN platform_modules m ON m.id = pm."moduleId"
          WHERE o.id = ANY($1::text[]) AND m.key = 'notes'
          ORDER BY o.id`,
        [[AGENCY_E2E.alternateOrganizationId, AGENCY_E2E.organizationId]]
      );
      expect(evidence.rows).toEqual([
        {
          organizationId: AGENCY_E2E.alternateOrganizationId,
          packageActive: true,
          moduleActive: true,
          enabled: true,
          hasOverride: false,
        },
        {
          organizationId: AGENCY_E2E.organizationId,
          packageActive: true,
          moduleActive: true,
          enabled: true,
          hasOverride: false,
        },
      ]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }, 60_000);
});
