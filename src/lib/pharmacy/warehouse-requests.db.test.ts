// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LedgerScope } from './stock-ledger';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const tag = randomUUID();
const org = 'wh-request-' + tag;
const site = 'central-' + tag;
const branch = 'store-' + tag;
const second = 'second-' + tag;
const medicineId = 'controlled-' + tag;
const bin = 'secure-' + tag;
const scope: LedgerScope = { organizationId: org, branchId: branch, actorId: 'user-' + tag };
const input = {
  warehouseBranchId: site,
  destinationStockLocationId: bin,
  medicineId,
  requestedUnits: 11,
  idempotencyKey: 'branch-request',
};
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let service: typeof import('./warehouse-requests');

describe.skipIf(!url)('branch warehouse demand on PostgreSQL', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    service = await import('./warehouse-requests');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: org,
          slug: org,
          displayName: 'Warehouse test',
          legalName: 'Warehouse test',
          status: 'ACTIVE',
        },
      })
    );
    await tenancy.withTenantDb(org, async (db) => {
      for (const id of [site, branch, second])
        await db.pharmacyBranch.create({
          data: {
            id,
            organizationId: org,
            code: id,
            name: id,
            addressLine: 'Test road',
            city: 'Lahore',
            provinceCode: 'PB',
            warehouseEnabled: id === site,
          },
        });
      await db.pharmacyStockLocation.create({
        data: {
          id: bin,
          organizationId: org,
          branchId: branch,
          code: 'SAFE',
          name: 'Safe',
          kind: 'SAFE',
        },
      });
      await db.medicine.create({
        data: {
          id: medicineId,
          organizationId: org,
          productName: 'Test controlled preparation',
          saleable: true,
          controlled: true,
          productFamily: 'PHARMACEUTICAL',
        },
      });
      const presentation = await db.presentation.create({
        data: { organizationId: org, medicineId, presentation: 'Tablets' },
      });
      await db.packLevel.create({
        data: {
          organizationId: org,
          presentationId: presentation.id,
          versionGroupId: tag,
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date(0),
        },
      });
    });
  });

  it('routes concurrent controlled requests once to local purchasing and rounds up to the catalog pack', async () => {
    const submit = () =>
      tenancy.withTenantDb(org, (db) => service.submitWarehouseRequest(db, scope, input));
    const [first, retried] = await Promise.all([submit(), submit()]);
    expect(first.id).toBe(retried.id);
    expect(first.status).toBe('DIRECT_PURCHASE');
    await expect(
      tenancy.withTenantDb(org, (db) =>
        service.submitWarehouseRequest(db, scope, { ...input, requestedUnits: 12 })
      )
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      tenancy.withTenantDb(org, (db) =>
        service.purchaseWarehouseRequest(db, { ...scope, branchId: second }, first.id)
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const purchase = () =>
      tenancy.withTenantDb(org, (db) => service.purchaseWarehouseRequest(db, scope, first.id));
    const [placed, copy] = await Promise.all([purchase(), purchase()]);
    expect(placed.requisitionId).toBe(copy.requisitionId);
    await tenancy.withTenantDb(org, async (db) => {
      const req = await db.pharmacyRequisition.findUniqueOrThrow({
        where: { id: placed.requisitionId! },
        include: { lines: true },
      });
      expect(req).toMatchObject({
        status: 'DRAFT',
        branchId: branch,
        lines: [{ quantityPacks: 2, canonicalUnits: 20, medicineId }],
      });
      expect(await db.pharmacyInterbranchTransfer.count({ where: { organizationId: org } })).toBe(
        0
      );
    });
  });
  it('withdraws unfilled demand without issuing a transfer or a requisition', async () => {
    const request = await tenancy.withTenantDb(org, (db) =>
      service.submitWarehouseRequest(db, scope, {
        ...input,
        idempotencyKey: 'withdrawn-request',
      })
    );
    const withdraw = () =>
      tenancy.withTenantDb(org, (db) => service.withdrawWarehouseRequest(db, scope, request.id));
    expect((await withdraw()).status).toBe('CANCELLED');
    expect((await withdraw()).status).toBe('CANCELLED');
    await expect(
      tenancy.withTenantDb(org, (db) => service.purchaseWarehouseRequest(db, scope, request.id))
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('refuses a receiving bin owned by another branch and hides the request from another tenant', async () => {
    await expect(
      tenancy.withTenantDb(org, (db) =>
        service.submitWarehouseRequest(
          db,
          { ...scope, branchId: second },
          { ...input, idempotencyKey: 'wrong-bin' }
        )
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const other = 'other-' + tag;
    const result = await tenancy.withTenantDb(other, (db) =>
      service.listWarehouseRequests(db, { ...scope, organizationId: other })
    );
    expect(result.requests).toEqual([]);
  });
});
