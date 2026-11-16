// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TRPCContext } from '@/server/trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suffix = randomUUID().replaceAll('-', '');
const org = `catalogue_${suffix}`;
const soloOrg = `solo_${suffix}`;
const editor = `editor_${suffix}`;
const reviewer = `reviewer_${suffix}`;
const owner = `owner_${suffix}`;
const medicineId = `medicine_${suffix}`;
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let router: (typeof import('@/server/routers/pharmacy-medicine'))['pharmacyMedicineRouter'];
let db: ScopedDb;

function caller(tx: ScopedDb, organizationId: string, actorId: string) {
  return router.createCaller({
    db: tx,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: actorId, organizationId, role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {}, db: tx },
  } as unknown as TRPCContext);
}
function inOrg<T>(
  organizationId: string,
  actorId: string,
  work: (api: ReturnType<typeof caller>, tx: ScopedDb) => Promise<T>
) {
  return tenancy.withTenantDb(
    organizationId,
    (tx) => work(caller(tx, organizationId, actorId), tx),
    { userId: actorId, skipDrain: true }
  );
}

(url ? describe : describe.skip)('DEV-766 catalogue API on migrated PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    tenancy = await import('@/lib/tenancy/scoped-db');
    router = (await import('@/server/routers/pharmacy-medicine')).pharmacyMedicineRouter;
    db = (await import('@/lib/db')).db;
    expect(
      await db.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await tenancy.withPlatformDb(async (tx) => {
      for (const [organizationId, actors] of [
        [org, [editor, reviewer]],
        [soloOrg, [owner]],
      ] as const) {
        await tx.organization.create({
          data: {
            id: organizationId,
            slug: organizationId,
            legalName: 'Synthetic catalogue test',
            displayName: 'Synthetic catalogue test',
            vertical: 'PHARMACY',
            status: 'ACTIVE',
          },
        });
        await tx.organizationDepartment.create({ data: { organizationId, key: 'QA', name: 'QA' } });
        const role = await tx.organizationRole.create({
          data: { organizationId, key: 'owner', name: 'Owner', isSystem: true },
        });
        for (const capability of ['*', 'pharmacy:catalogue-review'])
          await tx.organizationRolePermission.create({
            data: { organizationId, organizationRoleId: role.id, capability, effect: 'ALLOW' },
          });
        for (const actorId of actors) {
          await tx.user.create({
            data: {
              id: actorId,
              organizationId,
              organizationRoleId: role.id,
              name: 'Synthetic user',
              email: `${actorId}@catalogue-test.invalid`,
              password: hashSync('local-fixture-password', 4),
              role: 'ADMIN',
              title: 'QA',
              department: 'QA',
              status: 'ACTIVE',
            },
          });
          const staff = await tx.restaurantStaffProfile.create({
            data: {
              organizationId,
              userId: actorId,
              displayName: 'Synthetic user',
              status: 'ACTIVE',
            },
          });
          await tx.restaurantOperatorCredential.create({
            data: {
              organizationId,
              staffProfileId: staff.id,
              type: 'PIN',
              credentialHash: hashSync('2468', 4),
            },
          });
        }
        await tx.medicine.create({
          data: {
            id: organizationId === org ? medicineId : `solo_${medicineId}`,
            organizationId,
            productName: 'Synthetic soap',
            productFamily: 'FRONT_SHOP',
            saleable: true,
          },
        });
      }
    });
  }, 30_000);
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('keeps edits pending, separates reviewers, audits approval and rejects replay', async () => {
    const edit = await inOrg(org, editor, (api) =>
      api.submitCatalogueEdit({ medicineId, changes: { productName: 'Reviewed soap' } })
    );
    await inOrg(org, editor, async (_api, tx) =>
      expect((await tx.medicine.findUniqueOrThrow({ where: { id: medicineId } })).productName).toBe(
        'Synthetic soap'
      )
    );
    await expect(
      inOrg(org, editor, (api) =>
        api.decideCatalogueEdit({ editId: edit!.id, decision: 'APPROVE', pin: '2468' })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await inOrg(org, reviewer, (api) =>
      api.decideCatalogueEdit({ editId: edit!.id, decision: 'APPROVE' })
    );
    await expect(
      inOrg(org, reviewer, (api) =>
        api.decideCatalogueEdit({ editId: edit!.id, decision: 'APPROVE' })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await inOrg(org, reviewer, async (_api, tx) => {
      expect((await tx.medicine.findUniqueOrThrow({ where: { id: medicineId } })).productName).toBe(
        'Reviewed soap'
      );
      expect(
        await tx.auditLog.count({
          where: { action: 'pharmacy.catalogueApproval', targetId: edit!.id },
        })
      ).toBe(1);
    });
  });

  it('persists PIN strikes on rollback and requires fresh audited solo-owner authentication', async () => {
    const edit = await inOrg(soloOrg, owner, (api) =>
      api.submitCatalogueEdit({
        medicineId: `solo_${medicineId}`,
        changes: { productName: 'Solo reviewed soap' },
      })
    );
    await expect(
      inOrg(soloOrg, owner, (api) =>
        api.decideCatalogueEdit({ editId: edit!.id, decision: 'APPROVE', pin: '0000' })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await inOrg(soloOrg, owner, async (_api, tx) =>
      expect((await tx.restaurantOperatorCredential.findFirstOrThrow()).failedAttempts).toBe(1)
    );
    await inOrg(soloOrg, owner, (api) =>
      api.decideCatalogueEdit({ editId: edit!.id, decision: 'APPROVE', pin: '2468' })
    );
    await inOrg(soloOrg, owner, async (_api, tx) => {
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'pharmacy.catalogueApproval', targetId: edit!.id },
      });
      expect(audit.metadata).toMatchObject({
        policy: 'PHARMACY_SOLO_OWNER_PIN',
        pinVerified: true,
      });
      expect(audit.metadata).not.toHaveProperty('pin');
      expect(JSON.stringify(audit.metadata)).not.toContain('"2468"');
    });
    const next = await inOrg(soloOrg, owner, (api) =>
      api.submitCatalogueEdit({
        medicineId: `solo_${medicineId}`,
        changes: { brandName: 'Another edit' },
      })
    );
    await expect(
      inOrg(soloOrg, owner, (api) =>
        api.decideCatalogueEdit({ editId: next!.id, decision: 'APPROVE' })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rolls back the claimed approval when the catalogue version has changed', async () => {
    const edit = await inOrg(org, editor, (api) =>
      api.submitCatalogueEdit({ medicineId, changes: { brandName: 'Stale proposal' } })
    );
    await inOrg(org, reviewer, async (_api, tx) => {
      await tx.medicine.update({
        where: { id: medicineId },
        data: { manufacturer: 'New current manufacturer' },
      });
    });
    await expect(
      inOrg(org, reviewer, (api) =>
        api.decideCatalogueEdit({ editId: edit!.id, decision: 'APPROVE' })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await inOrg(org, reviewer, async (_api, tx) =>
      expect(
        (await tx.pharmacyCatalogueEdit.findUniqueOrThrow({ where: { id: edit!.id } })).status
      ).toBe('PENDING')
    );
  });

  it('reviews by appending provenance and publishes front-shop stock without strength', async () => {
    const provenance = Object.entries({
      productName: 'Synthetic retail publication',
      pack: '1 unit',
    }).map(([field, value]) => ({
      field,
      source: 'Synthetic fixture',
      sourceType: 'USER' as const,
      retrievedAt: new Date(),
      status: 'UNREVIEWED' as const,
      assertedValue: {
        value,
        connectorId: 'manual-file',
        sourceLabel: 'Synthetic fixture',
        batchId: suffix,
        rowSourceKey: 'row',
        rights: {
          acquisition: 'Local test',
          cache: 'Local test',
          redistribution: 'Local test',
          deletion: 'Local test',
        },
        blockingIssues: [],
      },
    }));
    const candidate = await inOrg(org, editor, (api) =>
      api.createMedicine({
        productName: 'Synthetic retail publication',
        productFamily: 'FRONT_SHOP',
        provenance,
      })
    );
    const ids = candidate!.provenance.map((item) => item.id);
    const reviewInput = {
      duplicateKey: `reference:${candidate!.id}`,
      action: 'ACCEPT' as const,
      medicineIds: [candidate!.id],
      payload: { assertionIds: ids },
    };
    await expect(
      inOrg(org, editor, (api) => api.recordReviewDecision(reviewInput))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const decision = await inOrg(org, reviewer, (api) => api.recordReviewDecision(reviewInput));
    const reviewedIds = (decision.payload as { assertionIds: string[] }).assertionIds;
    expect(reviewedIds).toHaveLength(2);
    expect(reviewedIds.some((id) => ids.includes(id))).toBe(false);
    await expect(
      inOrg(org, reviewer, (api) => api.recordReviewDecision(reviewInput))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await inOrg(org, reviewer, (api) => api.publishAssertions({ assertionIds: reviewedIds }));
    await inOrg(org, reviewer, async (_api, tx) => {
      const item = await tx.medicine.findUniqueOrThrow({
        where: { id: candidate!.id },
        include: {
          strengths: true,
          presentations: { include: { packLevels: true } },
          provenance: true,
        },
      });
      expect(item.saleable).toBe(true);
      expect(item.strengths).toHaveLength(0);
      expect(item.presentations[0]!.packLevels[0]!.unitsPerParent).toBe(1);
      expect(
        item.provenance.filter((row) => ids.includes(row.id)).map((row) => row.status)
      ).toEqual(['UNREVIEWED', 'UNREVIEWED']);
      expect(
        item.provenance
          .filter((row) => reviewedIds.includes(row.id))
          .every((row) => row.reviewer === reviewer && ids.includes(row.supersedesId!))
      ).toBe(true);
    });
  });
});
