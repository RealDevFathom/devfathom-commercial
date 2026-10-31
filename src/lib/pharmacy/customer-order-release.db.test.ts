// Exercise the migration's actual PostgreSQL trigger against isolated copies of
// the migrated tables. All DDL and fixture rows roll back when the suite ends.
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('ready customer-order release database guard', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE pharmacy_customer_orders
        (LIKE public.pharmacy_customer_orders INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
      CREATE TEMP TABLE pharmacy_order_delivery_evidence
        (LIKE public.pharmacy_order_delivery_evidence INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
    `);
    const migration = readFileSync(
      'prisma/migrations/20261031180000_pharmacy_ready_order_release/migration.sql',
      'utf8'
    );
    // Qualify only the function's name so the production function is untouched.
    await client.query(
      migration.replace(
        'FUNCTION pharmacy_guard_customer_order_transition()',
        'FUNCTION pg_temp.pharmacy_guard_customer_order_transition()'
      )
    );
    await client.query(`
      CREATE TRIGGER release_guard BEFORE UPDATE OR DELETE ON pharmacy_customer_orders
        FOR EACH ROW EXECUTE FUNCTION pg_temp.pharmacy_guard_customer_order_transition();
    `);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  beforeEach(async () => {
    await client.query('SAVEPOINT release_case');
  });

  afterEach(async () => {
    await client.query('ROLLBACK TO SAVEPOINT release_case');
  });

  async function order(
    status = 'READY_FOR_COLLECTION',
    linkedSale: string | null = null,
    overdue = true
  ) {
    await client.query(
      `INSERT INTO pharmacy_customer_orders
        (id, "organizationId", "branchId", "customerId", "placedByUserId", fulfillment,
         status, "intendedPaymentMethod", "reservationExpiresAt", "createdAt", "updatedAt",
         "counterSaleId", "addressLine", city, "runnerUserId")
       VALUES ('order', 'org', 'branch', 'customer', 'user',
         CASE WHEN $1 = 'OUT_FOR_DELIVERY' THEN 'DELIVER'::"PharmacyCustomerOrderFulfillment"
              ELSE 'COLLECT'::"PharmacyCustomerOrderFulfillment" END,
         $1::"PharmacyCustomerOrderStatus", 'CASH',
         now() + ($3 * interval '1 hour'), now() - interval '2 hours', now(), $2,
         CASE WHEN $1 = 'OUT_FOR_DELIVERY' THEN '1 Test Road' END,
         CASE WHEN $1 = 'OUT_FOR_DELIVERY' THEN 'Lahore' END,
         CASE WHEN $1 = 'OUT_FOR_DELIVERY' THEN 'runner' END)`,
      [status, linkedSale, overdue ? -1 : 1]
    );
  }

  function release(status: 'CANCELLED' | 'EXPIRED') {
    return client.query(
      `UPDATE pharmacy_customer_orders
       SET status = $1::"PharmacyCustomerOrderStatus",
           "cancelledAt" = CASE WHEN $1 = 'CANCELLED' THEN now() END,
           "expiredAt" = CASE WHEN $1 = 'EXPIRED' THEN now() END
       WHERE id = 'order' RETURNING status, "cancelledAt", "expiredAt"`,
      [status]
    );
  }

  it.each(['CANCELLED', 'EXPIRED'] as const)(
    'permits overdue ready stock recovery: %s',
    async (status) => {
      await order();
      const result = await release(status);
      expect(result.rows).toEqual([
        {
          status,
          cancelledAt: status === 'CANCELLED' ? expect.any(Date) : null,
          expiredAt: status === 'EXPIRED' ? expect.any(Date) : null,
        },
      ]);
    }
  );

  it('allows cancellation before the deadline', async () => {
    await order('READY_FOR_COLLECTION', null, false);
    expect((await release('CANCELLED')).rowCount).toBe(1);
  });

  it('rejects expiry before the deadline', async () => {
    await order('READY_FOR_COLLECTION', null, false);
    await expect(release('EXPIRED')).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['CANCELLED', 'EXPIRED'] as const)('rejects linked-sale release: %s', async (status) => {
    await order('READY_FOR_COLLECTION', 'sale');
    await expect(release(status)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects clearing a linked sale while cancelling', async () => {
    await order('READY_FOR_COLLECTION', 'sale');
    await expect(
      client.query(`UPDATE pharmacy_customer_orders
        SET status = 'CANCELLED', "cancelledAt" = now(), "counterSaleId" = NULL WHERE id = 'order'`)
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['CANCELLED', 'EXPIRED'] as const)(
    'rejects dispatched-order release: %s',
    async (status) => {
      await order('OUT_FOR_DELIVERY');
      await expect(release(status)).rejects.toMatchObject({ code: '23514' });
    }
  );

  it('keeps the delivery physical-return evidence guard', async () => {
    await order('OUT_FOR_DELIVERY');
    await expect(
      client.query("UPDATE pharmacy_customer_orders SET status = 'RETURNED' WHERE id = 'order'")
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('still permits an evidenced delivery return', async () => {
    await order('OUT_FOR_DELIVERY');
    await client.query(`INSERT INTO pharmacy_order_delivery_evidence
      (id, "organizationId", "branchId", "orderId", "actorUserId", action, reference,
       "requestKey", fingerprint)
      VALUES ('evidence', 'org', 'branch', 'order', 'user', 'PHYSICAL_RETURN', 'return receipt',
              'return-key', 'fingerprint')`);
    expect(
      (
        await client.query(
          "UPDATE pharmacy_customer_orders SET status = 'RETURNED' WHERE id = 'order'"
        )
      ).rowCount
    ).toBe(1);
  });

  it('keeps terminal orders immutable', async () => {
    await order();
    await release('CANCELLED');
    await expect(release('EXPIRED')).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps the original proposal immutable during recovery', async () => {
    await order();
    await expect(
      client.query(`UPDATE pharmacy_customer_orders SET status = 'CANCELLED', "cancelledAt" = now(),
        "reservationExpiresAt" = now() + interval '1 hour' WHERE id = 'order'`)
    ).rejects.toMatchObject({ code: '55000' });
  });
});
