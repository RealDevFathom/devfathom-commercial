/**
 * #724 — duplicate-salt acknowledgement against PostgreSQL under RLS.
 *
 * Two paracetamol brands on one persisted bill are recognised from the
 * ingredient graph; the router persists the audit row in the request transaction;
 * the counter cart carries the salts; and the server refuses to acknowledge a
 * bill in another branch or another tenant.
 * Skipped unless TEST_DATABASE_URL is set (a NOSUPERUSER NOBYPASSRLS role).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '@/server/trpc';
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';

import { readCounterCart } from './counter';
import {
  DuplicateSaltAcknowledgementError,
  verifyDuplicateSaltAcknowledgement,
} from './duplicate-salt-acknowledgement';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const client = url ? db : null;
const describeIfDatabase = url ? describe : describe.skip;

const orgA = `org_ds724_a_${randomUUID()}`;
const orgB = `org_ds724_b_${randomUUID()}`;
const branchA = `br_ds724_a_${randomUUID()}`;
const branchA2 = `br_ds724_a2_${randomUUID()}`;
const actorId = `ds724-actor-${randomUUID()}`;
const app = router({ pharmacySales: pharmacySalesRouter });

function acknowledgementCaller(dbx: ScopedDb) {
  const context = {
    db: dbx,
    entitlements: { organizationId: orgA, enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: '2099-01-01T00:00:00Z',
      user: { id: actorId, role: 'EMPLOYEE', status: 'ACTIVE', organizationId: orgA },
    },
    organization: { id: orgA, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return app.createCaller(context).pharmacySales;
}

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>) {
  if (!client) throw new Error('TEST_DATABASE_URL required');
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
        organizationId
      );
      return work(tx as ScopedDb);
    },
    { timeout: 30_000 }
  );
}

async function medicineWith(dbx: ScopedDb, productName: string, ingredientId: string) {
  const medicine = await dbx.medicine.create({
    data: {
      organizationId: orgA,
      productName,
      productFamily: 'PHARMACEUTICAL',
      saleable: true,
      presentations: { create: { organizationId: orgA, presentation: `${productName} tablet` } },
    },
    include: { presentations: true },
  });
  await dbx.medicineStrengthComponent.create({
    data: { organizationId: orgA, medicineId: medicine.id, ingredientId, value: 500, unit: 'mg' },
  });
  const presentation = medicine.presentations[0]!;
  const pack = await dbx.packLevel.create({
    data: {
      organizationId: orgA,
      presentationId: presentation.id,
      versionGroupId: randomUUID(),
      version: 1,
      level: 'STRIP',
      unitsPerParent: 10,
      effectiveFrom: new Date('2026-01-01'),
    },
  });
  return { medicineId: medicine.id, presentationId: presentation.id, packLevelId: pack.id };
}

async function saleWith(
  dbx: ScopedDb,
  medicines: Array<{ medicineId: string; presentationId: string; packLevelId: string }>
) {
  const sale = await dbx.pharmacySale.create({
    data: { organizationId: orgA, branchId: branchA, createdByUserId: actorId },
  });
  const lineIds: string[] = [];
  for (const medicine of medicines) {
    const line = await dbx.pharmacySaleLine.create({
      data: {
        organizationId: orgA,
        branchId: branchA,
        saleId: sale.id,
        ...medicine,
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        canonicalUnits: 1,
        unitPriceMinor: 100,
        grossMinor: 100,
        proRataCeilingMinor: 100,
        unitCostMinor: 50,
        idempotencyKey: randomUUID(),
      },
    });
    lineIds.push(line.id);
  }
  return { saleId: sale.id, lineIds };
}

let duplicateSale: { saleId: string; lineIds: string[] };
let distinctSale: { saleId: string; lineIds: string[] };
let panadolId: string;
let calpolId: string;

beforeAll(async () => {
  if (!client) return;
  await client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
    for (const org of [orgA, orgB]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        org
      );
    }
  });
  await inOrg(orgA, async (dbx) => {
    await dbx.organizationDepartment.create({
      data: { organizationId: orgA, key: 'PHARMACY', name: 'Pharmacy' },
    });
    await dbx.user.create({
      data: {
        id: actorId,
        organizationId: orgA,
        name: 'Counter operator',
        email: `${actorId}@example.test`,
        department: 'PHARMACY',
        title: 'Counter operator',
        permissionOverrides: {
          create: {
            organizationId: orgA,
            capability: 'pharmacy:counter',
            effect: 'ALLOW',
            reason: 'Duplicate-salt acknowledgement fixture',
          },
        },
      },
    });
    for (const id of [branchA, branchA2]) {
      await dbx.pharmacyBranch.create({
        data: {
          id,
          organizationId: orgA,
          code: id,
          name: 'Duplicate salt test',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
    }
    await dbx.pharmacyBranchAssignment.create({
      data: { organizationId: orgA, userId: actorId, branchId: branchA },
    });
    const paracetamol = await dbx.ingredient.create({
      data: { organizationId: orgA, name: 'Paracetamol' },
    });
    const ibuprofen = await dbx.ingredient.create({
      data: { organizationId: orgA, name: 'Ibuprofen' },
    });
    const panadol = await medicineWith(dbx, 'Panadol', paracetamol.id);
    const calpol = await medicineWith(dbx, 'Calpol', paracetamol.id);
    const brufen = await medicineWith(dbx, 'Brufen', ibuprofen.id);
    panadolId = panadol.medicineId;
    calpolId = calpol.medicineId;
    duplicateSale = await saleWith(dbx, [panadol, calpol]);
    distinctSale = await saleWith(dbx, [panadol, brufen]);
  });
});
afterAll(() => client?.$disconnect());

describeIfDatabase('duplicate-salt acknowledgement (#724)', () => {
  it('persists the router acknowledgement in the request transaction before returning success', async () => {
    await inOrg(orgA, async (dbx) => {
      await acknowledgementCaller(dbx).acknowledgeDuplicateSalt({
        branchId: branchA,
        saleId: duplicateSale.saleId,
        ingredientKey: 'paracetamol',
      });
      // The row must already exist; no background-write flush is needed.
      expect(
        await dbx.auditLog.count({
          where: { targetId: duplicateSale.saleId, action: 'duplicate_salt_acknowledged' },
        })
      ).toBe(1);
    });

    const rows = await inOrg(orgA, (dbx) =>
      dbx.auditLog.findMany({
        where: { targetId: duplicateSale.saleId, action: 'duplicate_salt_acknowledged' },
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: orgA,
      actorId,
      category: 'PHARMACY_SAFETY',
      outcome: 'SUCCESS',
      metadata: {
        branchId: branchA,
        ingredientKey: 'paracetamol',
        medicineIds: [panadolId, calpolId],
        saleLineIds: duplicateSale.lineIds,
      },
    });
    expect(
      await inOrg(orgB, (dbx) =>
        dbx.auditLog.findMany({ where: { targetId: duplicateSale.saleId } })
      )
    ).toEqual([]);
  });

  it('rolls the acknowledgement back with its owning transaction', async () => {
    const where = { targetId: duplicateSale.saleId, action: 'duplicate_salt_acknowledged' };
    const before = await inOrg(orgA, (dbx) => dbx.auditLog.count({ where }));
    await expect(
      inOrg(orgA, async (dbx) => {
        await acknowledgementCaller(dbx).acknowledgeDuplicateSalt({
          branchId: branchA,
          saleId: duplicateSale.saleId,
          ingredientKey: 'paracetamol',
        });
        throw new Error('abort acknowledgement transaction');
      })
    ).rejects.toThrow('abort acknowledgement transaction');
    expect(await inOrg(orgA, (dbx) => dbx.auditLog.count({ where }))).toBe(before);
  });

  it('recognises two paracetamol brands on one persisted bill', async () => {
    const acknowledgement = await inOrg(orgA, (dbx) =>
      verifyDuplicateSaltAcknowledgement(
        dbx,
        { organizationId: orgA, branchId: branchA, actorId },
        { saleId: duplicateSale.saleId, ingredientKey: 'paracetamol' }
      )
    );
    expect(acknowledgement).toMatchObject({
      saleId: duplicateSale.saleId,
      branchId: branchA,
      ingredientName: 'Paracetamol',
      acknowledgedByUserId: actorId,
    });
    expect(acknowledgement.medicines.map((medicine) => medicine.medicineId)).toEqual([
      panadolId,
      calpolId,
    ]);
    expect(acknowledgement.medicines.map((medicine) => medicine.ref)).toEqual(
      duplicateSale.lineIds
    );
  });

  it('carries each line’s active salts on the counter cart', async () => {
    const cart = await inOrg(orgA, (dbx) =>
      readCounterCart(dbx, { organizationId: orgA, branchId: branchA }, duplicateSale.saleId)
    );
    expect(cart.lines.map((line) => line.activeIngredients?.map((salt) => salt.name))).toEqual([
      ['Paracetamol'],
      ['Paracetamol'],
    ]);
  });

  it('refuses a bill without the claimed duplicate', async () => {
    await expect(
      inOrg(orgA, (dbx) =>
        verifyDuplicateSaltAcknowledgement(
          dbx,
          { organizationId: orgA, branchId: branchA, actorId },
          { saleId: distinctSale.saleId, ingredientKey: 'paracetamol' }
        )
      )
    ).rejects.toEqual(new DuplicateSaltAcknowledgementError('NOT_DUPLICATE'));
  });

  it('refuses the same bill from another branch of the tenant', async () => {
    await expect(
      inOrg(orgA, (dbx) =>
        verifyDuplicateSaltAcknowledgement(
          dbx,
          { organizationId: orgA, branchId: branchA2, actorId },
          { saleId: duplicateSale.saleId, ingredientKey: 'paracetamol' }
        )
      )
    ).rejects.toEqual(new DuplicateSaltAcknowledgementError('NOT_FOUND'));
  });

  it('refuses the bill from another tenant, even when it names the owning org', async () => {
    await expect(
      inOrg(orgB, (dbx) =>
        verifyDuplicateSaltAcknowledgement(
          dbx,
          { organizationId: orgA, branchId: branchA, actorId },
          { saleId: duplicateSale.saleId, ingredientKey: 'paracetamol' }
        )
      )
    ).rejects.toEqual(new DuplicateSaltAcknowledgementError('NOT_FOUND'));
  });
});
