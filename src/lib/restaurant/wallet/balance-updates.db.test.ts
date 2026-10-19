/**
 * Real PostgreSQL regression for the lifetime retry ceiling. Requires separate
 * migrated owner and LOGIN/NOSUPERUSER/NOBYPASSRLS runtime database URLs.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const RUNTIME_DATABASE_URL =
  process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (RUNTIME_DATABASE_URL) process.env.DATABASE_URL = RUNTIME_DATABASE_URL;

const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ids = {
  organization: `org_wallet_retry_${suffix}`,
  customer: `customer_wallet_retry_${suffix}`,
  account: `account_wallet_retry_${suffix}`,
  pass: `pass_wallet_retry_${suffix}`,
  update: `update_wallet_retry_${suffix}`,
};

let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let reconcileWalletUpdates: (typeof import('./balance-updates'))['reconcileWalletUpdates'];

function tenant<T>(work: (db: ScopedDb) => Promise<T>) {
  return withTenantDb(ids.organization, work);
}

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(RUNTIME_DATABASE_URL).not.toBe(OWNER_DATABASE_URL);

  const runtime = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await runtime.connect();
  try {
    const role = await runtime.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  } finally {
    await runtime.end();
  }

  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
         ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'Wallet Retry Test', 'Wallet Retry Test', 'ACTIVE', 'SHARED', now(), now())`,
      [ids.organization, `wallet-retry-${suffix}`]
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await owner.end();
  }

  ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
  ({ reconcileWalletUpdates } = await import('./balance-updates'));

  await tenant(async (db) => {
    await db.restaurantCustomer.create({ data: { id: ids.customer } });
    await db.loyaltyAccount.create({
      data: { id: ids.account, customerId: ids.customer },
    });
    await db.walletPass.create({
      data: {
        id: ids.pass,
        customerId: ids.customer,
        loyaltyAccountId: ids.account,
        platform: 'GOOGLE',
        serialNumber: `opaque-${suffix}`,
        lastPushedBalance: 1,
      },
    });
    await db.walletPassUpdate.create({
      data: {
        id: ids.update,
        passId: ids.pass,
        reason: 'RECONCILE',
        status: 'FAILED',
        attempts: 8,
        nextAttemptAt: new Date(),
      },
    });
  });
});

describeIfDatabase('wallet reconciliation lifetime retry budget (real PostgreSQL)', () => {
  it('does not restart the budget after a terminal failure', async () => {
    await expect(tenant((db) => reconcileWalletUpdates(db))).resolves.toBe(0);
    await expect(tenant((db) => reconcileWalletUpdates(db))).resolves.toBe(0);

    const updates = await tenant((db) =>
      db.walletPassUpdate.findMany({
        where: { passId: ids.pass },
        select: { status: true, attempts: true },
      })
    );
    expect(updates).toEqual([{ status: 'FAILED', attempts: 8 }]);
  });
});
