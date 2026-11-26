// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';

it('installs receipt history without scanning or rewriting pre-feature commands', () => {
  const sql = readFileSync(
    'prisma/migrations/20261126050000_offline_receipt_reviews/migration.sql',
    'utf8'
  );
  expect(sql).not.toMatch(/\bpharmacy_offline_commands\b|app\.is_platform_admin/);
});

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

it.runIf(url)(
  'exposes an offline refusal only in its organization and branch and preserves the original evidence',
  async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    const org = randomUUID();
    const branch = randomUUID();
    const device = randomUUID();
    const setScope = (organization: string, location: string) =>
      client.query(
        "SELECT set_config('app.current_organization_id',$1,true),set_config('app.current_branch_id',$2,true)",
        [organization, location]
      );
    const listed = () =>
      client.query('SELECT reason FROM pharmacy_offline_receipt_events WHERE id=$1', [device]);
    try {
      await client.query('BEGIN');
      await setScope(org, branch);
      await client.query(
        `INSERT INTO pharmacy_branches(id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
      VALUES($1,$2,$1,'Test branch','Fixture','Lahore','PB',now())`,
        [branch, org]
      );
      const limit = await client.query(
        'SELECT "offlineReconnectHours" AS hours FROM pharmacy_branches WHERE id=$1',
        [branch]
      );
      expect(limit.rows).toEqual([{ hours: 72 }]);
      await client.query('UPDATE pharmacy_branches SET "offlineReconnectHours"=4 WHERE id=$1', [
        branch,
      ]);
      await client.query('SAVEPOINT reconnect_limit');
      await expect(
        client.query('UPDATE pharmacy_branches SET "offlineReconnectHours"=73 WHERE id=$1', [
          branch,
        ])
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT reconnect_limit');
      await client.query(
        `INSERT INTO pharmacy_registered_devices(id,"organizationId","branchId",name,"deviceSecretHash","enrolledByActorId","updatedAt")
      VALUES($1,$2,$3,'Counter',encode(sha256(convert_to($1,'UTF8')),'hex'),'fixture',now())`,
        [device, org, branch]
      );
      await client.query(
        `INSERT INTO pharmacy_offline_receipt_events(id,"organizationId","branchId","deviceId","commandKey",sequence,"receiptNumber",kind,reason,"commandHash",evidence)
      VALUES($1,$2,$3,$1,$1,1,10,'REFUSED','DAY_CLOSED','fixture','{}')`,
        [device, org, branch]
      );
      expect((await listed()).rows).toEqual([{ reason: 'DAY_CLOSED' }]);
      await setScope(org, randomUUID());
      expect((await listed()).rows).toEqual([]);
      await setScope(randomUUID(), branch);
      expect((await listed()).rows).toEqual([]);
      await setScope(org, branch);
      await expect(
        client.query('UPDATE pharmacy_offline_receipt_events SET reason=$1 WHERE id=$2', [
          'replacement',
          device,
        ])
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  }
);
