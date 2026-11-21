/**
 * DEV-1004: a bill-line change looks up the record its request key already made, and a cash
 * shift's report counts the lines taken off bills in the shift. Both read a key inside a sale
 * event's payload. Migration 20261118127000 adds a partial index for each, holding only the
 * events that carry the key. Under the runtime role's row-level security the payload comparison
 * is not leakproof, so PostgreSQL uses only the organisation and branch columns of the index and
 * checks the key as a filter: the property that matters is that each lookup reads the branch's
 * keyed events only, never every sale event of the branch. Checked by running each lookup, with
 * the generic plan a prepared statement gets, as the restricted runtime role over a branch with
 * many other sale events. Skipped (never silently passed) without the database URLs.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';

const prefix = `ix_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const org = `${prefix}_org`;
const branch = `${prefix}_branch`;
/** Sale events of the branch that carry neither key. */
const OTHER_EVENTS = 300;
/** Line-change CREATED events, and line-void VOIDED events, in the branch. */
const KEYED_EVENTS = 3;

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/** The executed plan of `sql`, with sequential scans off and a generic plan. */
async function executedPlan(client: pg.Client, sql: string, values: string[]) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL plan_cache_mode = force_generic_plan');
    await client.query(`PREPARE dev1004_probe(text, text, text) AS ${sql}`);
    const [{ 'QUERY PLAN': plan }] = (
      await client.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE dev1004_probe(${values.map((value) => `'${value}'`).join(', ')})`
      )
    ).rows;
    const nodes: PlanNode[] = [];
    const walk = (node: PlanNode) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk((plan as Array<{ Plan: PlanNode }>)[0]!.Plan);
    return nodes;
  } finally {
    await client.query('ROLLBACK');
    // A prepared statement outlives the transaction.
    await client.query('DEALLOCATE ALL');
  }
}

/**
 * The plan's one read of the sale events: the index it used (directly, or through a bitmap),
 * the index condition, and how many rows it looked at. Never a sequential scan.
 */
function eventScan(nodes: PlanNode[]) {
  const reads = nodes.filter((node) => node['Relation Name'] === 'pharmacy_sale_events');
  expect(reads).toHaveLength(1);
  const read = reads[0]!;
  expect(read['Node Type']).not.toBe('Seq Scan');
  // An Index Scan names its index itself; a Bitmap Heap Scan reads it through its child.
  const indexNode = read['Index Name'] ? read : nodes.find((node) => node['Index Name']);
  return {
    indexName: indexNode?.['Index Name'],
    indexCond: String(indexNode?.['Index Cond'] ?? ''),
    rowsRead:
      Number(read['Actual Rows'] ?? 0) +
      Number(read['Rows Removed by Filter'] ?? 0) +
      Number(read['Rows Removed by Index Recheck'] ?? 0),
    rowsReturned: Number(read['Actual Rows'] ?? 0),
  };
}

(runtimeUrl && ownerUrl ? describe : describe.skip)('DEV-1004 sale event payload indexes', () => {
  const client = new pg.Client({ connectionString: runtimeUrl });
  const owner = new pg.Client({ connectionString: ownerUrl });

  beforeAll(async () => {
    assertDisposableRlsDatabase(runtimeUrl);
    assertDisposableRlsDatabase(ownerUrl);
    await client.connect();
    await owner.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    // A branch with one open bill and many sale events, a few of which carry each key.
    await owner.query("SELECT set_config('app.is_platform_admin','true',false)");
    await owner.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now())`,
      [org]
    );
    await owner.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,'IX','Index','Fixture street','Lahore','PB',now())`,
      [branch, org]
    );
    // The sale tables force row-level security: rows are written as this organisation.
    await owner.query("SELECT set_config('app.current_organization_id', $1, false)", [org]);
    await owner.query(
      `INSERT INTO pharmacy_sales (id,"organizationId","branchId","createdByUserId","updatedAt") VALUES ($1,$2,$3,'fixture-user',now())`,
      [`${prefix}_sale`, org, branch]
    );
    await owner.query(
      `INSERT INTO pharmacy_sale_events (id,"organizationId","branchId","saleId",kind,"actorId",payload)
       SELECT $1 || '_other_' || n, $2, $3, $4, 'CREATED', 'fixture-user', jsonb_build_object('n', n)
         FROM generate_series(1, $5::int) AS n`,
      [prefix, org, branch, `${prefix}_sale`, OTHER_EVENTS]
    );
    await owner.query(
      `INSERT INTO pharmacy_sale_events (id,"organizationId","branchId","saleId",kind,"actorId",payload)
       SELECT $1 || '_change_' || n, $2, $3, $4, 'CREATED'::"PharmacySaleEventKind", 'fixture-user',
              jsonb_build_object('lineChangeKey', 'key-' || n)
         FROM generate_series(1, $5::int) AS n
       UNION ALL
       SELECT $1 || '_void_' || n, $2, $3, $4, 'VOIDED'::"PharmacySaleEventKind", 'fixture-user',
              jsonb_build_object('shiftId', 'shift-' || n)
         FROM generate_series(1, $5::int) AS n`,
      [prefix, org, branch, `${prefix}_sale`, KEYED_EVENTS]
    );
    await owner.query('ANALYZE pharmacy_sale_events');
    await client.query("SELECT set_config('app.current_organization_id', $1, false)", [org]);
  });

  afterAll(async () => {
    // Sale events are append-only: the disposable database keeps this fixture.
    await client.end();
    await owner.end();
  });

  it('finds a line change by its request key reading only the branch’s line-change events', async () => {
    const scan = eventScan(
      await executedPlan(
        client,
        `SELECT "saleId", "payload" FROM "pharmacy_sale_events"
          WHERE "organizationId" = $1 AND "branchId" = $2
            AND "kind" = 'CREATED' AND ("payload"->>'lineChangeKey') = $3
          LIMIT 1`,
        [org, branch, `key-${KEYED_EVENTS}`]
      )
    );
    expect(scan).toMatchObject({
      indexName: 'pharmacy_sale_events_line_change_key_idx',
      rowsReturned: 1,
    });
    expect(scan.indexCond).toMatch(/"organizationId" = \$1\).*"branchId" = \$2/);
    expect(scan.rowsRead).toBeLessThanOrEqual(KEYED_EVENTS);
  });

  it("finds a shift's line voids reading only the branch’s line-void events", async () => {
    const scan = eventScan(
      await executedPlan(
        client,
        `SELECT "payload" FROM "pharmacy_sale_events"
          WHERE "organizationId" = $1 AND "branchId" = $2
            AND "kind" = 'VOIDED' AND ("payload"->>'shiftId') = $3`,
        [org, branch, 'shift-2']
      )
    );
    expect(scan).toMatchObject({
      indexName: 'pharmacy_sale_events_void_shift_idx',
      rowsReturned: 1,
    });
    expect(scan.indexCond).toMatch(/"organizationId" = \$1\).*"branchId" = \$2/);
    expect(scan.rowsRead).toBeLessThanOrEqual(KEYED_EVENTS);
  });
});
