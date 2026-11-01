import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
// Skipped, never silently passed, without a disposable database.
const describeIfDatabase = url ? describe : describe.skip;

const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `tax_runtime_${suffix}`;
const orgA = `tax_org_a_${suffix}`;
const orgB = `tax_org_b_${suffix}`;

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await operation();
  } catch (error) {
    // PostgreSQL keeps the transaction aborted after an expected trigger/RLS
    // rejection. Restore it before making the assertion so the next immutable
    // ledger probe always starts from a usable transaction.
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
    expect(error).toMatchObject({ code });
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  throw new Error(`Expected PostgreSQL error ${code}`);
}

describeIfDatabase('tax core real-PostgreSQL RLS and immutability', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    // The demo-reset policy is SECURITY INVOKER and reads tenant identity.
    await client.query(`GRANT SELECT ON organizations TO "${role}"`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_tax_official_sources, restaurant_tax_profile_versions,
       restaurant_tax_rule_versions, restaurant_tax_transaction_snapshots, restaurant_tax_rate_bucket_snapshots,
       restaurant_tax_tender_allocation_snapshots, restaurant_tax_refund_allocations TO "${role}"`
    );
    await client.query(`GRANT SELECT, UPDATE, DELETE ON restaurant_refunds TO "${role}"`);
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now()), ($2,$2,$2,$2,'ACTIVE','SHARED',now(),now())`,
      [orgA, orgB]
    );
    await client.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,'A',now()),($3,$4,'B',now())`,
      [`branch_a_${suffix}`, orgA, `branch_b_${suffix}`, orgB]
    );
    for (const tenant of [
      { key: 'a', organizationId: orgA },
      { key: 'b', organizationId: orgB },
    ] as const) {
      await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
        tenant.organizationId,
      ]);
      await client.query(
        `INSERT INTO restaurant_tax_official_sources (id,"organizationId","authorityCode","documentTitle","sourceUrl","contentHash","retrievedAt")
         VALUES ($1,$2,'SYNTHETIC','Fixture',$3,$4,now())`,
        [
          `source_${tenant.key}_${suffix}`,
          tenant.organizationId,
          `https://example.invalid/${tenant.key}`,
          `hash_${tenant.key}_${suffix}`,
        ]
      );
      await client.query(
        `INSERT INTO restaurant_tax_profile_versions (id,"organizationId","branchId","versionNumber",status,"effectiveFrom","approvalReference","approvedAt","publishedAt","updatedAt")
         VALUES ($1,$2,$3,1,'PUBLISHED','2030-01-01','SYNTHETIC',now(),now(),now())`,
        [`profile_${tenant.key}_${suffix}`, tenant.organizationId, `branch_${tenant.key}_${suffix}`]
      );
      await client.query(
        `INSERT INTO restaurant_tax_rule_versions
         (id,"organizationId","profileVersionId","officialSourceId","ruleCode","paymentCategory","priceMode",rate,status,"effectiveFrom","approvalReference","approvedAt","publishedAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'SYNTHETIC_CARD','EXCLUSIVE',0.1,'PUBLISHED','2030-01-01','SYNTHETIC',now(),now(),now())`,
        [
          `rule_${tenant.key}_${suffix}`,
          tenant.organizationId,
          `profile_${tenant.key}_${suffix}`,
          `source_${tenant.key}_${suffix}`,
          tenant.key.toUpperCase(),
        ]
      );
      await client.query(
        `INSERT INTO restaurant_tax_transaction_snapshots
         (id,"organizationId","branchId","transactionReference","profileVersionId",currency,subtotal,"discountTotal","serviceChargeTotal","taxTotal","grandTotal","settledAt")
         VALUES ($1,$2,$3,$4,$5,'XXX',100,10,5,9.5,104.5,now())`,
        [
          `snapshot_${tenant.key}_${suffix}`,
          tenant.organizationId,
          `branch_${tenant.key}_${suffix}`,
          `original-${tenant.key}`,
          `profile_${tenant.key}_${suffix}`,
        ]
      );
    }
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    await client.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","displayName","updatedAt")
       VALUES ($1,$3,'Actor',now()),($2,$3,'Manager',now())`,
      [`actor_${suffix}`, `manager_${suffix}`, orgA]
    );
    await client.query(
      `INSERT INTO restaurant_registered_devices (id,"organizationId","branchId",name,"deviceSecretHash","updatedAt")
       VALUES ($1,$2,$3,'Tax fixture',$4,now())`,
      [`device_${suffix}`, orgA, `branch_a_${suffix}`, `device_hash_${suffix}`]
    );
    await client.query(
      `INSERT INTO restaurant_co_authorizations
       (id,"organizationId","actingStaffProfileId","approvingStaffProfileId",capability,reason,"deviceId")
       VALUES ($1,$2,$3,$4,'REFUND','fixture',$5)`,
      [`coauth_${suffix}`, orgA, `actor_${suffix}`, `manager_${suffix}`, `device_${suffix}`]
    );
    await client.query(
      `INSERT INTO restaurant_orders
       (id,"organizationId","branchId","orderNumber","businessDate",channel,"staffProfileId","deviceId","updatedAt")
       VALUES ($1,$2,$3,9001,current_date,'DINE_IN',$4,$5,now()),
              ($6,$2,$3,9002,current_date,'DINE_IN',$4,$5,now())`,
      [
        `order_partial_${suffix}`,
        orgA,
        `branch_a_${suffix}`,
        `actor_${suffix}`,
        `device_${suffix}`,
        `order_full_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_bills
       (id,"organizationId","orderId","branchId","businessDate",subtotal,"taxTotal","grandTotal","openerStaffProfileId","deviceId","updatedAt")
       VALUES ($1,$3,$4,$5,current_date,100,10,110,$6,$7,now()),
              ($2,$3,$8,$5,current_date,50,5,55,$6,$7,now())`,
      [
        `bill_partial_${suffix}`,
        `bill_full_${suffix}`,
        orgA,
        `order_partial_${suffix}`,
        `branch_a_${suffix}`,
        `actor_${suffix}`,
        `device_${suffix}`,
        `order_full_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_tenders
       (id,"organizationId","billId",type,amount,"businessDate","staffProfileId","deviceId")
       VALUES ($1,$4,$5,'CARD',60,current_date,$6,$7),
              ($2,$4,$5,'CARD',50,current_date,$6,$7),
              ($3,$4,$8,'CARD',55,current_date,$6,$7)`,
      [
        `tender_one_${suffix}`,
        `tender_two_${suffix}`,
        `tender_full_${suffix}`,
        orgA,
        `bill_partial_${suffix}`,
        `actor_${suffix}`,
        `device_${suffix}`,
        `bill_full_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_tax_transaction_snapshots
       (id,"organizationId","branchId","billId","transactionReference","profileVersionId",currency,subtotal,"taxTotal","grandTotal","settledAt")
       VALUES ($1,$3,$4,$5,$1,$6,'XXX',100,10,110,now()),
              ($2,$3,$4,$7,$2,$6,'XXX',50,5,55,now())`,
      [
        `allocation_snapshot_${suffix}`,
        `full_snapshot_${suffix}`,
        orgA,
        `branch_a_${suffix}`,
        `bill_partial_${suffix}`,
        `profile_a_${suffix}`,
        `bill_full_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_tax_rate_bucket_snapshots
       (id,"organizationId","snapshotId","ruleVersionId","paymentCategory","priceMode",rate,"taxableAmount","taxAmount","grossAmount")
       VALUES ($1,$3,$4,$6,'CARD','EXCLUSIVE',0.1,100,10,110),
              ($2,$3,$5,$6,'CARD','EXCLUSIVE',0.1,50,5,55)`,
      [
        `allocation_bucket_${suffix}`,
        `full_bucket_${suffix}`,
        orgA,
        `allocation_snapshot_${suffix}`,
        `full_snapshot_${suffix}`,
        `rule_a_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_tax_tender_allocation_snapshots
       (id,"organizationId","snapshotId","billId","rateBucketSnapshotId","originalTenderId","paymentCategory",cents)
       VALUES ($1,$4,$5,$6,$7,$8,'CARD',60),
              ($2,$4,$5,$6,$7,$9,'CARD',50),
              ($3,$4,$10,$11,$12,$13,'CARD',55)`,
      [
        `original_one_${suffix}`,
        `original_two_${suffix}`,
        `original_full_${suffix}`,
        orgA,
        `allocation_snapshot_${suffix}`,
        `bill_partial_${suffix}`,
        `allocation_bucket_${suffix}`,
        `tender_one_${suffix}`,
        `tender_two_${suffix}`,
        `full_snapshot_${suffix}`,
        `bill_full_${suffix}`,
        `full_bucket_${suffix}`,
        `tender_full_${suffix}`,
      ]
    );
    for (const [id, tenderId, billId] of [
      [`refund_one_${suffix}`, `tender_one_${suffix}`, `bill_partial_${suffix}`],
      [`refund_two_${suffix}`, `tender_one_${suffix}`, `bill_partial_${suffix}`],
      [`refund_over_${suffix}`, `tender_one_${suffix}`, `bill_partial_${suffix}`],
      [`refund_race_a_${suffix}`, `tender_two_${suffix}`, `bill_partial_${suffix}`],
      [`refund_race_b_${suffix}`, `tender_two_${suffix}`, `bill_partial_${suffix}`],
      [`refund_full_${suffix}`, `tender_full_${suffix}`, `bill_full_${suffix}`],
    ]) {
      await client.query(
        `INSERT INTO restaurant_refunds
         (id,"organizationId","originalTenderId","billId",amount,kind,"businessDate",reason,"coAuthorizationId","staffProfileId","deviceId")
         VALUES ($1,$2,$3,$4,1,'REFUND',current_date,'fixture',$5,$6,$7)`,
        [id, orgA, tenderId, billId, `coauth_${suffix}`, `actor_${suffix}`, `device_${suffix}`]
      );
    }
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('uses a LOGIN NOSUPERUSER NOBYPASSRLS runtime role and sees one tenant only', async () => {
    const roleFlags = await client.query(
      'SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1',
      [role]
    );
    expect(roleFlags.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    expect((await client.query('SELECT id FROM restaurant_tax_official_sources')).rowCount).toBe(1);
  });

  it('rejects cross-tenant writes and published/source mutation', async () => {
    await expectPgCode('42501', () =>
      client.query(
        `INSERT INTO restaurant_tax_official_sources (id,"organizationId","authorityCode","documentTitle","sourceUrl","contentHash","retrievedAt") VALUES ($1,$2,'X','X','https://example.invalid/x',$1,now())`,
        [`cross_${suffix}`, orgB]
      )
    );
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_tax_official_sources SET "documentTitle"='changed' WHERE "organizationId"=$1`,
        [orgA]
      )
    );
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_tax_profile_versions SET "versionNumber"=2 WHERE "organizationId"=$1`,
        [orgA]
      )
    );
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_tax_rule_versions SET "discountTreatment"='AFTER_TAX' WHERE "organizationId"=$1`,
        [orgA]
      )
    );
  });

  it('pins closed tax treatment and legacy-compatible promotion evidence defaults', async () => {
    await client.query('RESET ROLE');
    const rule = await client.query(
      `SELECT "discountTreatment" FROM restaurant_tax_rule_versions WHERE id=$1`,
      [`rule_a_${suffix}`]
    );
    expect(rule.rows[0]).toEqual({ discountTreatment: 'BEFORE_TAX' });
    await expectPgCode('22P02', () =>
      client.query(
        `INSERT INTO restaurant_tax_rule_versions
         (id,"organizationId","profileVersionId","officialSourceId","ruleCode","paymentCategory","priceMode","discountTreatment",rate,"effectiveFrom","updatedAt")
         VALUES ($1,$2,$3,$4,'INVALID','X','EXCLUSIVE','DURING_TAX',0.1,'2030-01-01',now())`,
        [`invalid_treatment_${suffix}`, orgA, `profile_a_${suffix}`, `source_a_${suffix}`]
      )
    );
    const snapshot = await client.query(
      `SELECT "promotionEvaluationId", "promotionEvaluationHash"
       FROM restaurant_tax_transaction_snapshots WHERE id=$1`,
      [`snapshot_a_${suffix}`]
    );
    expect(snapshot.rows[0]).toEqual({
      promotionEvaluationId: null,
      promotionEvaluationHash: null,
    });
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_tax_transaction_snapshots SET "promotionEvaluationHash"='changed' WHERE id=$1`,
        [`snapshot_a_${suffix}`]
      )
    );
    await client.query(
      `INSERT INTO restaurant_tax_rate_bucket_snapshots
       (id,"organizationId","snapshotId","ruleVersionId","paymentCategory","priceMode",rate,"taxableAmount","taxAmount","grossAmount")
       VALUES ($1,$2,$3,$4,'SYNTHETIC_CARD','EXCLUSIVE',0.1,90,9,99)`,
      [`legacy_bucket_${suffix}`, orgA, `snapshot_a_${suffix}`, `rule_a_${suffix}`]
    );
    const bucket = await client.query(
      `SELECT "preDiscountGrossAmount", "beforeTaxDiscountAmount", "afterTaxDiscountAmount"
       FROM restaurant_tax_rate_bucket_snapshots WHERE id=$1`,
      [`legacy_bucket_${suffix}`]
    );
    expect(bucket.rows[0]).toEqual({
      preDiscountGrossAmount: '0.00',
      beforeTaxDiscountAmount: '0.00',
      afterTaxDiscountAmount: '0.00',
    });
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_tax_rate_bucket_snapshots SET "beforeTaxDiscountAmount"=10 WHERE id=$1`,
        [`legacy_bucket_${suffix}`]
      )
    );
  });

  it('has forced RLS on every tax table', async () => {
    await client.query('RESET ROLE');
    const taxCoreTables = [
      'restaurant_tax_official_sources',
      'restaurant_tax_profile_versions',
      'restaurant_tax_rate_bucket_snapshots',
      'restaurant_tax_refund_allocations',
      'restaurant_tax_rule_versions',
      'restaurant_tax_tender_allocation_snapshots',
      'restaurant_tax_transaction_snapshots',
    ];
    const result = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relkind='r' AND relname = ANY($1::text[])
       ORDER BY relname`,
      [taxCoreTables]
    );
    expect(result.rows).toEqual(
      taxCoreTables.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      }))
    );
    expect(
      (
        await client.query(
          'SELECT id FROM restaurant_tax_tender_allocation_snapshots WHERE "snapshotId"=$1',
          [`snapshot_a_${suffix}`]
        )
      ).rows
    ).toEqual([]);
  });

  it('pins the normalized refund-allocation constraints and append-only policies', async () => {
    await client.query('RESET ROLE');
    const constraints = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid='restaurant_tax_refund_allocations'::regclass ORDER BY conname`
    );
    expect(constraints.rows.map(({ conname }) => conname)).toEqual(
      expect.arrayContaining([
        'restaurant_tax_refund_allocation_positive_cents_ck',
        'restaurant_tax_refund_allocation_refund_fkey',
        'restaurant_tax_refund_allocation_original_fkey',
        'restaurant_tax_refund_allocation_cap',
      ])
    );
    const policies = await client.query<{ cmd: string; policyname: string; qual: string | null }>(
      `SELECT cmd, policyname, qual FROM pg_policies WHERE tablename='restaurant_tax_refund_allocations' ORDER BY cmd`
    );
    const demoReset = policies.rows.filter(
      ({ policyname }) => policyname === 'restaurant_demo_reset_delete'
    );
    expect(demoReset).toEqual([
      {
        cmd: 'DELETE',
        policyname: 'restaurant_demo_reset_delete',
        qual: 'restaurant_demo_reset_allowed("organizationId")',
      },
    ]);
    expect(
      policies.rows
        .filter(({ policyname }) => policyname !== 'restaurant_demo_reset_delete')
        .map(({ cmd }) => cmd)
    ).toEqual(['INSERT', 'SELECT']);
    await expectPgCode('23514', () =>
      client.query(
        `INSERT INTO restaurant_tax_refund_allocations
         (id,"organizationId","billId","refundId","originalTenderId","paymentCategory","originalSnapshotId","originalRateBucketSnapshotId","originalTenderAllocationId",cents)
         VALUES ($1,$2,'missing','missing','missing','CARD','missing','missing','missing',0)`,
        [`nonpositive_refund_allocation_${suffix}`, orgA]
      )
    );
  });

  it('rejects cross-tenant tender-allocation evidence under the restricted role', async () => {
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    await expectPgCode('42501', () =>
      client.query(
        `INSERT INTO restaurant_tax_tender_allocation_snapshots
         (id,"organizationId","snapshotId","rateBucketSnapshotId","originalTenderId","paymentCategory",cents)
         VALUES ($1,$2,'missing','missing','missing','CARD',1)`,
        [`cross_allocation_${suffix}`, orgB]
      )
    );
  });

  it('rejects every crafted cross-tenant tax relation under the restricted role', async () => {
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_profile_versions
         (id,"organizationId","branchId","versionNumber","effectiveFrom","updatedAt") VALUES ($1,$2,$3,2,'2040-01-01',now())`,
        [`cross_profile_${suffix}`, orgA, `branch_b_${suffix}`]
      )
    );
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_rule_versions
         (id,"organizationId","profileVersionId","officialSourceId","ruleCode","paymentCategory","priceMode",rate,"effectiveFrom","updatedAt")
         VALUES ($1,$2,$3,$4,'X','X','EXCLUSIVE',0.1,'2030-01-01',now())`,
        [`cross_rule_${suffix}`, orgA, `profile_b_${suffix}`, `source_b_${suffix}`]
      )
    );
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_transaction_snapshots
         (id,"organizationId","branchId","transactionReference","profileVersionId",currency,subtotal,"taxTotal","grandTotal","settledAt")
         VALUES ($1,$2,$3,'cross-snapshot',$4,'XXX',1,0,1,now())`,
        [`cross_snapshot_${suffix}`, orgA, `branch_b_${suffix}`, `profile_b_${suffix}`]
      )
    );
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_rate_bucket_snapshots
         (id,"organizationId","snapshotId","ruleVersionId","paymentCategory","priceMode",rate,"taxableAmount","taxAmount","grossAmount")
         VALUES ($1,$2,$3,$4,'X','EXCLUSIVE',0.1,1,0.1,1.1)`,
        [`cross_bucket_${suffix}`, orgA, `snapshot_b_${suffix}`, `rule_b_${suffix}`]
      )
    );
  });

  it('binds same-category tenders, supports partial sums, rejects wrong facts and replay', async () => {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const insertAllocation = (id: string, refundId: string, cents: number, overrides = '') =>
      client.query(
        `INSERT INTO restaurant_tax_refund_allocations
         (id,"organizationId","billId","refundId","originalTenderId","paymentCategory","originalSnapshotId","originalRateBucketSnapshotId","originalTenderAllocationId",cents)
         VALUES ($1,$2,$3,$4,$5,'CARD',$6,$7,$8,$9) ${overrides}`,
        [
          id,
          orgA,
          `bill_partial_${suffix}`,
          refundId,
          `tender_one_${suffix}`,
          `allocation_snapshot_${suffix}`,
          `allocation_bucket_${suffix}`,
          `original_one_${suffix}`,
          cents,
        ]
      );
    await insertAllocation(`partial_one_${suffix}`, `refund_one_${suffix}`, 20);
    await insertAllocation(`partial_two_${suffix}`, `refund_two_${suffix}`, 40);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    expect(
      (
        await client.query(
          `SELECT sum(cents)::text AS total FROM restaurant_tax_refund_allocations
           WHERE "originalTenderAllocationId"=$1`,
          [`original_one_${suffix}`]
        )
      ).rows[0]
    ).toEqual({ total: '60' });
    await expectPgCode('23505', () =>
      insertAllocation(`replay_${suffix}`, `refund_one_${suffix}`, 1)
    );
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_refund_allocations
         (id,"organizationId","billId","refundId","originalTenderId","paymentCategory","originalSnapshotId","originalRateBucketSnapshotId","originalTenderAllocationId",cents)
         VALUES ($1,$2,$3,$4,$5,'CARD',$6,$7,$8,1)`,
        [
          `wrong_tender_${suffix}`,
          orgA,
          `bill_partial_${suffix}`,
          `refund_race_a_${suffix}`,
          `tender_two_${suffix}`,
          `allocation_snapshot_${suffix}`,
          `allocation_bucket_${suffix}`,
          `original_one_${suffix}`,
        ]
      )
    );
    await expectPgCode('23514', () =>
      insertAllocation(`over_cap_${suffix}`, `refund_over_${suffix}`, 1)
    );
  });

  it('links one exact full reversal once and leaves cumulative partial completion unlinked', async () => {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO restaurant_tax_refund_allocations
       (id,"organizationId","billId","refundId","originalTenderId","paymentCategory","originalSnapshotId","originalRateBucketSnapshotId","originalTenderAllocationId",cents)
       VALUES ($1,$2,$3,$4,$5,'CARD',$6,$7,$8,55)`,
      [
        `full_allocation_${suffix}`,
        orgA,
        `bill_full_${suffix}`,
        `refund_full_${suffix}`,
        `tender_full_${suffix}`,
        `full_snapshot_${suffix}`,
        `full_bucket_${suffix}`,
        `original_full_${suffix}`,
      ]
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query(
      `INSERT INTO restaurant_tax_transaction_snapshots
       (id,"organizationId","branchId","billId","transactionReference","profileVersionId",currency,subtotal,"taxTotal","grandTotal","settledAt","reversesSnapshotId","reversalReason")
       VALUES ($1,$2,$3,$4,$1,$5,'XXX',-50,-5,-55,now(),$6,'full refund')`,
      [
        `full_reversal_${suffix}`,
        orgA,
        `branch_a_${suffix}`,
        `bill_full_${suffix}`,
        `profile_a_${suffix}`,
        `full_snapshot_${suffix}`,
      ]
    );
    await client.query(`UPDATE restaurant_refunds SET "fullReversalSnapshotId"=$1 WHERE id=$2`, [
      `full_reversal_${suffix}`,
      `refund_full_${suffix}`,
    ]);
    await expectPgCode('55000', () =>
      client.query(`UPDATE restaurant_refunds SET "fullReversalSnapshotId"=NULL WHERE id=$1`, [
        `refund_full_${suffix}`,
      ])
    );
    expect(
      (
        await client.query(`SELECT "fullReversalSnapshotId" FROM restaurant_refunds WHERE id=$1`, [
          `refund_two_${suffix}`,
        ])
      ).rows[0]
    ).toEqual({ fullReversalSnapshotId: null });
  });

  it('denies refund-allocation mutation to runtime and platform paths', async () => {
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    expect(
      (
        await client.query(`UPDATE restaurant_tax_refund_allocations SET cents=1 WHERE id=$1`, [
          `partial_one_${suffix}`,
        ])
      ).rowCount
    ).toBe(0);
    expect(
      (
        await client.query(`DELETE FROM restaurant_tax_refund_allocations WHERE id=$1`, [
          `partial_one_${suffix}`,
        ])
      ).rowCount
    ).toBe(0);
    await client.query('RESET ROLE');
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    expect(
      (
        await client.query(`UPDATE restaurant_tax_refund_allocations SET cents=1 WHERE id=$1`, [
          `partial_one_${suffix}`,
        ])
      ).rowCount
    ).toBe(0);
    expect(
      (
        await client.query(`DELETE FROM restaurant_tax_refund_allocations WHERE id=$1`, [
          `partial_one_${suffix}`,
        ])
      ).rowCount
    ).toBe(0);
    expect(
      (
        await client.query(
          `SELECT tgenabled FROM pg_trigger
           WHERE tgrelid='restaurant_tax_refund_allocations'::regclass
             AND tgname='restaurant_tax_refund_allocation_immutable'
             AND NOT tgisinternal`
        )
      ).rows
    ).toEqual([{ tgenabled: 'O' }]);
  });

  it('serializes two over-cap commits with one success and one failure', async () => {
    await client.query('RESET ROLE');
    await client.query('COMMIT');
    const first = new pg.Client({ connectionString: url });
    const second = new pg.Client({ connectionString: url });
    await Promise.all([first.connect(), second.connect()]);
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      await Promise.all([
        first.query(
          `SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','true',true)`,
          [orgA]
        ),
        second.query(
          `SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','true',true)`,
          [orgA]
        ),
      ]);
      const values = (id: string, refundId: string) => [
        id,
        orgA,
        `bill_partial_${suffix}`,
        refundId,
        `tender_two_${suffix}`,
        `allocation_snapshot_${suffix}`,
        `allocation_bucket_${suffix}`,
        `original_two_${suffix}`,
      ];
      const sql = `INSERT INTO restaurant_tax_refund_allocations
        (id,"organizationId","billId","refundId","originalTenderId","paymentCategory","originalSnapshotId","originalRateBucketSnapshotId","originalTenderAllocationId",cents)
        VALUES ($1,$2,$3,$4,$5,'CARD',$6,$7,$8,30)`;
      await Promise.all([
        first.query(sql, values(`race_a_${suffix}`, `refund_race_a_${suffix}`)),
        second.query(sql, values(`race_b_${suffix}`, `refund_race_b_${suffix}`)),
      ]);
      await first.query('COMMIT');
      await expect(second.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
      await second.query('ROLLBACK');
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
    await client.query('BEGIN');
  }, 15_000);

  it('accepts one exact full reversal and rejects positive, over-value, duplicate, and cross-tenant reversals', async () => {
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    const reversalInsert = (id: string, subtotal: number, target = `snapshot_a_${suffix}`) =>
      client.query(
        `INSERT INTO restaurant_tax_transaction_snapshots
         (id,"organizationId","branchId","transactionReference","profileVersionId",currency,subtotal,"discountTotal","serviceChargeTotal","taxTotal","grandTotal","settledAt","reversesSnapshotId","reversalReason")
         VALUES ($1,$2,$3,$1,$4,'XXX',$5,-10,-5,-9.5,-104.5,now(),$6,'synthetic correction')`,
        [id, orgA, `branch_a_${suffix}`, `profile_a_${suffix}`, subtotal, target]
      );
    await expectPgCode('23514', () => reversalInsert(`positive_${suffix}`, 100));
    await expectPgCode('23514', () => reversalInsert(`over_${suffix}`, -101));
    await expectPgCode('23503', () =>
      reversalInsert(`cross_tenant_${suffix}`, -100, `snapshot_b_${suffix}`)
    );
    await reversalInsert(`valid_reversal_${suffix}`, -100);
    await expectPgCode('23505', () => reversalInsert(`duplicate_${suffix}`, -100));
  });

  it('uses a database exclusion constraint across two concurrent connections', async () => {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const concurrentOrg = `tax_concurrent_${suffix}`;
    const concurrentBranch = `branch_concurrent_${suffix}`;
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [concurrentOrg]
    );
    await client.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,'Concurrent',now())`,
      [concurrentBranch, concurrentOrg]
    );
    await client.query('COMMIT');

    const first = new pg.Client({ connectionString: url });
    const second = new pg.Client({ connectionString: url });
    await Promise.all([first.connect(), second.connect()]);
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      await Promise.all([
        first.query(
          `SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','true',true)`,
          [concurrentOrg]
        ),
        second.query(
          `SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','true',true)`,
          [concurrentOrg]
        ),
      ]);
      await first.query(
        `INSERT INTO restaurant_tax_profile_versions
         (id,"organizationId","branchId","versionNumber",status,"effectiveFrom","effectiveTo","approvalReference","approvedAt","publishedAt","updatedAt")
         VALUES ($1,$2,$3,1,'PUBLISHED','2040-01-01','2041-01-01','SYNTHETIC',now(),now(),now())`,
        [`concurrent_one_${suffix}`, concurrentOrg, concurrentBranch]
      );
      const overlapping = second.query(
        `INSERT INTO restaurant_tax_profile_versions
         (id,"organizationId","branchId","versionNumber",status,"effectiveFrom","effectiveTo","approvalReference","approvedAt","publishedAt","updatedAt")
         VALUES ($1,$2,$3,2,'PUBLISHED','2040-06-01','2041-06-01','SYNTHETIC',now(),now(),now())`,
        [`concurrent_two_${suffix}`, concurrentOrg, concurrentBranch]
      );
      await first.query('COMMIT');
      await expect(overlapping).rejects.toMatchObject({ code: '23P01' });
      await second.query('ROLLBACK');
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
    await client.query('BEGIN');
  });
});
