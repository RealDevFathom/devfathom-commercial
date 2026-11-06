/** Requires a disposable, seeded pharmacy E2E database and restricted runtime role. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PHARMACY_E2E as fixture } from '../../../tests/e2e/pharmacy-counter-fixture';
vi.mock('server-only', () => ({}));
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const enabled = Boolean(url && process.env.PHARMACY_E2E === '1');
const suffix = randomUUID().slice(0, 8);
const branch = `evidence_branch_${suffix}`;
const org = `evidence_org_${suffix}`;
const scan = `evidence_scan_${suffix}`;
const missingReceipt = `evidence_missing_${suffix}`;
const receiving = `evidence_receiving_${suffix}`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let verify: typeof import('./pack-line-evidence').revalidatePackLineEvidence;
const tenant = fixture.organizationId;
const act = <T>(
  f: (db: import('@/lib/tenancy/scoped-db').ScopedDb) => Promise<T>,
  organizationId: string = tenant
) => withTenantDb(organizationId, f, { userId: fixture.adminId });
const input = {
  organizationId: tenant,
  branchId: fixture.branchId,
  scanId: scan,
  medicineId: fixture.medicines.otc.id,
  presentationId: fixture.medicines.otc.presentationId,
  packLevelId: fixture.medicines.otc.packLevelIds.box,
};
describe.skipIf(!enabled)('pack line evidence restricted database', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      !parsed.pathname.includes('e2e') ||
      parsed.port === '5432'
    )
      throw new Error('Disposable pharmacy E2E database required');
    const scoped = await import('@/lib/tenancy/scoped-db');
    ({ withTenantDb } = scoped);
    ({ revalidatePackLineEvidence: verify } = await import('./pack-line-evidence'));
    await scoped.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: org,
          slug: org,
          legalName: 'Synthetic other',
          displayName: 'Synthetic other',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          deploymentMode: 'SHARED',
        },
      })
    );
    await act(async (db) => {
      const [role] = await db.$queryRaw<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await db.pharmacyBranch.create({
        data: {
          id: branch,
          organizationId: tenant,
          code: branch,
          name: 'Other synthetic branch',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      const barcode = await db.medicineBarcode.findFirst({
        where: { organizationId: tenant, normalizedCode: '08901234567890' },
      });
      if (barcode) {
        expect(barcode).toMatchObject({
          presentationId: input.presentationId,
          packLevelId: input.packLevelId,
        });
      } else
        await db.medicineBarcode.create({
          data: {
            organizationId: tenant,
            presentationId: input.presentationId,
            packLevelId: input.packLevelId,
            type: 'GTIN',
            code: '08901234567890',
            normalizedCode: '08901234567890',
          },
        });
      for (const [id, branchId, source] of [
        [scan, fixture.branchId, 'DISPENSING'],
        [missingReceipt, branch, 'DISPENSING'],
        [receiving, fixture.branchId, 'RECEIVING'],
      ] as const) {
        await db.pharmacyPackAuthenticationScan.create({
          data: {
            id,
            organizationId: tenant,
            branchId,
            source,
            status: 'VERIFIED',
            gtin: '08901234567890',
            batchNumber: fixture.medicines.otc.batchNumber,
            expiresOn: '271231',
            issues: [],
            explanation: 'Synthetic stale verdict',
            advisory: true,
            scannedByUserId: fixture.adminId,
          },
        });
      }
    });
  }, 60000);
  it('recomputes historical verdicts from branch receipt and current authoritative expiry', async () => {
    expect(await act((db) => verify(db, input))).toEqual({
      status: 'MISMATCH',
      evidence: {
        manufacturingBatchId: fixture.medicines.otc.batchId,
        packLevelId: input.packLevelId,
      },
    });
    expect(
      await act((db) => verify(db, { ...input, branchId: branch, scanId: missingReceipt }))
    ).toEqual({ status: 'UNVERIFIED' });
  });
  it('refuses scans from another branch, tenant or receiving workflow', async () => {
    await expect(act((db) => verify(db, { ...input, branchId: branch }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(act((db) => verify(db, { ...input, scanId: receiving }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      act((db) => verify(db, { ...input, organizationId: org }), org)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
