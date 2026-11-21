/**
 * DEV-1004: a bill-line change looks up the record its request key already made, and a cash
 * shift's report counts the lines taken off bills in the shift. Both read a key inside a sale
 * event's payload; migration 20261118127000 indexes exactly the expressions the application
 * queries (src/lib/pharmacy/sales.ts lineChangeRecord, src/lib/pharmacy/cash-shifts.ts
 * readShiftFigures). Checked with the generic plan a prepared statement gets, as the restricted
 * runtime role under row-level security. Skipped (never silently passed) without the database URL.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';

/** Every index the plan of `sql` reads, with sequential scans off and a generic plan. */
async function indexesUsed(client: pg.Client, sql: string, values: string[]) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL plan_cache_mode = force_generic_plan');
    await client.query(`PREPARE dev1004_probe(text, text, text) AS ${sql}`);
    const [{ 'QUERY PLAN': plan }] = (
      await client.query(
        `EXPLAIN (FORMAT JSON) EXECUTE dev1004_probe(${values.map((value) => `'${value}'`).join(', ')})`
      )
    ).rows;
    const names: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (typeof node['Index Name'] === 'string') names.push(node['Index Name']);
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk((plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
    return names;
  } finally {
    await client.query('ROLLBACK');
    // A prepared statement outlives the transaction.
    await client.query('DEALLOCATE ALL');
  }
}

(runtimeUrl ? describe : describe.skip)('DEV-1004 sale event payload indexes', () => {
  const client = new pg.Client({ connectionString: runtimeUrl });

  beforeAll(async () => {
    assertDisposableRlsDatabase(runtimeUrl);
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query("SELECT set_config('app.current_organization_id', 'org_dev1004', false)");
  });

  afterAll(async () => {
    await client.end();
  });

  it('finds a line change by its request key through its own index', async () => {
    expect(
      await indexesUsed(
        client,
        `SELECT "saleId", "payload" FROM "pharmacy_sale_events"
          WHERE "organizationId" = $1 AND "branchId" = $2
            AND "kind" = 'CREATED' AND ("payload"->>'lineChangeKey') = $3
          LIMIT 1`,
        ['org_dev1004', 'branch_dev1004', 'counter:line-change:1']
      )
    ).toContain('pharmacy_sale_events_line_change_key_idx');
  });

  it("finds a shift's line voids through their own index", async () => {
    expect(
      await indexesUsed(
        client,
        `SELECT "payload" FROM "pharmacy_sale_events"
          WHERE "organizationId" = $1 AND "branchId" = $2
            AND "kind" = 'VOIDED' AND ("payload"->>'shiftId') = $3`,
        ['org_dev1004', 'branch_dev1004', 'shift_dev1004']
      )
    ).toContain('pharmacy_sale_events_void_shift_idx');
  });
});
