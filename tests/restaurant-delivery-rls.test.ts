import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.DELIVERY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
// Skipped, never silently passed, without a disposable database.
const describeIfDatabase = url ? describe : describe.skip;

const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `delivery_runtime_${suffix}`;
const id = (name: string) => `${name}_${suffix}`;

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await operation();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
    expect(error).toMatchObject({ code });
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  throw new Error(`Expected PostgreSQL error ${code}`);
}

async function insertFulfillment(overrides: Record<string, unknown> = {}) {
  const values = {
    rowId: id('fulfillment_a'),
    organizationId: id('org_a'),
    branchId: id('branch_a'),
    customerId: id('customer_a'),
    orderId: id('order_a'),
    zoneId: id('zone_a'),
    zoneName: 'Central',
    zoneLabel: '1000-1999',
    fee: '4.50',
    minutes: 35,
    ...overrides,
  };
  return client.query(
    `INSERT INTO restaurant_delivery_fulfillments (
      id, "organizationId", "branchId", "customerId", "orderId", "paymentMode",
      "recipientNameSnapshot", "normalizedPhoneSnapshot", "addressLine1Snapshot", "localitySnapshot",
      "countryCodeSnapshot", "zoneIdSnapshot", "zoneNameSnapshot", "zoneAreaPostalLabelSnapshot",
      "deliveryFeeSnapshot", "deliveryTaxSnapshot", "promisedMinutesSnapshot", "promisedAt", "updatedAt"
    ) VALUES ($1,$2,$3,$4,$5,'COD','Recipient','+12025550123','1 Main St','Metro','US',$6,$7,$8,$9,0,$10,now(),now())`,
    [
      values.rowId,
      values.organizationId,
      values.branchId,
      values.customerId,
      values.orderId,
      values.zoneId,
      values.zoneName,
      values.zoneLabel,
      values.fee,
      values.minutes,
    ]
  );
}

describeIfDatabase('restaurant direct-delivery schema and forced RLS', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT ON restaurant_orders, restaurant_branches, restaurant_customers TO "${role}"`
    );
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_delivery_zones,
       restaurant_customer_addresses, restaurant_delivery_fulfillments TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now()),($2,$2,$2,$2,'ACTIVE','SHARED',now(),now())`,
      [id('org_a'), id('org_b')]
    );
    await client.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES
       ($1,$2,'A',now()),($3,$2,'A other',now()),($4,$5,'B',now())`,
      [id('branch_a'), id('org_a'), id('branch_a_other'), id('branch_b'), id('org_b')]
    );
    await client.query(
      `INSERT INTO restaurant_customers (id,"organizationId","displayName","updatedAt") VALUES
       ($1,$2,'A customer',now()),($3,$4,'B customer',now())`,
      [id('customer_a'), id('org_a'), id('customer_b'), id('org_b')]
    );
    await client.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","displayName","updatedAt") VALUES
       ($1,$2,'A staff',now()),($3,$4,'B staff',now())`,
      [id('staff_a'), id('org_a'), id('staff_b'), id('org_b')]
    );
    await client.query(
      `INSERT INTO restaurant_registered_devices (id,"organizationId","branchId",name,"deviceSecretHash","updatedAt") VALUES
       ($1,$2,$3,'A device','hash-a',now()),($4,$5,$6,'B device','hash-b',now())`,
      [id('device_a'), id('org_a'), id('branch_a'), id('device_b'), id('org_b'), id('branch_b')]
    );
    await client.query(
      `INSERT INTO restaurant_orders
       (id,"organizationId","branchId","orderNumber","businessDate",channel,"customerId","staffProfileId","deviceId","updatedAt") VALUES
       ($1,$2,$3,7001,current_date,'DELIVERY',$4,$5,$6,now()),
       ($7,$2,$8,7002,current_date,'DELIVERY',$4,$5,$6,now()),
       ($9,$2,$3,7003,current_date,'DINE_IN',$4,$5,$6,now()),
       ($10,$2,$3,7004,current_date,'DELIVERY',$4,$5,$6,now()),
       ($11,$12,$13,7001,current_date,'DELIVERY',$14,$15,$16,now())`,
      [
        id('order_a'),
        id('org_a'),
        id('branch_a'),
        id('customer_a'),
        id('staff_a'),
        id('device_a'),
        id('order_a_other'),
        id('branch_a_other'),
        id('order_dine_in'),
        id('order_wrong_customer'),
        id('order_b'),
        id('org_b'),
        id('branch_b'),
        id('customer_b'),
        id('staff_b'),
        id('device_b'),
      ]
    );
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [id('org_a')]);
    await client.query(
      `INSERT INTO restaurant_delivery_zones
       (id,"organizationId","branchId",name,"fixedFee","minimumSubtotal","promisedMinutes","areaPostalLabel","updatedAt") VALUES
       ($1,$2,$3,'Central',4.50,10,35,'1000-1999',now()),
       ($4,$2,$5,'Other branch',5,0,45,NULL,now())`,
      [id('zone_a'), id('org_a'), id('branch_a'), id('zone_a_other'), id('branch_a_other')]
    );
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [id('org_b')]);
    await client.query(
      `INSERT INTO restaurant_delivery_zones
       (id,"organizationId","branchId",name,"fixedFee","minimumSubtotal","promisedMinutes","areaPostalLabel","updatedAt") VALUES
       ($1,$2,$3,'Tenant B',6,0,50,NULL,now())`,
      [id('zone_b'), id('org_b'), id('branch_b')]
    );
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [id('org_a')]);
    await client.query(
      `INSERT INTO restaurant_customer_addresses
       (id,"organizationId","customerId",label,"recipientName","normalizedPhone","addressLine1",locality,"countryCode","isDefault","updatedAt") VALUES
       ($1,$2,$3,'Home','A Recipient','+12025550123','1 Main St','Metro','US',true,now())`,
      [id('address_a'), id('org_a'), id('customer_a')]
    );
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [id('org_b')]);
    await client.query(
      `INSERT INTO restaurant_customer_addresses
       (id,"organizationId","customerId",label,"recipientName","normalizedPhone","addressLine1",locality,"countryCode","isDefault","updatedAt") VALUES
       ($1,$2,$3,'Home','B Recipient','+12025550124','2 Main St','Metro','US',true,now())`,
      [id('address_b'), id('org_b'), id('customer_b')]
    );
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [id('org_a')]);
  }, 60_000);

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('runs as LOGIN NOSUPERUSER NOBYPASSRLS and all delivery tables force RLS', async () => {
    const roleFlags = await client.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(roleFlags.rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);
    const rls = await client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('restaurant_delivery_zones','restaurant_customer_addresses','restaurant_delivery_fulfillments')
       ORDER BY relname`
    );
    expect(rls.rows).toHaveLength(3);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('hides cross-tenant zones and addresses and rejects cross-tenant inserts', async () => {
    expect(
      (await client.query(`SELECT id FROM restaurant_delivery_zones ORDER BY id`)).rows
    ).toEqual([{ id: id('zone_a') }, { id: id('zone_a_other') }]);
    expect((await client.query(`SELECT id FROM restaurant_customer_addresses`)).rows).toEqual([
      { id: id('address_a') },
    ]);
    await expectPgCode('42501', () =>
      client.query(
        `INSERT INTO restaurant_customer_addresses
         (id,"organizationId","customerId",label,"recipientName","normalizedPhone","addressLine1",locality,"countryCode","updatedAt")
         VALUES ($1,$2,$3,'Bad','Bad','+12025550125','x','x','US',now())`,
        [id('cross_tenant_address'), id('org_b'), id('customer_b')]
      )
    );
  });

  it('accepts the same active tenant/branch snapshot and prevents duplicate fulfillment', async () => {
    await insertFulfillment();
    await expectPgCode('23505', () => insertFulfillment({ rowId: id('fulfillment_duplicate') }));
  });

  it('rejects same-organization cross-branch zones, client fee tampering, and non-delivery orders', async () => {
    await expectPgCode('23514', () =>
      insertFulfillment({
        rowId: id('cross_branch'),
        zoneId: id('zone_a_other'),
        zoneName: 'Other branch',
        zoneLabel: null,
        fee: '5.00',
        minutes: 45,
      })
    );
    await expectPgCode('23514', () => insertFulfillment({ rowId: id('fee_tamper'), fee: '0.01' }));
    await expectPgCode('23514', () =>
      insertFulfillment({ rowId: id('dine_in'), orderId: id('order_dine_in') })
    );
  });

  it('enforces composite customer/order tenancy and money/contact constraints', async () => {
    await expectPgCode('23503', () =>
      insertFulfillment({
        rowId: id('wrong_customer'),
        orderId: id('order_wrong_customer'),
        customerId: id('customer_b'),
      })
    );
    await expectPgCode('23514', () =>
      client.query(
        `INSERT INTO restaurant_delivery_zones
         (id,"branchId",name,"fixedFee","minimumSubtotal","promisedMinutes","updatedAt")
         VALUES ($1,$2,'Invalid',-1,0,10,now())`,
        [id('negative_zone'), id('branch_a')]
      )
    );
    await expectPgCode('23514', () =>
      client.query(
        `INSERT INTO restaurant_customer_addresses
         (id,"customerId",label,"recipientName","normalizedPhone","addressLine1",locality,"countryCode","updatedAt")
         VALUES ($1,$2,'Bad','Bad','not-normalized','x','x','USA',now())`,
        [id('invalid_address'), id('customer_a')]
      )
    );
  });

  it('keeps historical snapshots immutable while allowing valid status transitions', async () => {
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_delivery_fulfillments SET "deliveryFeeSnapshot" = 99, "updatedAt" = now() WHERE id = $1`,
        [id('fulfillment_a')]
      )
    );
    await expectPgCode('23514', () =>
      client.query(
        `UPDATE restaurant_delivery_fulfillments SET status = 'DELIVERED', "updatedAt" = now() WHERE id = $1`,
        [id('fulfillment_a')]
      )
    );
    await client.query(
      `UPDATE restaurant_delivery_fulfillments SET status = 'DISPATCHED', "dispatchedAt" = now(), "updatedAt" = now() WHERE id = $1`,
      [id('fulfillment_a')]
    );
    await client.query(
      `UPDATE restaurant_delivery_fulfillments SET status = 'DELIVERED', "deliveredAt" = now(), "updatedAt" = now() WHERE id = $1`,
      [id('fulfillment_a')]
    );
  });
});
