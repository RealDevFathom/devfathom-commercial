// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configureLoyaltyProgram, loyaltyBalance, loyaltyReconciliation } from './loyalty-program';
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;

suite('DEV-746 wallet migration and tenant isolation', () => {
  it('preserves immutable rows, reconciles once, and projects later branch postings', async () => {
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const organizationId = `loyalty_${randomUUID()}`;
    const rollback = new Error('rollback fixture');
    await expect(
      withTenantDb(organizationId, async (db) => {
        await db.organization.create({
          data: {
            id: organizationId,
            slug: organizationId,
            legalName: 'Loyalty fixture',
            displayName: 'Loyalty fixture',
            vertical: 'PHARMACY',
            status: 'ACTIVE',
          },
        });
        const patient = await db.pharmacyPatient.create({
          data: { organizationId, displayName: 'Fixture' },
        });
        const customer = await db.pharmacyCustomer.create({
          data: { organizationId, patientId: patient.id, displayName: 'Fixture' },
        });
        const branches = [];
        for (const code of ['A', 'B']) {
          const branch = await db.pharmacyBranch.create({
            data: {
              organizationId,
              code,
              name: code,
              addressLine: 'Fixture',
              city: 'Lahore',
              provinceCode: 'PB',
            },
          });
          const sale = await db.pharmacySale.create({
            data: {
              organizationId,
              branchId: branch.id,
              customerId: customer.id,
              createdByUserId: 'owner',
            },
          });
          branches.push({ branch, sale });
          await db.pharmacyLoyaltyPointsEntry.create({
            data: {
              organizationId,
              branchId: branch.id,
              customerId: customer.id,
              saleId: sale.id,
              kind: 'EARN',
              points: 12,
              netPaidMinor: 1200,
              actorId: 'owner',
              idempotencyKey: `legacy:${code}`,
            },
          });
        }
        const before = await db.pharmacyLoyaltyPointsEntry.findMany({
          where: { organizationId },
          orderBy: { id: 'asc' },
        });
        expect(await loyaltyBalance(db, organizationId, branches[0]!.branch.id, customer.id)).toBe(
          12
        );
        const snapshot = await loyaltyReconciliation(db, organizationId);
        const input = {
          mode: 'PERCENT',
          rewardPoints: 1,
          spendMinor: 10_000,
          khataEnabled: true,
          reconciliationDigest: snapshot.digest,
        };
        await configureLoyaltyProgram(db, organizationId, 'owner', input);
        await configureLoyaltyProgram(db, organizationId, 'owner', input);
        expect(
          await db.pharmacyLoyaltyPointsEntry.findMany({
            where: { organizationId },
            orderBy: { id: 'asc' },
          })
        ).toEqual(before);
        expect(await db.pharmacyLoyaltyMigration.count({ where: { organizationId } })).toBe(1);
        expect(await loyaltyBalance(db, organizationId, branches[1]!.branch.id, customer.id)).toBe(
          24
        );
        const { branch, sale } = branches[0]!;
        await db.$queryRaw`SELECT set_config('app.current_branch_id', ${branch.id}, true)`;
        await db.pharmacyLoyaltyPointsEntry.create({
          data: {
            organizationId,
            branchId: branch.id,
            customerId: customer.id,
            saleId: sale.id,
            kind: 'EARN_REVERSAL',
            points: -5,
            actorId: 'owner',
            idempotencyKey: 'historical-reversal',
          },
        });
        expect(await loyaltyBalance(db, organizationId, branches[1]!.branch.id, customer.id)).toBe(
          19
        );
        await db.$queryRaw`SELECT set_config('app.current_organization_id', 'foreign-org', true)`;
        expect(await db.pharmacyLoyaltyWallet.findMany({ where: { organizationId } })).toEqual([]);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });
});
