// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { recoverCompletedDemand } from './lost-sales-recovery';
import { captureDemand, demandAggregate } from './sales';

const url = process.env.TEST_DATABASE_URL;
const database = url ? describe : describe.skip;
const migration = readFileSync(
  new URL(
    '../../../prisma/migrations/20261029000167_pharmacy_lost_sales_capture/migration.sql',
    import.meta.url
  ),
  'utf8'
);
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'staff-a' };
const recoveryMigration = readFileSync(
  new URL('../../../prisma/migrations/20261031000000_pharmacy_demand_quantity_recovery/migration.sql', import.meta.url),
  'utf8'
);
let client: Client;
const sqlDb = () => ({
  $executeRaw: async (query: Prisma.Sql) => (await client.query(query.text, query.values)).rowCount,
  unfulfilledDemandEvent: { groupBy: async () => [] },
});

database('lost-sales migration and purchase recovery', () => {
  beforeEach(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    // Temporary fixtures work with the runtime role, require no schema-owner
    // credentials, and cannot touch the application's migrated public tables.
    await client.query(`CREATE TEMP TABLE pharmacy_branches (id text PRIMARY KEY);
      SET LOCAL search_path = pg_temp;
      CREATE TEMP TABLE pharmacy_medicines ("organizationId" text, id text, PRIMARY KEY ("organizationId", id));
      CREATE TEMP TABLE pharmacy_sales ("organizationId" text, "branchId" text, id text, status text,
        "customerId" text, "receiptDeviceId" text, "completedAt" timestamp, PRIMARY KEY ("organizationId", "branchId", id));
      CREATE TEMP TABLE pharmacy_sale_lines ("organizationId" text, "branchId" text, "saleId" text, "medicineId" text, "canonicalUnits" integer);
      CREATE TEMP TABLE pharmacy_patients ("organizationId" text, id text, PRIMARY KEY ("organizationId", id));
      CREATE TEMP TABLE pharmacy_unfulfilled_demand_events (id text PRIMARY KEY, "organizationId" text,
        "branchId" text, "saleId" text, "customerId" text, "consentRecorded" boolean DEFAULT false,
        "requestedMedicineId" text, quantity integer, status text DEFAULT 'OPEN', "capturedByUserId" text,
        "createdAt" timestamp DEFAULT now(), CHECK ("customerId" IS NULL OR "consentRecorded"),
        FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_patients("organizationId", id));
      INSERT INTO pharmacy_branches VALUES ('branch-a');
      INSERT INTO pharmacy_medicines VALUES ('org-a', 'medicine-a'), ('org-b', 'medicine-b');
      INSERT INTO pharmacy_unfulfilled_demand_events (id, "organizationId", "branchId", quantity, "capturedByUserId")
        VALUES ('legacy', 'org-a', 'branch-a', 2, 'staff-a');`);
    // PostgreSQL never resolves unqualified functions from pg_temp, even with
    // an explicit search_path. Qualify only the fixture trigger function.
    await client.query(
      migration.replaceAll(
        'pharmacy_fill_legacy_demand_capture()',
        'pg_temp.pharmacy_fill_legacy_demand_capture()'
      )
    );
    await client.query(`SELECT set_config('app.current_organization_id', 'org-a', true)`);
    await client.query(recoveryMigration);
  });
  afterEach(async () => {
    await client?.query('ROLLBACK');
    await client?.end();
  });

  it('applies against pharmacy_medicines and allows legacy closure without a bulk rewrite', async () => {
    const before = await client.query(
      `SELECT "visitId" FROM pharmacy_unfulfilled_demand_events WHERE id = 'legacy'`
    );
    expect(before.rows[0].visitId).toBeNull();
    const updated = await client.query(
      `UPDATE pharmacy_unfulfilled_demand_events SET status = 'CLOSED' WHERE id = 'legacy' RETURNING *`
    );
    expect(updated.rows[0]).toMatchObject({
      status: 'CLOSED',
      requestedQty: 2,
      visitId: 'legacy:legacy',
      terminalId: 'operator:staff-a',
    });
  });

  it('continues to require complete capture fields for new events', async () => {
    await expect(
      client.query(`INSERT INTO pharmacy_unfulfilled_demand_events (id, "organizationId", "branchId", quantity)
      VALUES ('incomplete', 'org-a', 'branch-a', 1)`)
    ).rejects.toMatchObject({ code: '23514', constraint: 'pharmacy_demand_capture_fields_check' });
  });

  it('keeps substitute product foreign keys tenant scoped', async () => {
    await expect(
      client.query(`INSERT INTO pharmacy_unfulfilled_demand_events
      (id, "organizationId", "branchId", quantity, "visitId", "visitType", "requestedQty", "terminalId", "substituteProductId")
      VALUES ('foreign-product', 'org-a', 'branch-a', 1, 'visit-a', 'WALK_OUT', 1, 'terminal-a', 'medicine-b')`)
    ).rejects.toMatchObject({ code: '23503', constraint: 'pharmacy_demand_substitute_product_fk' });
  });

  async function seedRecovery() {
    await client.query(`INSERT INTO pharmacy_sales VALUES
      ('org-a', 'branch-a', 'origin', 'VOID', 'loyalty-a', 'terminal-a', NULL),
      ('org-a', 'branch-a', 'purchase', 'OPEN', 'loyalty-a', 'terminal-a', NULL);
      INSERT INTO pharmacy_sale_lines VALUES ('org-a', 'branch-a', 'purchase', 'medicine-a', 3);
      INSERT INTO pharmacy_unfulfilled_demand_events
        (id, "organizationId", "branchId", "saleId", "requestedMedicineId", quantity, "visitId", "visitType",
         "requestedQty", "terminalId", outcome, "unitPricePkr", "lossProbability", "createdAt")
        VALUES ('return', 'org-a', 'branch-a', 'origin', 'medicine-a', 3, 'visit-a', 'WALK_OUT',
          3, 'terminal-a', 'WILL_RETURN', 1, 0, now() - interval '1 day');`);
  }

  it('never resolves from an unpaid or voided cart; a completed matching customer purchase recovers it', async () => {
    await seedRecovery();
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    await client.query(`UPDATE pharmacy_sales SET status = 'VOID' WHERE id = 'purchase'`);
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    expect(
      (
        await client.query(
          `SELECT "resolvedBySaleId" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`
        )
      ).rows[0].resolvedBySaleId
    ).toBeNull();
    await client.query(
      `UPDATE pharmacy_sales SET status = 'COMPLETED', "completedAt" = now() WHERE id = 'purchase'`
    );
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    expect(
      (
        await client.query(
          `SELECT "resolvedBySaleId", "lossProbability", "estLossPkr" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`
        )
      ).rows[0]
    ).toMatchObject({
      resolvedBySaleId: 'purchase',
      lossProbability: '0.0000',
      estLossPkr: '0.00',
    });
  });

  it.each(['other-customer', 'late', 'other-branch', 'other-medicine'])(
    'does not recover a %s purchase on the shared terminal',
    async (mismatch) => {
      await seedRecovery();
      await client.query(
        `UPDATE pharmacy_sales SET status = 'COMPLETED', "completedAt" = now() WHERE id = 'purchase'`
      );
      if (mismatch === 'other-customer')
        await client.query(
          `UPDATE pharmacy_sales SET "customerId" = 'other' WHERE id = 'purchase'`
        );
      if (mismatch === 'late')
        await client.query(
          `UPDATE pharmacy_sales SET "completedAt" = now() + interval '8 days' WHERE id = 'purchase'`
        );
      if (mismatch === 'other-branch')
        await client.query(`UPDATE pharmacy_sales SET "branchId" = 'other' WHERE id = 'purchase'`);
      if (mismatch === 'other-medicine')
        await client.query(`UPDATE pharmacy_sale_lines SET "medicineId" = 'other'`);
      await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
      expect(
        (
          await client.query(
            `SELECT "resolvedBySaleId" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`
          )
        ).rows[0].resolvedBySaleId
      ).toBeNull();
    }
  );

  it('removes abandoned-basket value once its originating sale completes', async () => {
    await seedRecovery();
    await client.query(`UPDATE pharmacy_unfulfilled_demand_events SET "abandonedBasketPkr" = 10, "estLossPkr" = 13 WHERE id = 'return';
      UPDATE pharmacy_sales SET status = 'COMPLETED', "completedAt" = now() WHERE id = 'origin'`);
    await recoverCompletedDemand(sqlDb() as never, scope, 'origin');
    expect(
      (
        await client.query(
          `SELECT "visitType", "abandonedBasketPkr", "estLossPkr" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`
        )
      ).rows[0]
    ).toMatchObject({ visitType: 'PARTIAL', abandonedBasketPkr: '0.00', estLossPkr: '3.00' });
  });

  const expireReturns = () => demandAggregate(sqlDb() as never, scope,
    new Date('2000-01-01'), new Date('2100-01-01'), true);

  it('never uses the originating partial basket to recover its three-unit shortfall', async () => {
    await seedRecovery();
    await client.query(`INSERT INTO pharmacy_sale_lines VALUES ('org-a', 'branch-a', 'origin', 'medicine-a', 2);
      UPDATE pharmacy_sales SET status = 'COMPLETED', "completedAt" = now() WHERE id = 'origin'`);
    await recoverCompletedDemand(sqlDb() as never, scope, 'origin');
    expect((await client.query(`SELECT "resolvedBySaleId" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`))
      .rows[0].resolvedBySaleId).toBeNull();
    await client.query(`UPDATE pharmacy_unfulfilled_demand_events SET "createdAt" = now() - interval '8 days' WHERE id = 'return'`);
    await expireReturns();
    expect((await client.query(`SELECT "estLossPkr" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`))
      .rows[0].estLossPkr).toBe('3.00');
  });

  it('allocates a partial return once and expires only the remaining units', async () => {
    await seedRecovery();
    await client.query(`UPDATE pharmacy_sale_lines SET "canonicalUnits" = 1;
      UPDATE pharmacy_sales SET status = 'COMPLETED', "completedAt" = now() WHERE id = 'purchase'`);
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    expect((await client.query(`SELECT "canonicalUnits" FROM pharmacy_demand_recoveries`)).rows)
      .toEqual([{ canonicalUnits: 1 }]);
    expect((await client.query(`SELECT "resolvedBySaleId" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`))
      .rows[0].resolvedBySaleId).toBeNull();
    await client.query(`UPDATE pharmacy_unfulfilled_demand_events SET "createdAt" = now() - interval '8 days' WHERE id = 'return'`);
    await expireReturns();
    expect((await client.query(`SELECT "estLossPkr" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`))
      .rows[0].estLossPkr).toBe('2.00');
  });

  it('combines quantities across later receipts before resolving a return', async () => {
    await seedRecovery();
    await client.query(`UPDATE pharmacy_sale_lines SET "canonicalUnits" = 1;
      UPDATE pharmacy_sales SET status = 'COMPLETED', "completedAt" = now() WHERE id = 'purchase';
      INSERT INTO pharmacy_sales VALUES ('org-a', 'branch-a', 'purchase-2', 'COMPLETED', 'loyalty-a', 'terminal-a', now());
      INSERT INTO pharmacy_sale_lines VALUES ('org-a', 'branch-a', 'purchase-2', 'medicine-a', 2)`);
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase-2');
    expect((await client.query(`SELECT "resolvedBySaleId", "estLossPkr" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`))
      .rows[0]).toMatchObject({ resolvedBySaleId: 'purchase-2', estLossPkr: '0.00' });
  });

  it('does not spend one receipt quantity on several missing-item events', async () => {
    await seedRecovery();
    await client.query(`INSERT INTO pharmacy_unfulfilled_demand_events
      (id, "organizationId", "branchId", "saleId", "requestedMedicineId", quantity, "visitId", "visitType",
       "requestedQty", "terminalId", outcome, "unitPricePkr", "lossProbability", "createdAt")
      SELECT 'return-2', "organizationId", "branchId", "saleId", "requestedMedicineId", quantity, 'visit-b', "visitType",
        "requestedQty", "terminalId", outcome, "unitPricePkr", "lossProbability", now() - interval '12 hours'
      FROM pharmacy_unfulfilled_demand_events WHERE id = 'return';
      UPDATE pharmacy_sales SET status = 'COMPLETED', "completedAt" = now() WHERE id = 'purchase'`);
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    await recoverCompletedDemand(sqlDb() as never, scope, 'purchase');
    expect((await client.query(`SELECT "demandId", "canonicalUnits" FROM pharmacy_demand_recoveries`)).rows)
      .toEqual([{ demandId: 'return', canonicalUnits: 3 }]);
    expect((await client.query(`SELECT "resolvedBySaleId" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return-2'`))
      .rows[0].resolvedBySaleId).toBeNull();
  });

  it('preserves the full PKR 10 value of a three-unit pack when returns expire', async () => {
    await seedRecovery();
    await client.query(`UPDATE pharmacy_unfulfilled_demand_events
      SET "unitPricePkr" = 10::numeric / 3, "createdAt" = now() - interval '8 days' WHERE id = 'return'`);
    await expireReturns();
    expect((await client.query(`SELECT "estLossPkr" FROM pharmacy_unfulfilled_demand_events WHERE id = 'return'`))
      .rows[0].estLossPkr).toBe('10.00');
  });

  it('requires the allocated demand and receipt to share a branch', async () => {
    await seedRecovery();
    await client.query(`INSERT INTO pharmacy_sales VALUES
      ('org-a', 'branch-b', 'other-purchase', 'COMPLETED', 'loyalty-a', 'terminal-b', now())`);
    await expect(client.query(`INSERT INTO pharmacy_demand_recoveries
      ("organizationId", "branchId", "demandId", "saleId", "canonicalUnits")
      VALUES ('org-a', 'branch-a', 'return', 'other-purchase', 1)`))
      .rejects.toMatchObject({ code: '23503', constraint: 'ph_demand_recovery_sale_fk' });
  });

  it('serializes simultaneous captures for one terminal/customer tuple into one visit', async () => {
    const peers = [new Client({ connectionString: url }), new Client({ connectionString: url })];
    const rows: Array<{ visitId: string }> = [];
    await Promise.all(
      peers.map(async (peer) => {
        await peer.connect();
        await peer.query('BEGIN');
      })
    );
    const capture = async (peer: Client) => {
      const db = {
        $queryRaw: async (query: Prisma.Sql) => (await peer.query(query.text, query.values)).rows,
        pharmacyBranch: {
          findFirstOrThrow: async () => ({
            lostSalesUnknownProbability: 0.43,
            lostSalesMeasuredRateMinimum: 200,
          }),
        },
        unfulfilledDemandEvent: {
          // Shared store deliberately yields: the PostgreSQL tuple lock must
          // serialize lookup/create across independent owning transactions.
          findFirst: async () => {
            const previous = rows.at(-1) ?? null;
            await new Promise((done) => setTimeout(done, 20));
            return previous;
          },
          count: async () => 0,
          create: vi.fn(async ({ data }) => {
            rows.push(data);
            return data;
          }),
        },
      };
      try {
        const row = await captureDemand(db as never, scope, {
          terminalId: 'counter-11111111-1111-4111-8111-111111111111',
          requestedText: 'Unlisted medicine',
          saleUnit: 'UNIT',
          quantity: 1,
          reason: 'NOT_CARRIED',
          inventoryRuleSnapshot: {},
        });
        await peer.query('COMMIT');
        return row;
      } catch (error) {
        await peer.query('ROLLBACK');
        throw error;
      }
    };
    try {
      const result = await Promise.all(peers.map(capture));
      expect(result[0]?.visitId).toBe(result[1]?.visitId);
      expect(rows).toHaveLength(2);
    } finally {
      await Promise.all(peers.map((peer) => peer.end()));
    }
  });
});
