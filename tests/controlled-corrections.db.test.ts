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
      CREATE TABLE pharmacy_controlled_register_entries (id text PRIMARY KEY, "organizationId" text, "branchId" text, serial integer, "entryKind" text, "correctsEntryId" text, "inventoryLotId" text, "medicineId" text, "batchNumber" text, "stockMovementId" text, "quantityCanonicalUnits" integer, "balanceDelta" integer, "runningBalance" integer);
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
});
