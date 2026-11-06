// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

// The QA gate owner is intentionally NOSUPERUSER/NOBYPASSRLS and owns the
// migrated disposable gate database, so it can create this suite's isolated schema.
const url = process.env.CONTROLLED_TEST_DATABASE_URL ?? process.env.OWNER_DATABASE_URL;
const schema = `controlled_${randomUUID().replaceAll('-', '')}`;
const client = new Client({ connectionString: url });
const migration = readFileSync(
  'prisma/migrations/20261021160000_controlled_correction_invariants/migration.sql',
  'utf8'
);

describe.skipIf(!url)('controlled corrections against restricted PostgreSQL', () => {
  beforeAll(async () => {
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE pharmacy_stock_movements (id text, "organizationId" text, "branchId" text, "inventoryLotId" text, kind text, disposition text, "quantityUnits" integer, "reversesMovementId" text, UNIQUE("organizationId",id));
      CREATE TABLE pharmacy_controlled_register_entries (id text PRIMARY KEY, "organizationId" text, "branchId" text, serial integer, "entryKind" text, "correctsEntryId" text, "inventoryLotId" text, "medicineId" text, "batchNumber" text, "stockMovementId" text, "quantityCanonicalUnits" integer CHECK ("quantityCanonicalUnits">0), "balanceDelta" integer, "runningBalance" integer);
      CREATE TABLE pharmacy_register_incidents (id text, "organizationId" text, "branchId" text, status text, "registerEntryId" text, "expectedBalance" integer, "actualBalance" integer);
      CREATE TABLE pharmacy_stock_balances ("organizationId" text, "branchId" text, "inventoryLotId" text, disposition text, "onHandUnits" integer);
      CREATE TABLE pharmacy_inventory_lots (id text, "organizationId" text, "manufacturingBatchId" text);
      CREATE TABLE pharmacy_manufacturing_batches (id text, "organizationId" text, "batchNumber" text);
      CREATE TABLE pharmacy_sale_return_lines ("organizationId" text, "saleLineId" text, "inventoryLotId" text, "stockMovementId" text);
      CREATE TABLE pharmacy_sale_line_allocations ("organizationId" text, "saleLineId" text, "inventoryLotId" text, "stockMovementId" text);
      ALTER TABLE pharmacy_controlled_register_entries ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pharmacy_controlled_register_entries FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON pharmacy_controlled_register_entries USING ("organizationId"=current_setting('app.current_organization_id',true)) WITH CHECK ("organizationId"=current_setting('app.current_organization_id',true));
      SET app.current_organization_id='org';`);
    await client.query(migration);
    await client.query(readFileSync('prisma/migrations/20261029000191/migration.sql', 'utf8'));
    await client.query(
      `CREATE TRIGGER pharmacy_controlled_register_reconcile AFTER INSERT ON pharmacy_controlled_register_entries FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reconcile_controlled_register()`
    );
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });
  beforeEach(async () => {
    await client.query(`TRUNCATE pharmacy_controlled_register_entries, pharmacy_stock_movements, pharmacy_stock_balances, pharmacy_register_incidents CASCADE;
      ALTER TABLE pharmacy_controlled_register_entries DISABLE TRIGGER pharmacy_controlled_register_reconcile;
      INSERT INTO pharmacy_controlled_register_entries VALUES ('original','org','branch',1,'SALE',null,'lot','med','batch','sale',10,-10,10,null);
      ALTER TABLE pharmacy_controlled_register_entries ENABLE TRIGGER pharmacy_controlled_register_reconcile;
      INSERT INTO pharmacy_stock_balances VALUES ('org','branch','lot','AVAILABLE',12), ('org','branch','lot','QUARANTINE',99);`);
  });
  function insert(overrides: Record<string, unknown> = {}) {
    const row = {
      id: randomUUID(),
      organizationId: 'org',
      branchId: 'branch',
      serial: 2,
      entryKind: 'CORRECTION',
      correctsEntryId: 'original',
      inventoryLotId: 'lot',
      medicineId: 'med',
      batchNumber: 'batch',
      quantityCanonicalUnits: 8,
      balanceDelta: 2,
      runningBalance: 12,
      ...overrides,
    };
    const keys = Object.keys(row);
    return client.query(
      `INSERT INTO pharmacy_controlled_register_entries (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row)
    );
  }
  it('accepts a derived manual delta matching sellable stock and excludes quarantine', async () => {
    await insert();
  });
  it('rejects a client-invented delta even when its balance equals stock', async () => {
    await expect(insert({ balanceDelta: 7 })).rejects.toThrow(/derived/);
  });
  it('rejects quantity beyond the original cap', async () => {
    await expect(insert({ quantityCanonicalUnits: 21, balanceDelta: -11 })).rejects.toThrow(/cap/);
  });
  it('rejects a balance mismatch', async () => {
    await expect(insert({ runningBalance: 13 })).rejects.toThrow(/balance/);
  });
  it('rejects a stock mismatch even when arithmetic is valid', async () => {
    await expect(
      insert({ quantityCanonicalUnits: 7, balanceDelta: 3, runningBalance: 13 })
    ).rejects.toThrow(/balance/);
  });
  it('rejects a second manual correction via a unique constraint', async () => {
    await insert();
    await expect(insert({ serial: 3 })).rejects.toMatchObject({ code: '23505' });
  });
  it('rejects stacking on a correction', async () => {
    await insert({ id: 'correction' });
    await expect(insert({ serial: 3, correctsEntryId: 'correction' })).rejects.toThrow(/original/);
  });
  it.each([{ branchId: 'other' }, { inventoryLotId: 'other' }, { medicineId: 'other' }])(
    'rejects scope changes %j',
    async (scope) => {
      await expect(insert(scope)).rejects.toThrow();
    }
  );
  it('enforces tenant RLS as a second wall', async () => {
    await expect(insert({ organizationId: 'foreign' })).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await client.query(
          `SELECT * FROM pharmacy_controlled_register_entries WHERE "organizationId"='foreign'`
        )
      ).rowCount
    ).toBe(0);
  });
  it('accepts a movement-backed partial restoration and rejects reuse', async () => {
    await client.query(
      `INSERT INTO pharmacy_stock_movements VALUES ('restore','org','branch','lot','ADJUSTMENT','AVAILABLE',2,'sale')`
    );
    await insert({ restorationMovementId: 'restore', quantityCanonicalUnits: 2 });
    await expect(
      insert({ serial: 3, restorationMovementId: 'restore', quantityCanonicalUnits: 2 })
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('rejects a fabricated restoration against an unrelated movement', async () => {
    await client.query(
      `INSERT INTO pharmacy_stock_movements VALUES ('restore','org','branch','lot','ADJUSTMENT','AVAILABLE',2,'other')`
    );
    await expect(
      insert({ restorationMovementId: 'restore', quantityCanonicalUnits: 2 })
    ).rejects.toThrow(/compensating/);
  });
  describe('movement-backed purchase reversals', () => {
    beforeEach(async () => {
      await client.query(`TRUNCATE pharmacy_controlled_register_entries, pharmacy_stock_movements,
        pharmacy_stock_balances, pharmacy_inventory_lots, pharmacy_manufacturing_batches CASCADE;
        INSERT INTO pharmacy_inventory_lots VALUES ('lot','org','batch-id');
        INSERT INTO pharmacy_manufacturing_batches VALUES ('batch-id','org','batch');
        INSERT INTO pharmacy_stock_balances VALUES ('org','branch','lot','AVAILABLE',10);
        INSERT INTO pharmacy_stock_movements VALUES ('receipt','org','branch','lot','RECEIPT','AVAILABLE',10,null);
        INSERT INTO pharmacy_controlled_register_entries VALUES
          ('original','org','branch',1,'PURCHASE',null,'lot','med','batch','receipt',10,10,10,null);`);
    });

    async function reverseStock(
      overrides: { source?: string; quantity?: number; disposition?: string } = {}
    ) {
      await client.query('UPDATE pharmacy_stock_balances SET "onHandUnits"=0');
      await client.query(
        `INSERT INTO pharmacy_stock_movements VALUES
          ('reverse','org','branch','lot','ADJUSTMENT',$1,$2,$3)`,
        [
          overrides.disposition ?? 'AVAILABLE',
          overrides.quantity ?? -10,
          overrides.source ?? 'receipt',
        ]
      );
    }

    const reversal = {
      restorationMovementId: 'reverse',
      quantityCanonicalUnits: 0,
      balanceDelta: -10,
      runningBalance: 0,
    };

    it('accepts a zero-quantity purchase reversal against the real quantity constraint', async () => {
      await reverseStock();
      await insert(reversal);
      const result = await client.query(
        `SELECT "runningBalance" FROM pharmacy_controlled_register_entries ORDER BY serial DESC LIMIT 1`
      );
      expect(result.rows[0].runningBalance).toBe(0);
    });

    it('accepts reversal after a manual correction without consuming its identity', async () => {
      await insert({ quantityCanonicalUnits: 10, balanceDelta: 0, runningBalance: 10 });
      await reverseStock();
      await insert({ ...reversal, serial: 3 });
      expect(
        (await client.query('SELECT * FROM pharmacy_controlled_register_entries')).rowCount
      ).toBe(3);
      await expect(insert({ ...reversal, serial: 4 })).rejects.toMatchObject({ code: '23505' });
    });

    it.each([{ source: 'unrelated' }, { quantity: -9 }, { disposition: 'QUARANTINE' }])(
      'rejects an invalid compensating movement %j',
      async (movement) => {
        await reverseStock(movement);
        await expect(insert(reversal)).rejects.toThrow(/compensating receipt/);
      }
    );

    it('still rejects zero-quantity purchases, sales and manual corrections', async () => {
      await expect(
        insert({ entryKind: 'PURCHASE', quantityCanonicalUnits: 0 })
      ).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ entryKind: 'SALE', quantityCanonicalUnits: 0 })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert({ quantityCanonicalUnits: 0 })).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects an invented reversal delta even when the final balance matches stock', async () => {
      await reverseStock();
      await expect(insert({ ...reversal, balanceDelta: -9 })).rejects.toThrow(
        /compensating receipt/
      );
    });
  });
});
