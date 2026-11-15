// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  confirmPriceChanges,
  DRAP_PRICE_INFORMATION_ONLY,
  currentPackPrice,
  priceOverrides,
  setManualPackPrice,
} from '@/lib/pharmacy/pricing';
const enabled = process.env.WHA1606_DATABASE_TEST === '1';
const org = 'org_devfathom';
let actorId: string;
let packId: string;
let branchId: string;
let proposalId: string;
let pendingId: string;
let medicineId: string;
const scope = () => ({ organizationId: org, actorId });
const at = new Date('2026-01-01');
const run = Date.now().toString();
describe.skipIf(!enabled)('WHA-1606 disposable database transaction/RLS evidence', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (
      url.hostname !== '127.0.0.1' ||
      +url.port < 55600 ||
      +url.port > 55699 ||
      url.username !== 'wha1606_runtime'
    )
      throw new Error('Disposable runtime database required');
    await withTenantDb(org, async (tx) => {
      actorId = (await tx.user.findFirstOrThrow({ where: { email: 'alex@company.com' } })).id;
      const med = await tx.medicine.create({
        data: {
          productName: 'WHA1606 test tablet',
          drapRegistrationNumber: `WHA1606-REG-${run}`,
          productFamily: 'PHARMACEUTICAL',
        },
      });
      medicineId = med.id;
      const presentation = await tx.presentation.create({
        data: { medicineId, presentation: 'Tablet 500 mg' },
      });
      const box = await tx.packLevel.create({
        data: {
          presentationId: presentation.id,
          level: 'BOX',
          versionGroupId: `WHA1606-box-${run}`,
          version: 1,
          unitsPerParent: 1,
          effectiveFrom: at,
        },
      });
      packId = box.id;
      await tx.packLevel.create({
        data: {
          presentationId: presentation.id,
          parentPackLevelId: box.id,
          level: 'UNIT',
          versionGroupId: `WHA1606-unit-${run}`,
          version: 1,
          unitsPerParent: 30,
          effectiveFrom: at,
        },
      });
      branchId = (
        await tx.pharmacyBranch.create({
          data: {
            code: `WHA1606-${run}`,
            name: 'Test branch',
            addressLine: 'Test',
            city: 'Karachi',
            provinceCode: 'SINDH',
          },
        })
      ).id;
      await setManualPackPrice(tx, scope(), {
        packLevelId: packId,
        mrpMinor: 20000,
        sellingPriceMinor: 19500,
        effectiveFrom: at,
      });
      await setManualPackPrice(tx, scope(), {
        packLevelId: packId,
        branchId,
        mrpMinor: 19000,
        sellingPriceMinor: 18000,
        effectiveFrom: at,
      });
      // DEV-693: new DRAP notices raise alerts only. These are proposals that
      // earlier notices drafted; they stay confirmable and are seeded directly.
      for (const [reference, date] of [
        ['WHA1606-future', '2027-01-01'],
        ['WHA1606-pending', '2027-02-01'],
      ]) {
        await tx.pharmacyDrapIngest.create({
          data: {
            sourceReference: `${reference}-${run}`,
            adapter: 'FILE',
            kind: 'PRICE',
            priceNotice: {
              kind: 'PRICE',
              sourceReference: `${reference}-${run}`,
              drapRegistrationNumber: `WHA1606-REG-${run}`,
              presentation: 'Tablet 500 mg',
              packLevel: 'BOX',
              notifiedPriceMinor: 30000,
              effectiveDate: new Date(date!).toISOString(),
            },
            payloadHash: `WHA1606-${reference}-${run}`,
            matchStatus: 'MATCHED',
            matchDetails: { medicineId, packLevelId: packId },
            ingestedById: actorId,
            priceChanges: {
              create: {
                medicineId,
                currentPriceMinor: 20000,
                previousRegulatoryMrpMinor: 20000,
                packLevelId: packId,
                notifiedPriceMinor: 30000,
                effectiveDate: new Date(date!),
              },
            },
          },
        });
      }
      const proposals = await tx.pharmacyPriceChangeProposal.findMany({
        where: { medicineId },
        orderBy: { effectiveDate: 'asc' },
      });
      proposalId = proposals[0]!.id;
      pendingId = proposals[1]!.id;
    });
  }, 30000);
  afterAll(async () => {
    await db.$disconnect();
  });
  it('uses runtime NOSUPERUSER NOBYPASSRLS', async () => {
    const roles = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      Prisma.sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`
    );
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  it('DEV-693: confirming DRAP proposals is refused, even concurrently, and writes nothing', async () => {
    const outcomes = await Promise.allSettled([
      withTenantDb(org, (tx) => confirmPriceChanges(tx, scope(), [proposalId])),
      withTenantDb(org, (tx) => confirmPriceChanges(tx, scope(), [proposalId, pendingId])),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        message: DRAP_PRICE_INFORMATION_ONLY,
      });
    }
    await withTenantDb(org, async (tx) => {
      for (const id of [proposalId, pendingId]) {
        expect(await tx.pharmacyPackPrice.count({ where: { proposalId: id } })).toBe(0);
        expect(
          (await tx.pharmacyPriceChangeProposal.findFirstOrThrow({ where: { id } })).status
        ).toBe('PROPOSED');
      }
      expect(await tx.auditLog.count({ where: { action: 'pharmacyMedicine.confirmPrices' } })).toBe(
        0
      );
      // The notified 30000 never becomes a price; the manual 20000 stays.
      expect((await currentPackPrice(tx, org, packId, new Date('2027-06-01')))?.mrpMinor).toBe(
        20000
      );
      const overrides = await priceOverrides(tx, scope(), branchId);
      expect(overrides[0]).toMatchObject({ mrpMinor: 19000, sellingPriceMinor: 18000 });
    });
  });
  it('a manual owner price change still works', async () => {
    await withTenantDb(org, (tx) =>
      setManualPackPrice(tx, scope(), {
        packLevelId: packId,
        mrpMinor: 21000,
        sellingPriceMinor: 20500,
        effectiveFrom: new Date('2028-01-01'),
      })
    );
    await withTenantDb(org, async (tx) => {
      expect((await currentPackPrice(tx, org, packId, new Date('2028-01-02')))?.mrpMinor).toBe(
        21000
      );
    });
  });
  it('RLS rejects cross-tenant writes and identity guard rejects a mismatched presentation', async () => {
    const price = await withTenantDb(org, (tx) =>
      tx.pharmacyPackPrice.findFirstOrThrow({ where: { packLevelId: packId, branchId: null } })
    );
    for (const patch of [
      { organizationId: 'org_other' },
      { presentationId: 'missing-presentation' },
    ]) {
      await expect(
        withTenantDb(org, (tx) =>
          tx.pharmacyPackPrice.create({
            data: {
              organizationId: org,
              presentationId: price.presentationId,
              packLevelId: packId,
              source: 'manual',
              mrpMinor: 100,
              effectiveFrom: new Date('2029-01-01'),
              createdById: actorId,
              ...patch,
            },
          })
        )
      ).rejects.toThrow();
    }
  });
  it('RLS hides another tenant, and branch scope hides sibling overrides', async () => {
    await withTenantDb('org_other', async (tx) => {
      expect(await tx.pharmacyPackPrice.count()).toBe(0);
      await expect(
        confirmPriceChanges(tx, { organizationId: 'org_other', actorId }, [proposalId])
      ).rejects.toThrow();
    });
    await withTenantDb(org, async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', 'sibling', true)`);
      expect(await tx.pharmacyPackPrice.count({ where: { isOverride: true } })).toBe(0);
      expect(await tx.pharmacyPackPrice.count({ where: { isOverride: false } })).toBeGreaterThan(0);
    });
  });
});
