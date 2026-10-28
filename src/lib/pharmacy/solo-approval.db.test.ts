// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { hash } from 'bcryptjs';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// This suite deliberately fails if DATABASE_URL is absent: it must execute in
// the authorized CLI run, never turn a missing database into a skipped pass.
const originalUrl = process.env.DATABASE_URL;
const configuredUrl = process.env.M8_TEST_OWNER_DATABASE_URL ?? originalUrl;
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
  if (originalUrl) process.env.DATABASE_URL = originalUrl;
  else delete process.env.DATABASE_URL;
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

async function fixture(kind: 'ADMIN' | 'owner' | 'provisioned' = 'ADMIN') {
  let org = `h1_${randomUUID().replaceAll('-', '')}`;
  orgs.push(org);
  if (kind === 'provisioned') {
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    const { executePlatformCommand } = await import('@/lib/platform/commands');
    const packageRecord = await withPlatformDb((db) =>
      db.platformPackage.create({
        data: { key: org, name: 'Regression pharmacy', vertical: 'PHARMACY', defaultSeats: 10 },
      })
    );
    const result = await executePlatformCommand(
      {
        id: 'integration-platform',
        sessionId: 'integration-session',
        name: 'Regression operator',
        email: 'operator@example.invalid',
        role: 'SUPER_ADMIN',
        mfaEnabled: true,
        expiresAt: new Date(Date.now() + 3600_000),
      },
      'organization.create',
      {
        vertical: 'PHARMACY',
        slug: org.replaceAll('_', '-'),
        legalName: org,
        displayName: org,
        packageId: packageRecord.id,
        primaryContactName: 'Owner',
        primaryContactEmail: `${org}@example.invalid`,
        adminName: 'Bootstrap owner',
        adminEmail: `${org}@example.invalid`,
        adminPassword: 'Disposable-owner-password-683!',
        firstBranchName: 'Main',
        firstBranchAddress: 'Test road',
        firstBranchCity: 'Lahore',
        firstBranchProvinceCode: 'PK-PB',
      },
      new Request('http://platform.localhost/api/platform')
    );
    org = (result as { id: string }).id;
  } else
    await owner.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,vertical,"updatedAt") VALUES ($1,$1,'H1 regression','H1 regression','ACTIVE','PHARMACY',now())`,
      [org]
    );
  return withTenantDb(
    org,
    async (db) => {
      await db.organization.update({ where: { id: org }, data: { pharmacyOperatingMode: 'SOLO' } });
      if (kind !== 'provisioned')
        await db.organizationDepartment.create({
          data: { organizationId: org, key: 'PHARMACY', name: 'PHARMACY' },
        });
      const role =
        kind === 'provisioned'
          ? await db.organizationRole.findFirstOrThrow({ where: { key: 'owner' } })
          : await db.organizationRole.create({
              data: {
                organizationId: org,
                key: 'owner',
                isSystem: true,
                name: kind,
              },
            });
      if (kind !== 'provisioned')
        for (const capability of [
          'pharmacy:dispense',
          'pharmacy:safety',
          'pharmacy:catalogue-review',
        ])
          await db.organizationRolePermission.create({
            data: { organizationId: org, organizationRoleId: role.id, capability, effect: 'ALLOW' },
          });
      const user =
        kind === 'provisioned'
          ? await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
          : await db.user.create({
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
      const branch =
        kind === 'provisioned'
          ? await db.pharmacyBranch.findFirstOrThrow({ where: { code: 'MAIN' } })
          : await db.pharmacyBranch.create({
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
    'preserves every capability and all active branches for persisted %s absent DENY',
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
              await can(
                { id: f.user, role: 'EMPLOYEE' },
                action,
                { type: 'Resignation', userId: 'other', status: 'PENDING' },
                { db }
              ),
              action
            ).toBe(true);
          expect(await procure(db, f.user)).toBe(true);
          await db.userPermissionOverride.create({
            data: {
              userId: f.user,
              capability: '*',
              effect: 'DENY',
              reason: 'Regression revocation',
            },
          });
          for (const action of actions)
            expect(
              await can(
                { id: f.user, role: 'ADMIN' },
                action,
                { type: 'Resignation', userId: 'other', status: 'PENDING' },
                { db }
              ),
              action
            ).toBe(false);
          expect(await procure(db, f.user)).toBe(false);
          await db.userPermissionOverride.deleteMany({ where: { userId: f.user } });

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

  it('approves a real provisioned bootstrap owner purchase through the router with an atomic PIN audit', async () => {
    const f = await fixture('provisioned');
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

  it.each([false, true])(
    'router posting commits exactly one controlled approval or none on revoked supplier (revoked=%s)',
    async (revoked) => {
      const f = await fixture('owner');
      const receipt = await withTenantDb(
        f.org,
        (db) => caller(db, f).createGoodsReceipt(receiptInput(f)),
        { skipDrain: true }
      );
      if (revoked)
        await withTenantDb(
          f.org,
          (db) =>
            db.pharmacySupplier.update({
              where: { id: f.supplier },
              data: { authorized: false },
            }),
          { skipDrain: true }
        );
      // Exercise the actual router with independently committed precheck and posting
      // transactions, so a request-wide rollback cannot hide a leaked success audit.
      await withTenantDb(
        f.org,
        async (db) => {
          const requestDb = new Proxy(db, {
            get(target, key) {
              if (key === '$transaction')
                return (run: (tx: ScopedDb) => Promise<unknown>) =>
                  withTenantDb(f.org, run, { skipDrain: true });
              return Reflect.get(target, key);
            },
          });
          const posting = caller(requestDb, f).postGoodsReceipt({
            branchId: f.branch,
            goodsReceiptId: receipt.id,
            staffProfileId: f.profile,
            pin,
          });
          if (revoked)
            await expect(posting).rejects.toMatchObject({
              code: 'FORBIDDEN',
              message: 'SUPPLIER_NOT_AUTHORIZED',
            });
          else await expect(posting).resolves.toHaveProperty('goodsReceiptId', receipt.id);
        },
        { skipDrain: true }
      );
      await withTenantDb(
        f.org,
        async (db) => {
          expect(
            (
              await db.pharmacyGoodsReceipt.findUniqueOrThrow({
                where: { id: receipt.id },
              })
            ).status
          ).toBe(revoked ? 'DRAFT' : 'POSTED');
          expect(
            await db.auditLog.count({
              where: {
                action: 'PHARMACY:SOLO_OWNER_PIN',
                targetType: 'ControlledPurchase',
                targetId: receipt.id,
              },
            })
          ).toBe(revoked ? 0 : 1);
          expect(
            await db.pharmacyControlledRegisterEntry.count({
              where: {
                organizationId: f.org,
              },
            })
          ).toBe(revoked ? 0 : 1);
          expect(
            await db.pharmacyInventoryLot.count({
              where: {
                organizationId: f.org,
              },
            })
          ).toBe(revoked ? 0 : 1);
        },
        { skipDrain: true }
      );
    }
  );

  it('rejects a controlled self-witness with dispense DENY even with the owner PIN', async () => {
    const f = await fixture();
    const receipt = await withTenantDb(
      f.org,
      (db) => caller(db, f).createGoodsReceipt(receiptInput(f)),
      { skipDrain: true }
    );
    const { verifyControlledPurchaseWitness } = await import('./goods-receipt');
    await withTenantDb(
      f.org,
      async (db) => {
        await db.userPermissionOverride.create({
          data: {
            userId: f.user,
            capability: 'pharmacy:dispense',
            effect: 'DENY',
            reason: 'Revoked dispensing',
          },
        });
        expect(await procure(db, f.user)).toBe(true);
        expect(
          await verifyControlledPurchaseWitness(db, scope(f), {
            goodsReceiptId: receipt.id,
            staffProfileId: f.profile,
            pin,
          })
        ).toHaveProperty('blocked');
        expect(
          await db.auditLog.count({
            where: {
              action: 'PHARMACY:SOLO_OWNER_PIN',
              targetType: 'ControlledPurchase',
              targetId: receipt.id,
            },
          })
        ).toBe(0);
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
  it('counts active pharmacy membership tenant-wide including sibling-branch staff', async () => {
    const f = await fixture('owner');
    // Once staffed, sensitive work requires an exact grant in addition to PIN.
    await withTenantDb(
      f.org,
      (db) =>
        db.userPermissionOverride.create({
          data: {
            userId: f.user,
            capability: 'pharmacy:dispense',
            effect: 'ALLOW',
            reason: 'Qualified proprietor',
          },
        }),
      { skipDrain: true }
    );
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
        expect(await soloOwnerEligible(db, scope(f))).toBe(false);
        expect(await soloOwnerEligible(db, { ...scope(f), branchId: null })).toBe(false);
        expect(await listControlledPinWitnesses(db, f.org, f.user, f.branch)).toEqual([]);
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
    // Once staffed, sensitive work requires an exact grant in addition to PIN.
    await withTenantDb(
      f.org,
      (db) =>
        db.userPermissionOverride.create({
          data: {
            userId: f.user,
            capability: 'pharmacy:dispense',
            effect: 'ALLOW',
            reason: 'Qualified proprietor',
          },
        }),
      { skipDrain: true }
    );
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

  it('authenticates a direct purchase approver instead of trusting their submitted identity', async () => {
    const f = await fixture();
    const receiver = await withTenantDb(
      f.org,
      async (db) => {
        const user = await db.user.create({
          data: {
            name: 'Receiver',
            email: `${f.org}-receiver@example.invalid`,
            department: 'PHARMACY',
            title: 'Receiver',
            status: 'ACTIVE',
            role: 'ADMIN',
          },
        });
        await db.pharmacyBranchAssignment.create({ data: { userId: user.id, branchId: f.branch } });
        return user;
      },
      { skipDrain: true }
    );
    for (const suppliedPin of [undefined, '9999']) {
      const input = receiptInput(f);
      input.directPurchase.pin = suppliedPin as string;
      await expect(
        withTenantDb(
          f.org,
          (db) => caller(db, { ...f, user: receiver.id }).createGoodsReceipt(input),
          { skipDrain: true }
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await withTenantDb(
      f.org,
      async (db) => {
        expect(await db.pharmacyGoodsReceipt.count()).toBe(0);
        expect(await db.auditLog.count({ where: { action: 'PHARMACY:SOLO_OWNER_PIN' } })).toBe(0);
        expect(
          await db.restaurantOperatorCredential.findFirstOrThrow({
            where: { staffProfileId: f.profile },
          })
        ).toMatchObject({ failedAttempts: 1 });
      },
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        f.org,
        (db) => caller(db, { ...f, user: receiver.id }).createGoodsReceipt(receiptInput(f)),
        { skipDrain: true }
      )
    ).resolves.toMatchObject({ receivedByUserId: receiver.id, bypassApprovedByUserId: f.user });
  });

  it('retains actual second-approver purchase approval with multiple active staff', async () => {
    const f = await fixture();
    await owner.query(`UPDATE organizations SET "pharmacyOperatingMode"='STAFFED' WHERE id=$1`, [
      f.org,
    ]);
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

it('runs catalogue, dispensing, PV and a controlled prescription sale as the real provisioned sole owner', async () => {
  const f = await fixture('provisioned');
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
      const context = {
        db,
        entitlements: {
          organizationId: f.org,
          enabledModules: [
            'pharmacy-counter',
            'pharmacy-core',
            'pharmacy-dispensing',
            'pharmacy-reports',
          ],
          modules: [],
        },
        session: {
          expires: 'later',
          user: { id: f.user, organizationId: f.org, role: 'EMPLOYEE', status: 'ACTIVE' },
        },
        organization: { id: f.org, vertical: 'PHARMACY' },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {}, db },
      } as never;
      const api = pharmacySalesRouter.createCaller(context);
      const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
      const { pharmacyDispensingRouter } = await import('@/server/routers/pharmacy-dispensing');
      const { pharmacyReportsRouter } = await import('@/server/routers/pharmacy-reports');
      const catalogue = await pharmacyMedicineRouter.createCaller(context).createMedicine({
        productName: 'Provisioned catalogue write',
        productFamily: 'PHARMACEUTICAL',
      });
      expect(catalogue).toHaveProperty('id');
      expect(await pharmacyDispensingRouter.createCaller(context).reviewQueue()).toMatchObject({
        currentUserId: f.user,
        items: [],
      });
      await db.$queryRaw`SELECT set_config('app.current_branch_id', ${f.branch}, true)`;
      const pv = pharmacyReportsRouter.createCaller(context);
      const report = await pv.createPharmacovigilanceReport({
        branchId: f.branch,
        kind: 'MEDICATION_ERROR',
        occurredAt: new Date(),
        assertedDescription: 'Human asserted regression evidence',
      });
      await pv.transitionPharmacovigilanceReport({
        id: report.id,
        branchId: f.branch,
        state: 'UNDER_REVIEW',
      });
      expect(
        await pv.transitionPharmacovigilanceReport({
          id: report.id,
          branchId: f.branch,
          state: 'READY',
          ownerAuthorization: { staffProfileId: f.profile, pin },
        })
      ).toMatchObject({ state: 'READY', reviewedByUserId: f.user });
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

// Independent tenant-scoped connections make lock waits and MVCC snapshots real.
async function tenantConnection(f: Fixture, isolation = 'READ COMMITTED') {
  const client = new Client({ connectionString: configuredUrl });
  await client.connect();
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
  await client.query(
    `SELECT set_config('app.current_organization_id', $1, true), set_config('app.current_branch_id', $2, true)`,
    [f.org, f.branch]
  );
  await client.query(`SET LOCAL statement_timeout = '5s'`);
  return client;
}
async function closeConnections(...clients: Client[]) {
  for (const client of clients) {
    await client.query('ROLLBACK');
    await client.end();
  }
}
async function waitUntilBlocked(client: Client) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await owner.query(
      'SELECT cardinality(pg_blocking_pids(pid)) > 0 AS blocked FROM pg_stat_activity WHERE pid=$1',
      [(client as Client & { processID: number }).processID]
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected database lock wait was not observed');
}
// Install transaction-bound evidence directly to isolate the SQL guard. The
// router tests above independently exercise actual PIN reauthentication.
async function sqlAudit(
  client: Client,
  f: Fixture,
  target: string,
  type = 'PharmacyPurchaseOrder'
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO audit_logs (id,"organizationId","actorId",source,category,action,"targetType","targetId",metadata)
     VALUES ($1,$2,$3,'TRPC','PHARMACY','PHARMACY:SOLO_OWNER_PIN',$6,$4,$5::jsonb)`,
    [
      id,
      f.org,
      f.user,
      target,
      JSON.stringify({ branchId: f.branch, reauthentication: 'PIN' }),
      type,
    ]
  );
  await client.query(`SELECT set_config('app.pharmacy_solo_audit_id',$1,true)`, [id]);
}
function sqlApprove(client: Client, f: Fixture, id: string) {
  return client.query(
    `UPDATE pharmacy_purchase_orders SET status='APPROVED',"approvedByUserId"=$1,"approvedAt"=now() WHERE id=$2`,
    [f.user, id]
  );
}

describe('solo approval database guard regressions', () => {
  it.each(['purchase', 'count', 'transfer'] as const)(
    'rechecks maker-only changes on approved %s rows and requires fresh transaction-bound PIN evidence',
    async (kind) => {
      const f = await fixture('owner');
      const priorMaker = await withTenantDb(
        f.org,
        (db) =>
          db.user.create({
            data: {
              name: 'Prior maker',
              email: `${randomUUID()}@example.invalid`,
              department: 'PHARMACY',
              title: 'Staff',
              status: 'INACTIVE',
            },
          }),
        { skipDrain: true }
      );
      const target = await withTenantDb(
        f.org,
        async (db) => {
          if (kind === 'purchase') {
            const po = await db.pharmacyPurchaseOrder.create({
              data: {
                branchId: f.branch,
                supplierId: f.supplier,
                reference: randomUUID(),
                createdByUserId: priorMaker.id,
              },
            });
            await db.pharmacyPurchaseOrder.update({
              where: { id: po.id },
              data: { status: 'SUBMITTED' },
            });
            await db.pharmacyPurchaseOrder.update({
              where: { id: po.id },
              data: { status: 'APPROVED', approvedByUserId: f.user, approvedAt: new Date() },
            });
            return { id: po.id, type: 'PharmacyPurchaseOrder' };
          }
          if (kind === 'transfer') {
            const transfer = await db.pharmacyInterbranchTransfer.create({
              data: {
                fromBranchId: f.branch,
                toBranchId: f.other,
                allocatedById: priorMaker.id,
                approvedById: f.user,
              },
            });
            return { id: transfer.id, type: 'PharmacyTransfer' };
          }
          const receipt = await caller(db, f).createGoodsReceipt(receiptInput(f));
          const { postGoodsReceipt } = await import('./goods-receipt');
          await postGoodsReceipt(db, scope(f), {
            goodsReceiptId: receipt.id,
            at: new Date(),
            staffProfileId: f.profile,
            pin,
          });
          const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
            where: { branchId: f.branch },
          });
          const count = await db.pharmacyInventoryCount.create({
            data: { branchId: f.branch, varianceThreshold: 0, createdById: priorMaker.id },
          });
          await db.pharmacyInventoryCountLine.create({
            data: {
              countId: count.id,
              branchId: f.branch,
              inventoryLotId: lot.id,
              stockLocationId: f.location,
              expectedUnits: 0,
              expectedSealedPacks: 0,
              expectedLooseUnits: 0,
              countedUnits: 1,
              countedSealedPacks: 0,
              countedLooseUnits: 1,
              varianceUnits: 1,
            },
          });
          await db.pharmacyInventoryCount.update({
            where: { id: count.id },
            data: { status: 'APPROVED', approvedById: f.user, approvedAt: new Date() },
          });
          return { id: count.id, type: 'PharmacyInventoryCount' };
        },
        { skipDrain: true, timeout: 60_000 }
      );
      const updateMaker = (db: ScopedDb, maker: string) => {
        if (kind === 'purchase')
          return db.pharmacyPurchaseOrder.update({
            where: { id: target.id },
            data: { createdByUserId: maker },
          });
        if (kind === 'count')
          return db.pharmacyInventoryCount.update({
            where: { id: target.id },
            data: { createdById: maker },
          });
        return db.pharmacyInterbranchTransfer.update({
          where: { id: target.id },
          data: { allocatedById: maker },
        });
      };
      // Changing only the checker to the existing maker must also revalidate.
      await expect(
        withTenantDb(
          f.org,
          async (db) => {
            if (kind === 'purchase') {
              await db.pharmacyPurchaseOrder.update({
                where: { id: target.id },
                data: { approvedByUserId: priorMaker.id },
              });
            } else if (kind === 'count') {
              await db.pharmacyInventoryCount.update({
                where: { id: target.id },
                data: { approvedById: priorMaker.id },
              });
            } else {
              await db.pharmacyInterbranchTransfer.update({
                where: { id: target.id },
                data: { approvedById: priorMaker.id },
              });
            }
          },
          { skipDrain: true }
        )
      ).rejects.toThrow(/self approval requires solo owner PIN audit/);
      // Neither absent evidence nor evidence committed in a prior transaction suffices.
      const attempt = () =>
        withTenantDb(
          f.org,
          async (db) => {
            await updateMaker(db, f.user);
          },
          { skipDrain: true }
        );
      await expect(attempt()).rejects.toThrow(/self approval requires solo owner PIN audit/);
      await withTenantDb(
        f.org,
        async (db) => {
          expect(await authorize(db, scope(f), target, pin)).toBe(true);
        },
        { skipDrain: true }
      );
      await expect(attempt()).rejects.toThrow(/self approval requires solo owner PIN audit/);
      await withTenantDb(
        f.org,
        async (db) => {
          expect(await authorize(db, scope(f), target, pin)).toBe(true);
          await updateMaker(db, f.user);
        },
        { skipDrain: true }
      );
      // An unchanged approval remains editable after its audit transaction commits.
      await withTenantDb(
        f.org,
        async (db) => {
          await updateMaker(db, f.user);
        },
        { skipDrain: true }
      );
      if (kind !== 'transfer') {
        await expect(
          withTenantDb(
            f.org,
            async (db) => {
              const data = { approvedAt: new Date('2030-01-01') };
              if (kind === 'purchase') {
                await db.pharmacyPurchaseOrder.update({ where: { id: target.id }, data });
              } else {
                await db.pharmacyInventoryCount.update({ where: { id: target.id }, data });
              }
            },
            { skipDrain: true }
          )
        ).rejects.toThrow(/self approval requires solo owner PIN audit/);
      }
    }
  );

  it('rechecks receiver-only changes but permits ordinary edits to historical receipts', async () => {
    const f = await fixture();
    const receipt = await withTenantDb(
      f.org,
      (db) => caller(db, f).createGoodsReceipt(receiptInput(f)),
      { skipDrain: true }
    );
    const second = await withTenantDb(
      f.org,
      (db) =>
        db.user.create({
          data: {
            name: 'Second receiver',
            email: `${randomUUID()}@example.invalid`,
            department: 'PHARMACY',
            title: 'Staff',
            status: 'ACTIVE',
          },
        }),
      { skipDrain: true }
    );
    await withTenantDb(
      f.org,
      async (db) => {
        await db.pharmacyGoodsReceipt.update({
          where: { id: receipt.id },
          data: { note: 'Historical evidence stays valid' },
        });
        await db.pharmacyGoodsReceipt.update({
          where: { id: receipt.id },
          data: { receivedByUserId: second.id },
        });
      },
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        f.org,
        (db) =>
          db.pharmacyGoodsReceipt.update({
            where: { id: receipt.id },
            data: { receivedByUserId: f.user },
          }),
        { skipDrain: true }
      )
    ).rejects.toThrow(/direct purchase self approval requires solo owner PIN audit/);
    await withTenantDb(
      f.org,
      async (db) => {
        const stored = await db.pharmacyGoodsReceipt.findUniqueOrThrow({
          where: { id: receipt.id },
        });
        expect(stored.receivedByUserId).toBe(second.id);
        expect(stored.bypassApprovedByUserId).toBe(f.user);
        expect(stored.bypassApprovedAt).toEqual(receipt.bypassApprovedAt);
      },
      { skipDrain: true }
    );
  });

  it('requires fresh PIN audit when a receiver-only change restores eligible solo self approval', async () => {
    const f = await fixture();
    const receipt = await withTenantDb(
      f.org,
      (db) => caller(db, f).createGoodsReceipt(receiptInput(f)),
      { skipDrain: true }
    );
    const receiver = await withTenantDb(
      f.org,
      async (db) => {
        const user = await db.user.create({
          data: {
            name: 'Prior receiver',
            email: `${randomUUID()}@example.invalid`,
            department: 'PHARMACY',
            title: 'Staff',
            status: 'INACTIVE',
          },
        });
        await db.pharmacyGoodsReceipt.update({
          where: { id: receipt.id },
          data: { receivedByUserId: user.id },
        });
        return user;
      },
      { skipDrain: true }
    );
    await expect(
      withTenantDb(
        f.org,
        (db) =>
          db.pharmacyGoodsReceipt.update({
            where: { id: receipt.id },
            data: { receivedByUserId: f.user },
          }),
        { skipDrain: true }
      )
    ).rejects.toThrow(/direct purchase self approval requires solo owner PIN audit/);
    await withTenantDb(
      f.org,
      async (db) => {
        expect(
          (await db.pharmacyGoodsReceipt.findUniqueOrThrow({ where: { id: receipt.id } }))
            .receivedByUserId
        ).toBe(receiver.id);
        expect(
          await authorize(db, scope(f), { type: 'PharmacyGoodsReceipt', id: receipt.id }, pin)
        ).toBe(true);
        const updated = await db.pharmacyGoodsReceipt.update({
          where: { id: receipt.id },
          data: { receivedByUserId: f.user },
        });
        expect(updated.bypassApprovedAt).toEqual(receipt.bypassApprovedAt);
        expect(updated.receivedByUserId).toBe(f.user);
        expect(
          await db.auditLog.count({
            where: { targetId: receipt.id, action: 'PHARMACY:SOLO_OWNER_PIN' },
          })
        ).toBe(2);
      },
      { skipDrain: true }
    );
  });

  it('allows simultaneous self approvals in different organizations', async () => {
    const f = await fixture();
    const g = await fixture();
    const po = await order(f);
    const other = await order(g);
    const a = await tenantConnection(f);
    const b = await tenantConnection(g);
    try {
      await sqlAudit(a, f, po.id);
      await sqlAudit(b, g, other.id);
      await sqlApprove(a, f, po.id);
      // A remains uncommitted. B must finish without waiting for tenant A.
      await sqlApprove(b, g, other.id);
      await a.query('COMMIT');
      await b.query('COMMIT');
    } finally {
      await closeConnections(a, b);
    }
  });

  it('serializes simultaneous self approvals in one organization without lock upgrades', async () => {
    const f = await fixture();
    const first = await order(f);
    const second = await order(f);
    const a = await tenantConnection(f);
    const b = await tenantConnection(f);
    try {
      // Foreign-key checks in an approval transaction may already hold KEY SHARE.
      await a.query('SELECT id FROM organizations WHERE id=$1 FOR KEY SHARE', [f.org]);
      await b.query('SELECT id FROM organizations WHERE id=$1 FOR KEY SHARE', [f.org]);
      await sqlAudit(a, f, first.id);
      await sqlAudit(b, f, second.id);
      await sqlApprove(a, f, first.id);
      const pending = sqlApprove(b, f, second.id);
      await waitUntilBlocked(b);
      await a.query('COMMIT');
      await pending;
      await b.query('COMMIT');
    } finally {
      await closeConnections(a, b);
    }
  });

  it.each(['activation', 'assignment', 'unlinked staff', 'owner role'] as const)(
    'rechecks solo eligibility after a concurrent %s change commits',
    async (change) => {
      const f = await fixture();
      const po = await order(f);
      const staff = await withTenantDb(
        f.org,
        async (db) => {
          const role = await db.organizationRole.create({
            data: { key: 'second-role', name: 'Staff' },
          });
          const user = await db.user.create({
            data: {
              name: 'Concurrent staff',
              email: `${randomUUID()}@example.invalid`,
              department: 'PHARMACY',
              title: 'Staff',
              status: 'INACTIVE',
              organizationRoleId: role.id,
            },
          });
          if (change !== 'activation')
            await db.pharmacyBranchAssignment.create({
              data: { userId: user.id, branchId: f.other },
            });
          return { user, role };
        },
        { skipDrain: true }
      );
      const roster = await tenantConnection(f);
      const approval = await tenantConnection(f);
      try {
        await sqlAudit(approval, f, po.id);
        const before = await approval.query(
          'SELECT pharmacy_solo_owner_eligible($1,$2,$3) AS eligible',
          [f.org, f.branch, f.user]
        );
        expect(before.rows[0].eligible).toBe(true);
        if (change !== 'activation')
          await roster.query(`UPDATE users SET status='ACTIVE' WHERE id=$1`, [staff.user.id]);
        if (change === 'activation')
          await roster.query(`UPDATE users SET status='ACTIVE' WHERE id=$1`, [staff.user.id]);
        if (change === 'assignment')
          await roster.query(
            `UPDATE pharmacy_branch_assignments SET "branchId"=$1 WHERE "userId"=$2`,
            [f.branch, staff.user.id]
          );
        if (change === 'unlinked staff')
          await roster.query(
            `INSERT INTO restaurant_staff_profiles (id,"organizationId","displayName","updatedAt") VALUES ($1,$2,'Unlinked',now())`,
            [randomUUID(), f.org]
          );
        if (change === 'owner role')
          await roster.query(`UPDATE organization_roles SET key='owner-renamed' WHERE id=$1`, [
            staff.role.id,
          ]);
        const pending = sqlApprove(approval, f, po.id).catch((error: unknown) => error);
        await waitUntilBlocked(approval);
        await roster.query('COMMIT');
        expect(await pending).toMatchObject({
          code: '23514',
          message: 'purchase self approval requires solo owner PIN audit',
        });
      } finally {
        await closeConnections(roster, approval);
      }
    }
  );

  it('blocks same-tenant roster writes until approval commits while other tenants remain writable', async () => {
    const f = await fixture();
    const g = await fixture();
    const po = await order(f);
    const approval = await tenantConnection(f);
    const roster = await tenantConnection(f);
    const unrelated = await tenantConnection(g);
    try {
      await sqlAudit(approval, f, po.id);
      await sqlApprove(approval, f, po.id);
      const pending = roster.query(`UPDATE users SET status='INACTIVE' WHERE id=$1`, [f.user]);
      await waitUntilBlocked(roster);
      await unrelated.query(`UPDATE users SET status='INACTIVE' WHERE id=$1`, [g.user]);
      await unrelated.query('COMMIT');
      await approval.query('COMMIT');
      await pending;
      await roster.query('COMMIT');
    } finally {
      await closeConnections(approval, roster, unrelated);
    }
  });

  it('fails safely when a repeatable-read approval snapshot predates a roster change', async () => {
    const f = await fixture();
    const po = await order(f);
    const approval = await tenantConnection(f, 'REPEATABLE READ');
    const roster = await tenantConnection(f);
    try {
      await sqlAudit(approval, f, po.id);
      await approval.query('SELECT pharmacy_solo_owner_eligible($1,$2,$3)', [
        f.org,
        f.branch,
        f.user,
      ]);
      await roster.query(`UPDATE users SET status='INACTIVE' WHERE id=$1`, [f.user]);
      await roster.query('COMMIT');
      await expect(sqlApprove(approval, f, po.id)).rejects.toMatchObject({ code: '40001' });
    } finally {
      await closeConnections(approval, roster);
    }
  });
});

it('signs off opening stock only with authorized solo PIN proof and retains multi-staff coauthorization', async () => {
  const f = await fixture('owner');
  const { signOffOpeningSession } = await import('./migration/opening-stock');
  const create = () =>
    withTenantDb(
      f.org,
      (db) =>
        db.pharmacyOpeningSession.create({
          data: {
            branchId: f.branch,
            openingAt: new Date(),
            status: 'POSTED',
            postedAt: new Date(),
            postedByActorId: f.user,
            createdByActorId: f.user,
          },
        }),
      { skipDrain: true }
    );
  const session = await create();
  await expect(
    withTenantDb(f.org, (db) => signOffOpeningSession(db, scope(f), session.id), {
      skipDrain: true,
    })
  ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
  await withTenantDb(
    f.org,
    async (db) => {
      expect(await signOffOpeningSession(db, scope(f), session.id, pin)).toMatchObject({
        status: 'SIGNED_OFF',
        signedOffBy: f.user,
      });
      expect(
        await db.auditLog.count({
          where: {
            action: 'PHARMACY:SOLO_OWNER_PIN',
            targetType: 'PharmacyOpeningSession',
            targetId: session.id,
          },
        })
      ).toBe(1);
    },
    { skipDrain: true }
  );
  const staffed = await create();
  await withTenantDb(
    f.org,
    (db) =>
      db.user.create({
        data: {
          name: 'Unassigned colleague',
          email: `${randomUUID()}@example.invalid`,
          department: 'PHARMACY',
          title: 'Staff',
          status: 'ACTIVE',
        },
      }),
    { skipDrain: true }
  );
  await expect(
    withTenantDb(f.org, (db) => signOffOpeningSession(db, scope(f), staffed.id, pin), {
      skipDrain: true,
    })
  ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
  await withTenantDb(
    f.org,
    async (db) => {
      expect(
        (
          await db.pharmacyOpeningSession.findUniqueOrThrow({
            where: { organizationId_id: { organizationId: f.org, id: staffed.id } },
          })
        ).status
      ).toBe('POSTED');
      expect(
        await db.auditLog.count({
          where: { action: 'PHARMACY:SOLO_OWNER_PIN', targetId: staffed.id },
        })
      ).toBe(0);
    },
    { skipDrain: true }
  );
});

it('PV READY database guard rechecks a concurrent staff activation and holds the roster through commit', async () => {
  const f = await fixture();
  const { report, staff } = await withTenantDb(
    f.org,
    async (db) => {
      await db.$queryRaw`SELECT set_config('app.current_branch_id', ${f.branch}, true)`;
      return {
        report: await db.pharmacyPharmacovigilanceReport.create({
          data: {
            branchId: f.branch,
            kind: 'MEDICATION_ERROR',
            state: 'UNDER_REVIEW',
            occurredAt: new Date(),
            assertedDescription: 'Concurrent PV regression',
            createdByUserId: f.user,
          },
        }),
        staff: await db.user.create({
          data: {
            name: 'Joining colleague',
            email: `${randomUUID()}@example.invalid`,
            department: 'PHARMACY',
            title: 'Staff',
            status: 'INACTIVE',
          },
        }),
      };
    },
    { skipDrain: true }
  );
  const approve = (c: Client) =>
    c.query(
      `UPDATE pharmacy_pharmacovigilance_reports SET state='READY',"reviewedByUserId"=$1 WHERE id=$2`,
      [f.user, report.id]
    );
  const roster = await tenantConnection(f);
  const approval = await tenantConnection(f);
  try {
    await expect(approve(approval)).rejects.toMatchObject({ code: '23514' });
    await approval.query('ROLLBACK');
    await approval.query('BEGIN');
    await approval.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await approval.query(
      `SELECT set_config('app.current_organization_id',$1,true), set_config('app.current_branch_id',$2,true)`,
      [f.org, f.branch]
    );
    await sqlAudit(approval, f, report.id, 'PharmacyPharmacovigilanceReport');
    expect(
      (
        await approval.query('SELECT pharmacy_solo_owner_eligible($1,$2,$3) AS allowed', [
          f.org,
          f.branch,
          f.user,
        ])
      ).rows[0].allowed
    ).toBe(true);
    await roster.query(`UPDATE users SET status='ACTIVE' WHERE id=$1`, [staff.id]);
    const pending = approve(approval).catch((e: unknown) => e);
    await waitUntilBlocked(approval);
    await roster.query('COMMIT');
    expect(await pending).toMatchObject({
      code: '23514',
      message: 'PV self review requires solo owner PIN audit',
    });
  } finally {
    await closeConnections(roster, approval);
  }
  await withTenantDb(
    f.org,
    (db) => db.user.update({ where: { id: staff.id }, data: { status: 'INACTIVE' } }),
    { skipDrain: true }
  );
  const a = await tenantConnection(f);
  const b = await tenantConnection(f);
  try {
    await a.query('SELECT pharmacy_lock_solo_roster($1)', [f.org]);
    await sqlAudit(a, f, report.id, 'PharmacyPharmacovigilanceReport');
    await approve(a);
    const joining = b.query(`UPDATE users SET status='ACTIVE' WHERE id=$1`, [staff.id]);
    await waitUntilBlocked(b);
    await a.query('COMMIT');
    await joining;
    await b.query('COMMIT');
  } finally {
    await closeConnections(a, b);
  }
});
