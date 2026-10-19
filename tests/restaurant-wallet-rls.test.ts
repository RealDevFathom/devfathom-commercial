import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.WALLET_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const runtime = runtimeUrl ? new pg.Client({ connectionString: runtimeUrl }) : null;
const owner = ownerUrl ? new pg.Client({ connectionString: ownerUrl }) : null;
const suffix = Date.now().toString(36);
const orgA = `wallet_org_a_${suffix}`;
const orgB = `wallet_org_b_${suffix}`;
const rowIds = Object.fromEntries(
  [
    'restaurant_wallet_passes',
    'restaurant_wallet_pass_registrations',
    'restaurant_wallet_pass_updates',
    'restaurant_wallet_tenant_config',
    'restaurant_wallet_enrollment_links',
    'restaurant_wallet_enrollment_attempts',
  ].map((table) => [table, [`${table}_a_${suffix}`, `${table}_b_${suffix}`]])
) as Record<(typeof TABLES)[number], [string, string]>;

const TABLES = [
  'restaurant_wallet_passes',
  'restaurant_wallet_pass_registrations',
  'restaurant_wallet_pass_updates',
  'restaurant_wallet_tenant_config',
  'restaurant_wallet_enrollment_links',
  'restaurant_wallet_enrollment_attempts',
] as const;

describeIfDatabase('wallet L1 forced RLS (real PostgreSQL)', () => {
  beforeAll(async () => {
    for (const url of [runtimeUrl!, ownerUrl!]) {
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname)) {
        throw new Error('Refusing to run wallet RLS probes against a non-local database.');
      }
    }
    await owner!.connect();
    await runtime!.connect();
    await owner!.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await owner!.query(
      `INSERT INTO "organizations" ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt") VALUES
       ($1, $2, 'Wallet A', 'Wallet A', 'ACTIVE', 'SHARED', now(), now()),
       ($3, $4, 'Wallet B', 'Wallet B', 'ACTIVE', 'SHARED', now(), now())`,
      [orgA, orgA, orgB, orgB]
    );
    for (const org of [orgA, orgB]) {
      const marker = org === orgA ? 'a' : 'b';
      await owner!.query(
        `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt") VALUES ($1, $2, 'Wallet branch', now())`,
        [`branch_${marker}_${suffix}`, org]
      );
      await owner!.query(
        `INSERT INTO "restaurant_customers" ("id", "organizationId", "updatedAt") VALUES ($1, $2, now())`,
        [`customer_${marker}_${suffix}`, org]
      );
      await owner!.query(
        `INSERT INTO "restaurant_loyalty_accounts" ("id", "organizationId", "customerId", "updatedAt") VALUES ($1, $2, $3, now())`,
        [`account_${marker}_${suffix}`, org, `customer_${marker}_${suffix}`]
      );
      await owner!.query(
        `INSERT INTO "restaurant_wallet_tenant_config" ("id", "organizationId", "programDisplayName", "googleClassSuffix", "updatedAt") VALUES ($1, $2, 'Rewards', $3, now())`,
        [rowIds.restaurant_wallet_tenant_config[marker === 'a' ? 0 : 1], org, `wgc_${org}`]
      );
      const position = marker === 'a' ? 0 : 1;
      const passId = rowIds.restaurant_wallet_passes[position];
      await owner!.query(
        `INSERT INTO "restaurant_wallet_passes" ("id", "organizationId", "customerId", "loyaltyAccountId", "platform", "serialNumber", "updatedAt") VALUES ($1, $2, $3, $4, 'APPLE', $5, now())`,
        [
          passId,
          org,
          `customer_${marker}_${suffix}`,
          `account_${marker}_${suffix}`,
          `wps_${marker}_${suffix}`,
        ]
      );
      await owner!.query(
        `INSERT INTO "restaurant_wallet_pass_registrations" ("id", "organizationId", "passId", "deviceLibraryIdentifier", "pushToken", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`,
        [
          rowIds.restaurant_wallet_pass_registrations[position],
          org,
          passId,
          `device_${marker}_${suffix}`,
          `push_${marker}_${suffix}`,
        ]
      );
      await owner!.query(
        `INSERT INTO "restaurant_wallet_pass_updates" ("id", "organizationId", "passId", "reason", "nextAttemptAt", "updatedAt") VALUES ($1, $2, $3, 'LEDGER', now(), now())`,
        [rowIds.restaurant_wallet_pass_updates[position], org, passId]
      );
      await owner!.query(
        `INSERT INTO "restaurant_wallet_enrollment_links" ("id", "organizationId", "branchId", "tokenHash") VALUES ($1, $2, $3, $4)`,
        [
          rowIds.restaurant_wallet_enrollment_links[position],
          org,
          `branch_${marker}_${suffix}`,
          `hash_${marker}_${suffix}`,
        ]
      );
      await owner!.query(
        `INSERT INTO "restaurant_wallet_enrollment_attempts" ("id", "organizationId", "branchId", "identifierKind", "normalizedValue", "otpHash", "expiresAt") VALUES ($1, $2, $3, 'EMAIL', $4, $5, now() + interval '10 minutes')`,
        [
          rowIds.restaurant_wallet_enrollment_attempts[position],
          org,
          `branch_${marker}_${suffix}`,
          `${marker}@example.test`,
          `otp_${marker}_${suffix}`,
        ]
      );
    }
    await runtime!.query('BEGIN');
    await runtime!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await runtime!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
  });

  afterAll(async () => {
    if (runtime) {
      await runtime.query('ROLLBACK');
      await runtime.end();
    }
    if (owner) {
      for (const table of [...TABLES].reverse()) {
        await owner.query(`DELETE FROM "${table}" WHERE "organizationId" IN ($1, $2)`, [
          orgA,
          orgB,
        ]);
      }
      await owner.query(
        `DELETE FROM "restaurant_loyalty_accounts" WHERE "organizationId" IN ($1, $2)`,
        [orgA, orgB]
      );
      await owner.query(`DELETE FROM "restaurant_customers" WHERE "organizationId" IN ($1, $2)`, [
        orgA,
        orgB,
      ]);
      await owner.query(`DELETE FROM "restaurant_branches" WHERE "organizationId" IN ($1, $2)`, [
        orgA,
        orgB,
      ]);
      await owner.query(`DELETE FROM "organizations" WHERE "id" IN ($1, $2)`, [orgA, orgB]);
      await owner.end();
    }
  });

  it('proves the runtime role and FORCE RLS metadata for all six tables', async () => {
    const role = await runtime!.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);

    const metadata = await runtime!.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [[...TABLES]]
    );
    expect(metadata.rows).toEqual(
      [...TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      }))
    );
  });

  it.each(TABLES)('%s hides cross-org reads and writes', async (table) => {
    const [idA, idB] = rowIds[table];
    const visible = await runtime!.query(
      `SELECT "id", "organizationId" FROM "${table}" WHERE "id" IN ($1, $2)`,
      [idA, idB]
    );
    expect(visible.rows).toEqual([{ id: idA, organizationId: orgA }]);
    expect(
      (
        await runtime!.query(
          `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
          [idB]
        )
      ).rowCount
    ).toBe(0);
    expect((await runtime!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [idB])).rowCount).toBe(
      0
    );
  });
});
