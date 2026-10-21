/** Executable against a disposable, migrated database with an existing tenant,
 * branch and staff fixture. No listener/bootstrap/privileged fallback is started.
 * CATERING_TEST_DATABASE_URL, CATERING_TEST_ORG_ID, CATERING_TEST_BRANCH_ID,
 * CATERING_TEST_STAFF_ID are required together. Every test rolls back its rows. */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
const url = process.env.CATERING_TEST_DATABASE_URL;
const org = process.env.CATERING_TEST_ORG_ID;
const branch = process.env.CATERING_TEST_BRANCH_ID;
const staff = process.env.CATERING_TEST_STAFF_ID;
const enabled = Boolean(url && org && branch && staff);
async function transaction(run: (client: Client) => Promise<void>) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const role = await client.query(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    await run(client);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}
async function quote(client: Client) {
  const orderId = randomUUID(),
    quoteId = randomUUID();
  await client.query(
    'INSERT INTO restaurant_catering_orders (id,"organizationId","branchId","eventName","eventDate",headcount,"updatedAt") VALUES ($1,$2,$3,$4,current_date,10,now())',
    [orderId, org, branch, 'Catering restricted-role test']
  );
  await client.query(
    'INSERT INTO restaurant_catering_quote_revisions (id,"organizationId","orderId",revision,snapshot,"contentHash","createdByStaffId") VALUES ($1,$2,$3,0,$4::jsonb,$5,$6)',
    [quoteId, org, orderId, JSON.stringify({ schemaVersion: 1 }), 'test-hash', staff]
  );
  return { orderId, quoteId };
}
describe.skipIf(!enabled)('catering restricted PostgreSQL evidence', () => {
  it('forces RLS on every new table under a non-superuser/non-bypass role', async () =>
    transaction(async (c) => {
      const result = await c.query(
        'SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
        [
          [
            'restaurant_catering_branch_capacity',
            'restaurant_catering_quote_revisions',
            'restaurant_catering_quote_approvals',
            'restaurant_catering_dispositions',
            'restaurant_catering_commands',
          ],
        ]
      );
      expect(result.rows).toHaveLength(5);
      for (const row of result.rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    }));
  it('hides quote history from another tenant and rejects a cross-tenant insert', async () =>
    transaction(async (c) => {
      const f = await quote(c);
      await c.query("SELECT set_config('app.current_organization_id',$1,true)", [`${org}_foreign`]);
      expect(
        (
          await c.query('SELECT id FROM restaurant_catering_quote_revisions WHERE id=$1', [
            f.quoteId,
          ])
        ).rows
      ).toEqual([]);
      await expect(
        c.query(
          'INSERT INTO restaurant_catering_commands ("organizationId","orderId","idempotencyKey","payloadHash",result) VALUES ($1,$2,$3,$4,$5::jsonb)',
          [org, f.orderId, 'foreign', 'hash', '{}']
        )
      ).rejects.toMatchObject({ code: '42501' });
    }));
  it('denies quote UPDATE/DELETE and same-tenant cross-order approval', async () =>
    transaction(async (c) => {
      const f = await quote(c),
        other = await quote(c);
      expect(
        (
          await c.query(
            'UPDATE restaurant_catering_quote_revisions SET "contentHash"=$1 WHERE id=$2',
            ['tampered', f.quoteId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (await c.query('DELETE FROM restaurant_catering_quote_revisions WHERE id=$1', [f.quoteId]))
          .rowCount
      ).toBe(0);
      await expect(
        c.query(
          'INSERT INTO restaurant_catering_quote_approvals (id,"organizationId","orderId","quoteRevisionId","orderRevision","actorStaffProfileId") VALUES ($1,$2,$3,$4,0,$5)',
          [randomUUID(), org, other.orderId, f.quoteId, staff]
        )
      ).rejects.toBeDefined();
    }));
  it('rolls back earlier quote/order writes when a late booking constraint fails', async () =>
    transaction(async (c) => {
      await c.query('SAVEPOINT before_work');
      const f = await quote(c);
      await expect(
        c.query(
          'UPDATE restaurant_catering_orders SET "bookingStartsAt"=now(),"bookingEndsAt"=now()-interval \'1 hour\' WHERE id=$1',
          [f.orderId]
        )
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK TO SAVEPOINT before_work');
      expect(
        (await c.query('SELECT id FROM restaurant_catering_orders WHERE id=$1', [f.orderId])).rows
      ).toEqual([]);
      expect(
        (
          await c.query('SELECT id FROM restaurant_catering_quote_revisions WHERE id=$1', [
            f.quoteId,
          ])
        ).rows
      ).toEqual([]);
    }));
});
