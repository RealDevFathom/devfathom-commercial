// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { hash } from 'bcryptjs';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// This suite deliberately fails if DATABASE_URL is absent: it must execute in
// the authorized CLI run, never turn a missing database into a skipped pass.
const configuredUrl = process.env.DATABASE_URL;
const suffix = randomUUID().replaceAll('-', '');
const runtimeRole = `h1_runtime_${suffix}`;
let owner: Client;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let authorize: typeof import('./solo-approval').authorizeSoloApproval;
let can: typeof import('@/lib/abac').can;
let actions: typeof import('@/lib/abac/policies').ALL_ACTIONS;
let branches: typeof import('./controlled-register').assignedRegisterBranchIds;
let procure: typeof import('./procurement-access').actorCanProcure;
let router: typeof import('@/server/routers/pharmacy-purchasing').pharmacyPurchasingRouter;
const pin = '4729';
const orgs: string[] = [];

beforeAll(async () => {
  if (!configuredUrl)
    throw new Error('DATABASE_URL is required for solo approval integration tests');
  owner = new Client({ connectionString: configuredUrl });
  await owner.connect();
  // Use the configured database, with a temporary NOLOGIN/NOBYPASSRLS role.
  // No password or connection string is ever printed.
  await owner.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"`
  );
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${runtimeRole}"`);
  const runtime = new URL(configuredUrl);
  runtime.searchParams.set(
    'options',
    `${runtime.searchParams.get('options') ?? ''} -c role=${runtimeRole}`.trim()
  );
  process.env.DATABASE_URL = runtime.toString();
  ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
  ({ authorizeSoloApproval: authorize } = await import('./solo-approval'));
  ({ can } = await import('@/lib/abac'));
  ({ ALL_ACTIONS: actions } = await import('@/lib/abac/policies'));
  ({ assignedRegisterBranchIds: branches } = await import('./controlled-register'));
  ({ actorCanProcure: procure } = await import('./procurement-access'));
  ({ pharmacyPurchasingRouter: router } = await import('@/server/routers/pharmacy-purchasing'));
}, 60_000);

afterAll(async () => {
  if (configuredUrl) process.env.DATABASE_URL = configuredUrl;
  if (owner) {
    const { db } = await import('@/lib/db');
    await db.$disconnect();
  }
  if (owner) {
    // Immutable clinical/audit evidence is intentionally retained as isolated,
    // randomly named fixtures, following the existing purchasing DB suites.
    await owner.query(`DROP OWNED BY "${runtimeRole}"`);
    await owner.query(`DROP ROLE "${runtimeRole}"`);
    await owner.end();
  }
});

async function fixture(kind: 'ADMIN' | 'owner' = 'ADMIN') {
  const org = `h1_${randomUUID().replaceAll('-', '')}`;
  orgs.push(org);
  await owner.query(
    `INSERT INTO organizations (id,slug,"legalName","displayName",status,vertical,"updatedAt") VALUES ($1,$1,'H1 regression','H1 regression','ACTIVE','PHARMACY',now())`,
    [org]
  );
  return withTenantDb(
    org,
    async (db) => {
      await db.organizationDepartment.create({
        data: { organizationId: org, key: 'PHARMACY', name: 'PHARMACY' },
      });
      const role = await db.organizationRole.create({
        data: {
          organizationId: org,
          key: kind === 'owner' ? 'owner' : 'ordinary',
          name: kind,
          permissions: { create: { organizationId: org, capability: '*', effect: 'DENY' } },
        },
      });
      const user = await db.user.create({
        data: {
          organizationId: org,
          organizationRoleId: role.id,
          name: 'Solo proprietor',
          email: `${org}@example.invalid`,
          department: 'PHARMACY',
          title: 'Owner',
          role: kind === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
          status: 'ACTIVE',
        },
      });
      const profile = await db.restaurantStaffProfile.create({
        data: { organizationId: org, userId: user.id, displayName: 'Owner' },
      });
      await db.restaurantOperatorCredential.create({
        data: {
          organizationId: org,
          staffProfileId: profile.id,
          type: 'PIN',
          credentialHash: await hash(pin, 4),
        },
      });
      const branch = await db.pharmacyBranch.create({
        data: {
          organizationId: org,
          code: 'MAIN',
          name: 'Main',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      const other = await db.pharmacyBranch.create({
        data: {
          organizationId: org,
          code: 'SECOND',
          name: 'Second',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      const supplier = await db.pharmacySupplier.create({
        data: {
          organizationId: org,
          name: 'Licensed supplier',
          authorized: true,
          licences: {
            create: {
              licenceType: 'DISTRIBUTION',
              licenceNumber: 'H1-test',
              issuingAuthority: 'Test',
              issuedAt: new Date('2026-01-01'),
              expiresAt: new Date('2035-01-01'),
              verifiedAt: new Date(),
              evidenceUri: 'test-evidence',
            },
          },
        },
      });
      const medicine = await db.medicine.create({
        data: {
          organizationId: org,
          productName: 'H1 medicine',
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          controlled: true,
        },
      });
      const presentation = await db.presentation.create({
        data: { organizationId: org, medicineId: medicine.id, presentation: 'Tablet' },
      });
      const pack = await db.packLevel.create({
        data: {
          organizationId: org,
          presentationId: presentation.id,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId: org,
          branchId: branch.id,
          code: 'STORE',
          name: 'Store',
          kind: 'STORE',
        },
      });
      return {
        org,
        user: user.id,
        profile: profile.id,
        branch: branch.id,
        other: other.id,
        supplier: supplier.id,
        medicine: medicine.id,
        pack: pack.id,
        location: location.id,
      };
    },
    { skipDrain: true }
  );
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const scope = (f: Fixture) => ({ organizationId: f.org, branchId: f.branch, actorId: f.user });
function caller(db: ScopedDb, f: Fixture) {
  return router.createCaller({
    db,
    entitlements: { organizationId: f.org, enabledModules: ['pharmacy-procurement'], modules: [] },
    session: {
      expires: 'later',
      user: { id: f.user, organizationId: f.org, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {}, db },
  } as never);
}
async function order(f: Fixture) {
  return withTenantDb(
    f.org,
    async (db) => {
      const po = await db.pharmacyPurchaseOrder.create({
        data: {
          organizationId: f.org,
          branchId: f.branch,
          supplierId: f.supplier,
          reference: randomUUID(),
          createdByUserId: f.user,
        },
      });
      return db.pharmacyPurchaseOrder.update({
        where: { id: po.id },
        data: { status: 'SUBMITTED' },
      });
    },
    { skipDrain: true }
  );
}
function receiptInput(f: Fixture, suppliedPin = pin) {
  return {
    reference: randomUUID(),
    branchId: f.branch,
    supplierId: f.supplier,
    supplierInvoiceRef: randomUUID(),
    supplierInvoiceDate: new Date(),
    warrantyEvidenceRef: 'test',
    receivedAt: new Date(),
    directPurchase: {
      reason: 'Solo owner urgent purchase',
      approvedByUserId: f.user,
      pin: suppliedPin,
    },
    qualifiedPersonUserId: f.user,
    lines: [
      {
        medicineId: f.medicine,
        packLevelId: f.pack,
        batchNumber: randomUUID(),
        printedExpiry: new Date('2030-01-01'),
        expiryPrecision: 'DAY' as const,
        printedMrpMinor: 200,
        canonicalUnitsPerPack: 10,
        receivedPacks: 1,
        bonusPacks: 0,
        rejectedCanonicalUnits: 0,
        invoicedPricePerPackMinor: 100,
        discountBps: 0,
        taxBps: 0,
        taxCreditable: false,
        stockLocationId: f.location,
      },
    ],
  };
}

describe('solo approval on real PostgreSQL with enforced RLS', () => {
  it.each(['ADMIN', 'owner'] as const)(
    'preserves every capability and all active branches for persisted %s despite DENY',
    async (kind) => {
      const f = await fixture(kind);
      await withTenantDb(
        f.org,
        async (db) => {
          const role = await db.$queryRaw<
            Array<{ rolsuper: boolean; rolbypassrls: boolean }>
          >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
          expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
          for (const action of actions)
            expect(
              await can({ id: f.user, role: 'EMPLOYEE' }, action, undefined, { db }),
              action
            ).toBe(true);
          expect(await procure(db, f.user)).toBe(true);
          expect((await branches(db, f.org, f.user)).sort()).toEqual([f.branch, f.other].sort());
          expect(await procure(db, 'foreign-user')).toBe(false);
          expect(await branches(db, f.org, 'foreign-user')).toEqual([]);
        },
        { skipDrain: true }
      );
      const foreign = await fixture();
      await withTenantDb(
        foreign.org,
        async (db) => {
          expect(await procure(db, f.user)).toBe(false);
          expect(
            await can({ id: f.user, role: 'ADMIN' }, 'pharmacy:dispense', undefined, { db })
          ).toBe(false);
          expect(await branches(db, foreign.org, f.user)).toEqual([]);
        },
        { skipDrain: true }
      );
      await withTenantDb(
        f.org,
        (db) => db.user.update({ where: { id: f.user }, data: { status: 'INACTIVE' } }),
        { skipDrain: true }
      );
      await withTenantDb(
        f.org,
        async (db) => {
          expect(await procure(db, f.user)).toBe(false);
          expect(
            await can({ id: f.user, role: 'ADMIN' }, 'pharmacy:dispense', undefined, { db })
          ).toBe(false);
          expect(await branches(db, f.org, f.user)).toEqual([]);
        },
        { skipDrain: true }
      );
    }
  );

  it('approves its own purchase through the actual router with an atomic PIN audit', async () => {
    const f = await fixture();
    const po = await order(f);
    await withTenantDb(
      f.org,
      (db) =>
        caller(db, f).approvePurchaseOrder({ purchaseOrderId: po.id, decision: 'APPROVED', pin }),
      { skipDrain: true }
    );
    await withTenantDb(
      f.org,
      async (db) => {
        expect(
          (await db.pharmacyPurchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status
        ).toBe('APPROVED');
        expect(
          await db.auditLog.count({ where: { action: 'PHARMACY:SOLO_OWNER_PIN', targetId: po.id } })
        ).toBe(1);
        expect(
          await db.pharmacyPurchaseOrderApproval.count({
            where: { purchaseOrderId: po.id, policy: 'PHARMACY:SOLO_OWNER_PIN' },
          })
        ).toBe(1);
      },
      { skipDrain: true }
    );
  });

  it('creates and posts a controlled direct purchase using the sole owner PIN', async () => {
    const f = await fixture('owner');
    const receipt = await withTenantDb(
      f.org,
      (db) => caller(db, f).createGoodsReceipt(receiptInput(f)),
      { skipDrain: true }
    );
    const { postGoodsReceipt } = await import('./goods-receipt');
    await withTenantDb(
      f.org,
      (db) =>
        postGoodsReceipt(db, scope(f), {
          goodsReceiptId: receipt.id,
          at: new Date(),
          staffProfileId: f.profile,
          pin,
        }),
      { skipDrain: true }
    );
    await withTenantDb(
      f.org,
      async (db) => {
        expect(
          (await db.pharmacyGoodsReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status
        ).toBe('POSTED');
        const entry = await db.pharmacyControlledRegisterEntry.findFirstOrThrow({
          where: { organizationId: f.org },
        });
        expect(entry.recordedByUserId).toBe(f.user);
        expect(entry.witnessedByUserId).toBe(f.user);
        expect(entry.signatureRef).toBe(`solo-purchase:${receipt.id}`);
        expect(
          await db.auditLog.count({
            where: { action: 'PHARMACY:SOLO_OWNER_PIN', targetId: receipt.id },
          })
        ).toBe(2);
      },
      { skipDrain: true }
    );
  });

  it('keeps failed PIN counters across request rollback, and rolls back success audit with the document', async () => {
    const f = await fixture();
    const po = await order(f);
    await expect(
      withTenantDb(
        f.org,
        async (db) => {
          expect(
            await authorize(db, scope(f), { type: 'PharmacyPurchaseOrder', id: po.id }, '9999')
          ).toBe(false);
          throw new Error('intentional rollback');
        },
        { skipDrain: true }
      )
    ).rejects.toThrow('intentional rollback');
    await withTenantDb(
      f.org,
      async (db) => {
        expect(
          (
            await db.restaurantOperatorCredential.findFirstOrThrow({
              where: { staffProfileId: f.profile },
            })
          ).failedAttempts
        ).toBe(1);
      },
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        f.org,
        async (db) => {
          expect(
            await authorize(db, scope(f), { type: 'PharmacyPurchaseOrder', id: po.id }, pin)
          ).toBe(true);
          await db.pharmacyPurchaseOrder.update({
            where: { id: po.id },
            data: { status: 'APPROVED', approvedByUserId: f.user, approvedAt: new Date() },
          });
          throw new Error('intentional rollback');
        },
        { skipDrain: true }
      )
    ).rejects.toThrow('intentional rollback');
    await withTenantDb(
      f.org,
      async (db) => {
        expect(
          (await db.pharmacyPurchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status
        ).toBe('SUBMITTED');
        expect(
          await db.auditLog.count({ where: { action: 'PHARMACY:SOLO_OWNER_PIN', targetId: po.id } })
        ).toBe(0);
      },
      { skipDrain: true }
    );
  });

  it('refuses unaudited self-approval, replayed audits and self-approval after a second staff member joins', async () => {
    const f = await fixture();
    const po = await order(f);
    const update = (db: ScopedDb) =>
      db.pharmacyPurchaseOrder.update({
        where: { id: po.id },
        data: { status: 'APPROVED', approvedByUserId: f.user, approvedAt: new Date() },
      });
    await expect(withTenantDb(f.org, update, { skipDrain: true })).rejects.toThrow();
    const audit = await withTenantDb(
      f.org,
      async (db) => {
        expect(
          await authorize(db, scope(f), { type: 'PharmacyPurchaseOrder', id: po.id }, pin)
        ).toBe(true);
        return db.auditLog.findFirstOrThrow({
          where: { targetId: po.id, action: 'PHARMACY:SOLO_OWNER_PIN' },
        });
      },
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        f.org,
        async (db) => {
          await db.$queryRaw`SELECT set_config('app.pharmacy_solo_audit_id', ${audit.id}, true)`;
          return update(db);
        },
        { skipDrain: true }
      )
    ).rejects.toThrow();
    await withTenantDb(
      f.org,
      (db) =>
        db.user.create({
          data: {
            organizationId: f.org,
            name: 'Second staff',
            email: `${f.org}-second@example.invalid`,
            department: 'PHARMACY',
            title: 'Staff',
            status: 'ACTIVE',
          },
        }),
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        f.org,
        (db) =>
          caller(db, f).approvePurchaseOrder({ purchaseOrderId: po.id, decision: 'APPROVED', pin }),
        { skipDrain: true }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      withTenantDb(f.org, (db) => caller(db, f).createGoodsReceipt(receiptInput(f)), {
        skipDrain: true,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('counts every active owner across branches while allowing an ordinary sibling-branch staff member', async () => {
    const f = await fixture('owner');
    const sibling = await withTenantDb(
      f.org,
      async (db) => {
        const user = await db.user.create({
          data: {
            organizationId: f.org,
            name: 'Sibling staff',
            email: `${f.org}-sibling@example.invalid`,
            department: 'PHARMACY',
            title: 'Staff',
            status: 'ACTIVE',
          },
        });
        await db.pharmacyBranchAssignment.create({
          data: { organizationId: f.org, branchId: f.other, userId: user.id },
        });
        return user;
      },
      { skipDrain: true }
    );
    const { soloOwnerEligible } = await import('./solo-approval');
    const { listControlledPinWitnesses } = await import('./controlled-register');
    await withTenantDb(
      f.org,
      async (db) => {
        expect(await soloOwnerEligible(db, scope(f))).toBe(true);
        expect(await soloOwnerEligible(db, { ...scope(f), branchId: null })).toBe(false);
        expect(await listControlledPinWitnesses(db, f.org, f.user, f.branch)).toEqual([
          { id: f.profile, name: 'Owner' },
        ]);
        expect(await listControlledPinWitnesses(db, f.org, f.user)).toEqual([]);
        const ownerRole = await db.organizationRole.findFirstOrThrow({ where: { key: 'owner' } });
        await db.user.update({
          where: { id: sibling.id },
          data: { organizationRoleId: ownerRole.id },
        });
        expect(await soloOwnerEligible(db, scope(f))).toBe(false);
        expect(await listControlledPinWitnesses(db, f.org, f.user, f.branch)).toEqual([]);
      },
      { skipDrain: true }
    );
  });

  it('self-approves stock variance and controlled restoration with fresh PIN audits; multi-staff remains blocked', async () => {
    const f = await fixture();
    const receipt = await withTenantDb(
      f.org,
      (db) => caller(db, f).createGoodsReceipt(receiptInput(f)),
      { skipDrain: true }
    );
    const { postGoodsReceipt } = await import('./goods-receipt');
    const { createCount, approveCount } = await import('./inventory-operations');
    const { authorizeControlledRestoration } =
      await import('./controlled-restoration-authorization');
    const count = await withTenantDb(
      f.org,
      async (db) => {
        await postGoodsReceipt(db, scope(f), {
          goodsReceiptId: receipt.id,
          at: new Date(),
          staffProfileId: f.profile,
          pin,
        });
        const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
          where: { branchId: f.branch },
        });
        return createCount(db, scope(f), {
          varianceThreshold: 0,
          readings: [
            {
              inventoryLotId: lot.id,
              stockLocationId: f.location,
              countedSealedPacks: 0,
              countedLooseUnits: 0,
            },
          ],
        });
      },
      { skipDrain: true }
    );
    expect(count.status).toBe('AWAITING_COAUTH');
    await expect(
      withTenantDb(
        f.org,
        (db) =>
          db.pharmacyInventoryCount.update({
            where: { id: count.id },
            data: { status: 'APPROVED', approvedById: f.user, approvedAt: new Date() },
          }),
        { skipDrain: true }
      )
    ).rejects.toThrow(/inventory self approval requires solo owner PIN audit/);

    await expect(
      withTenantDb(f.org, (db) => approveCount(db, scope(f), count.id, 'no-pin'), {
        skipDrain: true,
      })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    await withTenantDb(
      f.org,
      async (db) => {
        const witness = await authorizeControlledRestoration(db, scope(f), {
          staffProfileId: f.profile,
          pin,
        });
        expect(witness.witnessedByUserId).toBe(f.user);
        expect(witness.signatureRef).toMatch(/^solo-restoration:/);
        const audit = await db.auditLog.findFirstOrThrow({
          where: { targetType: 'ControlledRestoration' },
        });
        expect(audit.actorId).toBe(f.user);
      },
      { skipDrain: true }
    );
    await withTenantDb(f.org, (db) => approveCount(db, scope(f), count.id, 'solo-count', pin), {
      skipDrain: true,
    });
    await withTenantDb(
      f.org,
      async (db) => {
        expect(
          (await db.pharmacyInventoryCount.findUniqueOrThrow({ where: { id: count.id } })).status
        ).toBe('APPROVED');
        expect(
          await db.auditLog.count({
            where: { targetId: count.id, action: 'PHARMACY:SOLO_OWNER_PIN' },
          })
        ).toBe(1);
        await db.user.create({
          data: {
            organizationId: f.org,
            name: 'Second staff',
            email: `${f.org}-second@example.invalid`,
            department: 'PHARMACY',
            title: 'Staff',
            status: 'ACTIVE',
          },
        });
      },
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        f.org,
        (db) => authorizeControlledRestoration(db, scope(f), { staffProfileId: f.profile, pin }),
        { skipDrain: true }
      )
    ).rejects.toThrow(/fresh witness PIN/);
  });

  it('retains actual second-approver purchase approval with multiple active staff', async () => {
    const f = await fixture();
    const po = await order(f);
    const second = await withTenantDb(
      f.org,
      (db) =>
        db.user.create({
          data: {
            organizationId: f.org,
            name: 'Second admin',
            email: `${f.org}-admin@example.invalid`,
            department: 'PHARMACY',
            title: 'Admin',
            status: 'ACTIVE',
            role: 'ADMIN',
          },
        }),
      { skipDrain: true }
    );
    await withTenantDb(
      f.org,
      (db) =>
        caller(db, { ...f, user: second.id }).approvePurchaseOrder({
          purchaseOrderId: po.id,
          decision: 'APPROVED',
        }),
      { skipDrain: true }
    );
    await withTenantDb(
      f.org,
      async (db) => {
        const approved = await db.pharmacyPurchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
        expect(approved.approvedByUserId).toBe(second.id);
        expect(
          await db.pharmacyPurchaseOrderApproval.count({
            where: { purchaseOrderId: po.id, policy: 'PUR-02:SEGREGATION_OF_DUTIES' },
          })
        ).toBe(1);
      },
      { skipDrain: true }
    );
  });
});

it('records a solo owner-PIN controlled prescription sale with matching register and audit references', async () => {
  const f = await fixture('owner');
  const receipt = await withTenantDb(
    f.org,
    (db) => caller(db, f).createGoodsReceipt(receiptInput(f)),
    { skipDrain: true }
  );
  const { postGoodsReceipt } = await import('./goods-receipt');
  const { pharmacySalesRouter } = await import('@/server/routers/pharmacy-sales');
  await withTenantDb(
    f.org,
    async (db) => {
      await postGoodsReceipt(db, scope(f), {
        goodsReceiptId: receipt.id,
        at: new Date(),
        staffProfileId: f.profile,
        pin,
      });
      const pack = await db.packLevel.findUniqueOrThrow({ where: { id: f.pack } });
      const patient = await db.pharmacyPatient.create({
        data: { displayName: 'Regression patient', cnic: '1234567890123' },
      });
      const prescriber = await db.pharmacyPrescriber.create({
        data: { name: 'Test prescriber', registrationNumber: randomUUID() },
      });
      await db.patientConsent.create({
        data: {
          patientId: patient.id,
          purpose: 'DISPENSING',
          channel: 'IN_PERSON',
          version: 1,
          granted: true,
          recordedByUserId: f.user,
        },
      });
      const rx = await db.prescription.create({
        data: {
          patientId: patient.id,
          prescriberId: prescriber.id,
          sourceKind: 'PAPER_IMAGE',
          sourceFileRef: 'test-paper',
          validFrom: new Date('2026-01-01'),
          validUntil: new Date('2035-01-01'),
          capturedByUserId: f.user,
          lines: {
            create: {
              lineNumber: 1,
              medicineId: f.medicine,
              presentationId: pack.presentationId,
              authorizedCanonicalUnits: 10,
              directions: 'As prescribed',
            },
          },
        },
        include: { lines: true },
      });
      const api = pharmacySalesRouter.createCaller({
        db,
        entitlements: { organizationId: f.org, enabledModules: ['pharmacy-counter'], modules: [] },
        session: {
          expires: 'later',
          user: { id: f.user, organizationId: f.org, role: 'EMPLOYEE', status: 'ACTIVE' },
        },
        organization: { id: f.org, vertical: 'PHARMACY' },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {}, db },
      } as never);
      const sale = await api.create({ branchId: f.branch });
      const input = {
        branchId: f.branch,
        saleId: sale.id,
        medicineId: f.medicine,
        presentationId: pack.presentationId,
        packLevelId: f.pack,
        saleUnit: 'STRIP' as const,
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
        idempotencyKey: randomUUID(),
        controlledAuthorization: {
          prescriptionLineId: rx.lines[0].id,
          patientId: patient.id,
          patientAddress: 'Test address',
          staffProfileId: f.profile,
          pin,
          rxSerialWritten: true,
          emergency: false,
        },
      };
      expect(
        await api.addLine({
          ...input,
          controlledAuthorization: { ...input.controlledAuthorization, pin: '0000' },
        })
      ).toHaveProperty('blocked');
      expect(
        await db.prescriptionFill.count({ where: { prescriptionLineId: rx.lines[0].id } })
      ).toBe(0);
      const result = await api.addLine(input);
      expect(result).toHaveProperty('line');
      const entry = await db.pharmacyControlledRegisterEntry.findFirstOrThrow({
        where: { prescriptionLineId: rx.lines[0].id, entryKind: 'SALE' },
      });
      expect(entry.signatureRef).toBe(`solo-sale:${sale.id}`);
      expect(entry.recordedByUserId).toBe(f.user);
      expect(entry.witnessedByUserId).toBe(f.user);
      expect(
        await db.prescriptionFill.count({ where: { prescriptionLineId: rx.lines[0].id } })
      ).toBe(1);
      expect(
        await db.pharmacyPharmacistReviewDecision.count({
          where: { actorUserId: f.user, kind: 'SIGN' },
        })
      ).toBe(1);
      expect(
        await db.auditLog.findFirstOrThrow({
          where: {
            targetId: sale.id,
            targetType: 'ControlledSale',
            action: 'PHARMACY:SOLO_OWNER_PIN',
          },
        })
      ).toMatchObject({
        actorId: f.user,
        metadata: {
          branchId: f.branch,
          reauthentication: 'PIN',
          policy: 'PHARMACY:SOLO_OWNER_PIN',
        },
      });
    },
    { skipDrain: true, timeout: 60_000 }
  );
});

it('offers direct-purchase approvers by persisted procurement permission and branch access, including owners', async () => {
  const f = await fixture('owner');
  const { purchasingWorkspace } = await import('./purchasing-console');
  await withTenantDb(
    f.org,
    async (db) => {
      const staff = async (
        key: string,
        capability: string,
        status: 'ACTIVE' | 'ON_LEAVE' = 'ACTIVE'
      ) => {
        const role = await db.organizationRole.create({
          data: { key, name: key, permissions: { create: { capability, effect: 'ALLOW' } } },
        });
        const user = await db.user.create({
          data: {
            name: key,
            email: `${randomUUID()}@example.invalid`,
            department: 'PHARMACY',
            title: 'Staff',
            status,
            organizationRoleId: role.id,
          },
        });
        await db.pharmacyBranchAssignment.create({ data: { userId: user.id, branchId: f.other } });
        return user;
      };
      const buyer = await staff('buyer', 'pharmacy:procurement');
      const dispenser = await staff('dispenser', 'pharmacy:dispense');
      const onLeave = await staff('on-leave', 'pharmacy:procurement', 'ON_LEAVE');
      const workspace = await purchasingWorkspace(db, {
        organizationId: f.org,
        actorId: dispenser.id,
      });
      expect(workspace.directPurchaseApprovers.find((u) => u.id === buyer.id)).toMatchObject({
        branchIds: [f.other],
      });
      expect(
        workspace.directPurchaseApprovers.find((u) => u.id === f.user)?.branchIds.sort()
      ).toEqual([f.branch, f.other].sort());
      expect(
        workspace.directPurchaseApprovers.some((u) => u.id === dispenser.id || u.id === onLeave.id)
      ).toBe(false);
      expect(workspace.approvers.some((u) => u.id === buyer.id)).toBe(false);
      expect(
        workspace.directPurchaseApprovers
          .filter((u) => u.branchIds.includes(f.branch))
          .map((u) => u.id)
      ).toEqual([f.user]);
    },
    { skipDrain: true }
  );
});
