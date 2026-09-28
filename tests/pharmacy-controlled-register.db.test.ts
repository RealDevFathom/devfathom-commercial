import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { controlledClient } from './e2e/pharmacy-controlled-fixture';
import { PHARMACY_E2E as f } from './e2e/pharmacy-counter-fixture';

describe.skipIf(process.env.PHARMACY_E2E !== '1')('controlled register serial invariant', () => {
  it('accepts consecutive entries, rejects a skipped serial, and reconciles ledger balances', async () => {
    const db = await controlledClient();
    try {
      await db.query('BEGIN');
      const initial = await db.query(
        `SELECT COALESCE(max(serial),0)::int AS serial FROM pharmacy_controlled_register_entries WHERE "branchId"=$1`,
        [f.branchId]
      );
      const first = initial.rows[0].serial + 1;
      const lots = await db.query(
        `SELECT id FROM pharmacy_inventory_lots WHERE "manufacturingBatchId"=$1`,
        [f.medicines.rx.batchId]
      );
      const lot = lots.rows[0].id;
      async function insert(serial: number) {
        const id = randomUUID();
        await db.query(
          `INSERT INTO pharmacy_stock_movements (id,"branchId","inventoryLotId","stockLocationId",kind,disposition,"quantityUnits","looseUnitDelta","actorId","idempotencyKey") VALUES ($1,$2,$3,$4,'SALE','AVAILABLE',-1,-1,$5,$1)`,
          [id, f.branchId, lot, f.stockLocationId, f.adminId]
        );
        const balance = await db.query(
          `SELECT sum("onHandUnits")::int AS balance FROM pharmacy_stock_balances WHERE "branchId"=$1 AND "inventoryLotId"=$2`,
          [f.branchId, lot]
        );
        await db.query(
          `INSERT INTO pharmacy_controlled_register_entries (id,"branchId",serial,"prescriptionId","prescriptionLineId","patientId","prescriberId","inventoryLotId","stockMovementId","batchNumber","quantityCanonicalUnits","runningBalance","recordedByUserId","witnessedByUserId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,1,$10,$11,'independent-pharmacist')`,
          [
            id,
            f.branchId,
            serial,
            f.prescriptionId,
            f.medicines.rx.prescriptionLineId,
            f.patientId,
            f.prescriberId,
            lot,
            f.medicines.rx.batchNumber,
            balance.rows[0].balance,
            f.adminId,
          ]
        );
        return balance.rows[0].balance;
      }
      const balance = await insert(first);
      expect(await insert(first + 1)).toBe(balance - 1);
      await db.query('SAVEPOINT invalid_serial');
      await expect(insert(first + 3)).rejects.toThrow(
        'controlled register serial must be consecutive'
      );
      await db.query('ROLLBACK TO SAVEPOINT invalid_serial');
      const incidents = await db.query(
        `SELECT count(*)::int AS count FROM pharmacy_register_incidents WHERE "branchId"=$1`,
        [f.branchId]
      );
      expect(incidents.rows[0].count).toBe(0);
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});
