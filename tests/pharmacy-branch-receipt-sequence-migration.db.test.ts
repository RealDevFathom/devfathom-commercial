// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

// DEV-637. Needs a role that owns the schema (it rebuilds the pre-migration shape inside a
// transaction it always rolls back), so it runs only when OWNER_DATABASE_URL is set.
const url = process.env.OWNER_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261118121900_pharmacy_branch_receipt_sequence/migration.sql',
  'utf8'
);
// The test supplies the transaction, so the migration's own BEGIN/COMMIT are dropped.
const body = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

(url ? describe : describe.skip)(
  'DEV-637 branch receipt sequence migration on existing data',
  () => {
    it('keeps duplicate older numbers, starts above the branch maximum and never reuses one', async () => {
      const suffix = randomBytes(6).toString('hex');
      const org = `org_dev637_${suffix}`;
      const branch = `branch_dev637_${suffix}`;
      const quiet = `branch_dev637_quiet_${suffix}`;
      const client = new Client({ connectionString: url });
      await client.connect();
      const failure = async (sql: string, params: unknown[] = []) => {
        await client.query('SAVEPOINT attempt');
        try {
          await client.query(sql, params);
          return 'ACCEPTED';
        } catch (error) {
          return (error as Error).message;
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT attempt');
        }
      };
      const sale = (id: string, branchId: string, device: string, receiptNumber: number) =>
        client.query(
          `INSERT INTO pharmacy_sales (id, "organizationId", "branchId", status, "createdByUserId",
           "receiptNumber", "receiptDeviceId", "businessDate", "completedAt", "updatedAt")
         VALUES ($1, $2, $3, 'COMPLETED', 'user_dev637', $4, $5, DATE '2026-11-02', now(), now())`,
          [id, org, branchId, receiptNumber, device]
        );
      try {
        await client.query('BEGIN');
        // The owner is NOBYPASSRLS and these tables force row-level security, so write as
        // the platform (organizations, branches) inside this tenant (pharmacy_sales admits
        // only its own organization), for this transaction only.
        await client.query(
          `SELECT set_config('app.is_platform_admin', 'true', true),
                  set_config('app.current_organization_id', $1, true)`,
          [org]
        );
        await client.query(
          `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status,
           "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
          [org]
        );
        for (const id of [branch, quiet])
          await client.query(
            `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city,
             "provinceCode", "updatedAt")
           VALUES ($1, $2, $1, $1, '1 Test Road', 'Lahore', 'PB', now())`,
            [id, org]
          );

        // The shape before this migration, inside this transaction only.
        await client.query(`
        DROP TRIGGER IF EXISTS pharmacy_sales_branch_receipt_number ON pharmacy_sales;
        DROP INDEX IF EXISTS pharmacy_sales_branch_receipt_number_key;
        DROP INDEX IF EXISTS pharmacy_sales_legacy_receipt_number_idx;
        ALTER TABLE pharmacy_sales DROP COLUMN IF EXISTS "receiptNumberBranchUnique";
        ALTER TABLE pharmacy_sales DROP COLUMN IF EXISTS "offlineReceiptReference";
        DROP TABLE IF EXISTS pharmacy_branch_receipt_sequences;`);

        // Per-device numbering already printed "Receipt 1" twice in this branch.
        await sale(`sale_a1_${suffix}`, branch, 'counter-a', 1);
        await sale(`sale_b1_${suffix}`, branch, 'counter-b', 1);
        await sale(`sale_a2_${suffix}`, branch, 'counter-a', 2);
        await sale(`sale_b9_${suffix}`, branch, 'counter-b', 9);
        // A per-device sequence and a lease that reserved numbers above every issued one.
        // Written past the current lease guard, which postdates this data. The owner is no
        // superuser, so it switches the table's own triggers off rather than all triggers;
        // the ALTER is part of the transaction and is rolled back with it.
        await client.query('ALTER TABLE pharmacy_receipt_number_leases DISABLE TRIGGER USER');
        // A lease belongs to a registered counter of the branch (foreign key).
        for (const device of ['counter-d', 'counter-e'])
          await client.query(
            `INSERT INTO pharmacy_registered_devices (id, "organizationId", "branchId", name,
             "deviceSecretHash", "enrolledByActorId", "updatedAt")
           VALUES ($1, $2, $3, $1, encode(sha256(convert_to($1 || $4, 'UTF8')), 'hex'),
             'user_dev637', now())`,
            [device, org, branch, suffix]
          );
        await client.query(
          `INSERT INTO pharmacy_receipt_number_sequences (id, "organizationId", "branchId", "deviceId",
           "nextNumber", "updatedAt") VALUES ($1, $2, $3, 'counter-c', 12, now())`,
          [`seq_${suffix}`, org, branch]
        );
        await client.query(
          `INSERT INTO pharmacy_receipt_number_leases (id, "organizationId", "branchId", "deviceId",
           "blockStart", "blockEnd", "nextNumber", "issuedToActorId")
         VALUES ($1, $2, $3, 'counter-d', 13, 15, 13, 'user_dev637')`,
          [`lease_${suffix}`, org, branch]
        );
        await client.query('ALTER TABLE pharmacy_receipt_number_leases ENABLE TRIGGER USER');

        await client.query(body);
        await client.query(body); // safe to re-run

        const legacy = await client.query(
          `SELECT "receiptNumber", "receiptDeviceId", "receiptNumberBranchUnique" FROM pharmacy_sales
         WHERE "branchId" = $1 ORDER BY id`,
          [branch]
        );
        expect(legacy.rows).toEqual([
          { receiptNumber: 1, receiptDeviceId: 'counter-a', receiptNumberBranchUnique: false },
          { receiptNumber: 2, receiptDeviceId: 'counter-a', receiptNumberBranchUnique: false },
          { receiptNumber: 1, receiptDeviceId: 'counter-b', receiptNumberBranchUnique: false },
          { receiptNumber: 9, receiptDeviceId: 'counter-b', receiptNumberBranchUnique: false },
        ]);

        const draw = async (branchId: string, count: number) =>
          (
            await client.query<{ first: number }>(
              'SELECT pharmacy_allocate_branch_receipt_numbers($1, $2, $3) AS first',
              [org, branchId, count]
            )
          ).rows[0]!.first;
        // Above issued (9), the per-device sequence (11) and the leased block (15).
        expect(await draw(branch, 1)).toBe(16);
        expect(await draw(branch, 5)).toBe(17);
        expect(await draw(branch, 1)).toBe(22);
        // A branch with no history starts at 1.
        expect(await draw(quiet, 1)).toBe(1);

        // An older number is never issued again in the branch, from any counter.
        expect(
          await failure(
            `INSERT INTO pharmacy_sales (id, "organizationId", "branchId", status, "createdByUserId",
             "receiptNumber", "receiptDeviceId", "businessDate", "completedAt", "updatedAt")
           VALUES ($1, $2, $3, 'COMPLETED', 'user_dev637', 2, 'counter-new', DATE '2026-11-18',
             now(), now())`,
            [`sale_reuse_${suffix}`, org, branch]
          )
        ).toContain('RECEIPT_NUMBER_TAKEN');

        await sale(`sale_new_${suffix}`, branch, 'counter-new', 16);
        const created = await client.query(
          `SELECT "receiptNumberBranchUnique" FROM pharmacy_sales WHERE id = $1`,
          [`sale_new_${suffix}`]
        );
        expect(created.rows[0]).toEqual({ receiptNumberBranchUnique: true });
        expect(
          await failure(
            `INSERT INTO pharmacy_sales (id, "organizationId", "branchId", status, "createdByUserId",
             "receiptNumber", "receiptDeviceId", "businessDate", "completedAt", "updatedAt")
           VALUES ($1, $2, $3, 'COMPLETED', 'user_dev637', 16, 'counter-other', DATE '2026-11-18',
             now(), now())`,
            [`sale_dup_${suffix}`, org, branch]
          )
        ).toContain('pharmacy_sales_branch_receipt_number_key');

        // The new lease guard checks every counter of the branch against the branch sequence.
        expect(
          await failure(
            `INSERT INTO pharmacy_receipt_number_leases (id, "organizationId", "branchId", "deviceId",
             "blockStart", "blockEnd", "nextNumber", "issuedToActorId")
           VALUES ($1, $2, $3, 'counter-e', 30, 40, 30, 'user_dev637')`,
            [`lease_ahead_${suffix}`, org, branch]
          )
        ).toContain('RECEIPT_LEASE_NOT_RESERVED');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    });
  }
);
