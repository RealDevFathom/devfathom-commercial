import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrintJob, PrintRoutingConfig } from './contract';
import { PrintBridgeService } from './service';
import { SimulatedPrintBridgeAdapter } from './stub';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgA = `org_print_a_${suffix}`;
const orgB = `org_print_b_${suffix}`;
const branchA = `branch_print_a_${suffix}`;
const branchB = `branch_print_b_${suffix}`;

let tenancy: typeof import('@/lib/tenancy/scoped-db');

const config: PrintRoutingConfig = {
  branchId: branchA,
  routes: [{ documentType: 'BAR_TICKET', stationId: null, printerId: 'printer-a', enabled: true }],
};
const job: PrintJob = {
  branchId: branchA,
  stationId: null,
  idempotencyKey: `print-replay-${suffix}`,
  document: {
    type: 'BAR_TICKET',
    reference: 'KOT 42',
    title: 'BAR',
    createdAt: '2026-08-29T08:00:00.000Z',
    lines: [{ quantity: 1, label: 'Soda' }],
  },
};

describeIfDatabase('durable print bridge', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb(async (db) => {
      await db.organization.createMany({
        data: [
          { id: orgA, slug: orgA, legalName: orgA, displayName: orgA },
          { id: orgB, slug: orgB, legalName: orgB, displayName: orgB },
        ],
      });
    });
    await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantBranch.create({ data: { id: branchA, organizationId: orgA, name: 'A' } })
    );
    await tenancy.withTenantDb(orgB, (db) =>
      db.restaurantBranch.create({ data: { id: branchB, organizationId: orgB, name: 'B' } })
    );
  });

  afterAll(async () => {
    if (!tenancy) return;
    await tenancy.withPlatformDb((db) =>
      db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    );
  });

  it('persists configuration and RLS hides it across tenants', async () => {
    await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantPrintRoute.create({
        data: { organizationId: orgA, branchId: branchA, ...config.routes[0] },
      })
    );
    await expect(tenancy.withTenantDb(orgA, (db) => db.restaurantPrintRoute.count())).resolves.toBe(
      1
    );
    await expect(tenancy.withTenantDb(orgB, (db) => db.restaurantPrintRoute.count())).resolves.toBe(
      0
    );
  });

  it('survives service restart and concurrent replay without duplicate delivery', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    const submit = () =>
      tenancy.withTenantDb(orgA, (db) =>
        new PrintBridgeService(adapter, db).submit(orgA, config, job)
      );
    const [first, second] = await Promise.all([submit(), submit()]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(adapter.deliveries).toHaveLength(1);
    await expect(submit()).resolves.toMatchObject({ status: 'PRINTED', replayed: true });
    expect(adapter.deliveries).toHaveLength(1);
  });

  it('persists offline retry state and prints once after recovery', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    const retryJob = { ...job, idempotencyKey: `offline-retry-${suffix}` };
    adapter.setOffline('printer-a', true);
    await expect(
      tenancy.withTenantDb(orgA, (db) =>
        new PrintBridgeService(adapter, db).submit(orgA, config, retryJob)
      )
    ).resolves.toMatchObject({ status: 'OFFLINE' });
    adapter.setOffline('printer-a', false);
    await expect(
      tenancy.withTenantDb(orgA, (db) =>
        new PrintBridgeService(adapter, db).submit(orgA, config, retryJob)
      )
    ).resolves.toMatchObject({ status: 'PRINTED', replayed: false });
    expect(adapter.deliveries).toHaveLength(1);
    const stored = await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantPrintJob.findUniqueOrThrow({
        where: {
          organizationId_branchId_idempotencyKey: {
            organizationId: orgA,
            branchId: branchA,
            idempotencyKey: retryJob.idempotencyKey,
          },
        },
      })
    );
    expect(stored).toMatchObject({ status: 'PRINTED', attemptCount: 2 });
  });
});
