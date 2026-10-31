// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { assertBranchAssignment } from '@/lib/pharmacy/branch-assignment';
import { ALL_ACTIONS } from '@/lib/abac/policies';
import { can } from '@/lib/abac';
import { authorizeMakerChecker, SOLO_OWNER_POLICY } from '@/lib/pharmacy/maker-checker';
import { toAuditJson } from '@/server/audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
const suffix = randomBytes(6).toString('hex');
const org = `mbr_${suffix}`;
const owner = `owner_${suffix}`;
const cashier = `cashier_${suffix}`;
const branchA = `a_${suffix}`;
const branchB = `b_${suffix}`;
const otherOrg = `foreign_${suffix}`;
const foreignBranch = `foreign_branch_${suffix}`;
const deviceA = `device_${suffix}`;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
let staffId: string;
let credentialId: string;
const scope = (actorId = cashier, branchId = branchA) => ({
  organizationId: org,
  actorId,
  branchId,
});
function inOrg<T>(run: (db: ScopedDb) => Promise<T>) {
  return withTenantDb(org, run);
}

// Skips like the other database suites when no PostgreSQL is configured.
const hasDatabase = Boolean(process.env.DATABASE_URL);
beforeAll(async () => {
  if (!hasDatabase) return;
  process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt") SELECT id,id,id,id,'PHARMACY','ACTIVE','SHARED',now(),now() FROM unnest($1::text[]) AS id`,
      [org, otherOrg]
    )
  );
  await inOrg(async (db) => {
    await db.organizationDepartment.create({ data: { key: 'COUNTER', name: 'Counter' } });
    const ownerRole = await db.organizationRole.create({
      data: {
        key: 'owner',
        name: 'Owner',
        isSystem: true,
        permissions: {
          create: ['*', 'pharmacy:dispense', 'pharmacy:safety', 'pharmacy:catalogue-review'].map(
            (capability) => ({ capability, effect: 'ALLOW' as const })
          ),
        },
      },
    });
    await db.user.create({
      data: {
        id: owner,
        organizationRoleId: ownerRole.id,
        name: 'Owner',
        email: `${owner}@test.invalid`,
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'COUNTER',
        title: 'Owner',
      },
    });
    await db.pharmacyBranch.createMany({
      data: [branchA, branchB].map((id) => ({
        id,
        code: id,
        name: id,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      })),
    });
    const role = await db.organizationRole.create({
      data: {
        key: 'counter',
        name: 'Counter',
        permissions: { create: { capability: 'pharmacy:counter', effect: 'ALLOW' } },
      },
    });
    await db.user.create({
      data: {
        id: cashier,
        name: 'Cashier',
        email: `${cashier}@test.invalid`,
        role: 'EMPLOYEE',
        organizationRoleId: role.id,
        status: 'ACTIVE',
        department: 'COUNTER',
        title: 'Cashier',
      },
    });
    await db.pharmacyBranchAssignment.create({ data: { userId: cashier, branchId: branchA } });
    await db.pharmacyRegisteredDevice.create({
      data: {
        id: deviceA,
        branchId: branchA,
        name: 'Counter',
        deviceSecretHash: randomBytes(32).toString('hex'),
        enrolledByActorId: owner,
      },
    });
    const staff = await db.restaurantStaffProfile.create({
      data: { userId: owner, displayName: 'Owner' },
    });
    staffId = staff.id;
    const credential = await db.restaurantOperatorCredential.create({
      data: {
        staffProfileId: staffId,
        type: 'PIN',
        credentialHash: await hashOperatorCredential('PIN', '493826'),
      },
    });
    credentialId = credential.id;
  });
  await withTenantDb(otherOrg, (db) =>
    db.pharmacyBranch.create({
      data: {
        id: foreignBranch,
        code: 'FOREIGN',
        name: 'Foreign',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    })
  );
}, 120_000);

(hasDatabase ? describe.sequential : describe.skip)(
  'shared pharmacy branch and owner security (forced RLS)',
  () => {
    it('denies sibling, foreign, missing, inactive assignments and inactive members', async () => {
      for (const branch of [branchB, foreignBranch, 'missing'])
        await expect(
          inOrg((db) => assertBranchAssignment(db, scope(cashier, branch), { counter: true }))
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await inOrg((db) =>
        db.pharmacyBranchAssignment.updateMany({
          where: { userId: cashier },
          data: { active: false },
        })
      );
      await expect(inOrg((db) => assertBranchAssignment(db, scope()))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await inOrg((db) =>
        db.pharmacyBranchAssignment.updateMany({
          where: { userId: cashier },
          data: { active: true },
        })
      );
      await inOrg((db) => db.user.update({ where: { id: cashier }, data: { status: 'INACTIVE' } }));
      await expect(inOrg((db) => assertBranchAssignment(db, scope()))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await inOrg((db) => db.user.update({ where: { id: cashier }, data: { status: 'ACTIVE' } }));
    });
    it('checks device scope even when the actor can reach both branches', async () => {
      await expect(
        inOrg((db) =>
          assertBranchAssignment(db, scope(owner, branchB), { counter: true, deviceId: deviceA })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        inOrg((db) => assertBranchAssignment(db, scope(owner), { deviceId: 'unknown' }))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        inOrg((db) => assertBranchAssignment(db, scope(), { counter: true, deviceId: deviceA }))
      ).resolves.toEqual(scope());
    });
    it('requires counter, preserving explicit DENY over owner capabilities', async () => {
      await inOrg((db) =>
        db.userPermissionOverride.create({
          data: {
            userId: cashier,
            capability: 'pharmacy:counter',
            effect: 'DENY',
            reason: 'Regression test',
          },
        })
      );
      await expect(
        inOrg((db) => assertBranchAssignment(db, scope(), { counter: true }))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await inOrg((db) => db.userPermissionOverride.deleteMany({ where: { userId: cashier } }));
      await inOrg((db) =>
        db.userPermissionOverride.create({
          data: {
            userId: owner,
            capability: 'pharmacy:counter',
            effect: 'DENY',
            reason: 'Regression test',
          },
        })
      );
      await expect(
        inOrg((db) => assertBranchAssignment(db, scope(owner), { counter: true }))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await inOrg((db) => db.userPermissionOverride.deleteMany({ where: { userId: owner } }));
    });
    it('gives live owners every pharmacy capability and assignments on old and new branches', async () => {
      for (const action of ALL_ACTIONS.filter(
        (a) => a.startsWith('pharmacy:') || a === 'reports:operational' || a === 'reports:financial'
      ))
        expect(
          await inOrg((db) =>
            can(
              { id: owner, role: 'ADMIN', status: 'ACTIVE', department: null },
              action,
              undefined,
              {
                db,
              }
            )
          ),
          action
        ).toBe(true);
      const newBranch = `new_${suffix}`;
      await inOrg((db) =>
        db.pharmacyBranch.create({
          data: {
            id: newBranch,
            code: 'NEW',
            name: 'New',
            addressLine: '1 Test Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        })
      );
      const assignments = await inOrg((db) =>
        db.pharmacyBranchAssignment.findMany({
          where: { userId: owner, active: true },
          select: { branchId: true },
        })
      );
      expect(assignments.map((a) => a.branchId).sort()).toEqual(
        [branchA, branchB, newBranch].sort()
      );
      await expect(
        inOrg((db) => assertBranchAssignment(db, scope(owner, newBranch), { counter: true }))
      ).resolves.toEqual(scope(owner, newBranch));
    });
    it('enforces the same denial at drawer, refund, return and receiving entry points', async () => {
      const { pharmacySalesRouter } = await import('./pharmacy-sales');
      const { pharmacyPurchasingRouter } = await import('./pharmacy-purchasing');
      await inOrg(async (db) => {
        const ctx = {
          db,
          entitlements: {
            organizationId: org,
            enabledModules: ['pharmacy-counter', 'pharmacy-procurement'],
          },
          session: {
            user: { id: cashier, organizationId: org, role: 'EMPLOYEE', status: 'ACTIVE' },
          },
          organization: { id: org, vertical: 'PHARMACY' },
          support: null,
          requestMeta: { ip: null, userAgent: null },
        };
        const sales = pharmacySalesRouter.createCaller(ctx as never);
        const purchasing = pharmacyPurchasingRouter.createCaller(ctx as never);
        const date = new Date('2026-10-28T00:00:00Z');
        for (const call of [
          () =>
            sales.openDrawer({
              branchId: branchB,
              deviceId: deviceA,
              businessDate: date,
              openingFloatMinor: 0,
            }),
          () =>
            sales.drawerMovement({
              branchId: branchB,
              drawerSessionId: 'other',
              kind: 'PAID_OUT',
              amountMinor: 1,
              reason: 'test',
            }),
          () =>
            sales.closeDrawer({ branchId: branchB, drawerSessionId: 'other', countedCashMinor: 0 }),
          () =>
            sales.refundTender({
              branchId: branchB,
              deviceId: deviceA,
              originalTenderId: 'other',
              businessDate: date,
              amountMinor: 1,
              reason: 'test',
              idempotencyKey: 'test',
            }),
          () =>
            sales.returnLine({
              branchId: branchB,
              saleLineId: 'other',
              canonicalUnits: 1,
              reason: 'test',
              integrityDecision: 'test',
              idempotencyKey: 'test',
            }),
          () => purchasing.goodsReceipts({ branchId: branchB }),
        ])
          await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(await db.pharmacyDrawerSession.count()).toBe(0);
      });
    });
    it('filters sibling receipt details but counts full shared-order progress for a branch-restricted buyer', async () => {
      const { pharmacyPurchasingRouter } = await import('./pharmacy-purchasing');
      await inOrg(async (db) => {
        const permission = await db.userPermissionOverride.create({
          data: {
            userId: cashier,
            capability: 'pharmacy:procurement',
            effect: 'ALLOW',
            reason: 'Nested receiving branch regression',
          },
        });
        const api = (actorId: string) =>
          pharmacyPurchasingRouter.createCaller({
            db,
            entitlements: { organizationId: org, enabledModules: ['pharmacy-procurement'] },
            session: {
              user: {
                id: actorId,
                role: actorId === owner ? 'ADMIN' : 'EMPLOYEE',
                organizationId: org,
                status: 'ACTIVE',
              },
            },
            organization: { id: org, vertical: 'PHARMACY' },
            support: null,
            requestMeta: { ip: null, userAgent: null },
          } as never);
        try {
          const supplier = await db.pharmacySupplier.create({
            data: {
              name: 'Shared order supplier',
              authorized: true,
              licences: {
                create: {
                  licenceType: 'Wholesale',
                  licenceNumber: 'NESTED',
                  issuingAuthority: 'Test',
                  issuedAt: new Date('2020-01-01'),
                  expiresAt: new Date('2099-01-01'),
                  verifiedAt: new Date(),
                  verifiedByUserId: owner,
                },
              },
            },
          });
          const medicine = await db.medicine.create({
            data: { productName: 'Branch regression medicine', productFamily: 'PHARMACEUTICAL' },
          });
          const presentation = await db.presentation.create({
            data: { medicineId: medicine.id, presentation: 'Tablet' },
          });
          const pack = await db.packLevel.create({
            data: {
              presentationId: presentation.id,
              versionGroupId: `nested-receipt-${suffix}`,
              version: 1,
              level: 'STRIP',
              unitsPerParent: 10,
              effectiveFrom: new Date('2026-01-01'),
            },
          });
          // A central order is visible to both buyers; its receipts remain branch-owned.
          const order = await db.pharmacyPurchaseOrder.create({
            data: {
              reference: 'NESTED-RECEIPTS',
              status: 'SENT',
              branchId: null,
              supplierId: supplier.id,
              createdByUserId: owner,
              lines: {
                create: {
                  lineNumber: 1,
                  medicineId: medicine.id,
                  packLevelId: pack.id,
                  orderedPacks: 3,
                  canonicalUnitsPerPack: 10,
                  orderedCanonicalUnits: 30,
                  listPricePerPackMinor: 100,
                },
              },
            },
            include: { lines: true },
          });
          const receipts: { id: string }[] = [];
          for (const [branchId, packs] of [
            [branchA, 1],
            [branchB, 2],
          ] as const) {
            const location = await db.pharmacyStockLocation.create({
              data: { branchId, code: 'NESTED', name: 'Receiving', kind: 'STORE' },
            });
            receipts.push(
              await db.pharmacyGoodsReceipt.create({
                data: {
                  branchId,
                  reference: `NESTED-${branchId}`,
                  supplierId: supplier.id,
                  purchaseOrderId: order.id,
                  supplierInvoiceRef: `NESTED-${branchId}`,
                  supplierInvoiceDate: new Date('2026-10-28'),
                  warrantyEvidenceRef: 'test-warranty',
                  receivedByUserId: owner,
                  receivedAt: new Date('2026-10-28'),
                  lines: {
                    create: {
                      lineNumber: 1,
                      purchaseOrderLineId: order.lines[0]!.id,
                      medicineId: medicine.id,
                      packLevelId: pack.id,
                      batchNumber: `NESTED-${branchId}`,
                      printedExpiry: new Date('2028-01-01'),
                      expiryPrecision: 'DAY',
                      printedMrpMinor: 200,
                      canonicalUnitsPerPack: 10,
                      receivedPacks: packs,
                      receivedCanonicalUnits: packs * 10,
                      acceptedCanonicalUnits: packs * 10,
                      invoicedPricePerPackMinor: 100,
                      unitCostMinor: 10,
                      stockLocationId: location.id,
                    },
                  },
                },
              })
            );
          }
          for (const receipt of receipts) {
            await db.pharmacyGoodsReceipt.update({
              where: { id: receipt.id },
              data: { status: 'POSTED', postedAt: new Date('2026-10-28') },
            });
          }
          const buyer = api(cashier);
          await expect(buyer.goodsReceipts({ branchId: branchB })).rejects.toMatchObject({
            code: 'FORBIDDEN',
          });
          expect((await buyer.goodsReceipts({ branchId: branchA })).map((row) => row.id)).toContain(
            receipts[0]!.id
          );
          const visible = (await buyer.purchaseOrders()).find((row) => row.id === order.id);
          expect(visible?.goodsReceipts.map((row) => row.id)).toEqual([receipts[0]!.id]);
          expect(JSON.stringify(visible)).not.toContain(receipts[1]!.id);
          expect(JSON.stringify(visible)).not.toContain(`NESTED-${branchB}`);
          expect(await buyer.receivedAgainstOrder({ purchaseOrderId: order.id })).toEqual({
            [order.lines[0]!.id]: { receivedUnits: 30, acceptedUnits: 30, rejectedUnits: 0 },
          });
          const assertAllBranches = async (actorId: string) => {
            const caller = api(actorId);
            const shared = (await caller.purchaseOrders()).find((row) => row.id === order.id);
            expect(shared?.goodsReceipts.map((row) => row.id).sort()).toEqual(
              receipts.map((row) => row.id).sort()
            );
            expect(
              (await caller.goodsReceipts({ branchId: branchB })).map((row) => row.id)
            ).toContain(receipts[1]!.id);
            expect(await caller.receivedAgainstOrder({ purchaseOrderId: order.id })).toEqual({
              [order.lines[0]!.id]: { receivedUnits: 30, acceptedUnits: 30, rejectedUnits: 0 },
            });
          };
          await assertAllBranches(owner);
          await db.pharmacyBranchAssignment.create({
            data: { userId: cashier, branchId: branchB },
          });
          try {
            await assertAllBranches(cashier);
            await db.pharmacyBranch.update({ where: { id: branchB }, data: { active: false } });
            try {
              for (const actorId of [cashier, owner]) {
                const scoped = api(actorId);
                await expect(scoped.goodsReceipts({ branchId: branchB })).rejects.toMatchObject({
                  code: 'FORBIDDEN',
                });
                const shared = (await scoped.purchaseOrders()).find((row) => row.id === order.id);
                expect(shared?.goodsReceipts.map((row) => row.id)).toEqual([receipts[0]!.id]);
                expect(await scoped.receivedAgainstOrder({ purchaseOrderId: order.id })).toEqual({
                  [order.lines[0]!.id]: { receivedUnits: 30, acceptedUnits: 30, rejectedUnits: 0 },
                });
              }
            } finally {
              await db.pharmacyBranch.update({ where: { id: branchB }, data: { active: true } });
            }
          } finally {
            await db.pharmacyBranchAssignment.deleteMany({
              where: { userId: cashier, branchId: branchB },
            });
          }
        } finally {
          await db.userPermissionOverride.delete({ where: { id: permission.id } });
        }
      });
    });
    it('denies multi-staff self approval despite valid owner PIN', async () => {
      const result = await inOrg((db) =>
        authorizeMakerChecker(db, {
          organizationId: org,
          actorId: owner,
          makerIds: [owner],
          targetType: 'Test',
          targetId: 'multi',
          pin: { staffProfileId: staffId, pin: '493826' },
        })
      );
      expect(result).toEqual({ blocked: 'SELF_APPROVAL' });
      expect(
        await inOrg((db) => db.auditLog.count({ where: { action: 'PHARMACY:SOLO_OWNER_PIN' } }))
      ).toBe(0);
    });
    it('requires fresh PIN for a solo owner, persists failures, and audits successful reauthentication', async () => {
      await inOrg((db) => db.user.update({ where: { id: cashier }, data: { status: 'INACTIVE' } }));
      const input = {
        organizationId: org,
        actorId: owner,
        makerIds: [owner],
        targetType: 'Test',
        targetId: 'solo',
      };
      expect(await inOrg((db) => authorizeMakerChecker(db, input))).toEqual({
        blocked: 'SELF_APPROVAL',
      });
      expect(
        await inOrg((db) =>
          authorizeMakerChecker(db, { ...input, pin: { staffProfileId: staffId, pin: '111111' } })
        )
      ).toEqual({ blocked: 'SELF_APPROVAL', pinRejected: true });
      expect(
        (
          await inOrg((db) =>
            db.restaurantOperatorCredential.findUniqueOrThrow({ where: { id: credentialId } })
          )
        ).failedAttempts
      ).toBe(1);
      expect(
        await inOrg((db) =>
          authorizeMakerChecker(db, { ...input, pin: { staffProfileId: staffId, pin: '493826' } })
        )
      ).toEqual({ policy: SOLO_OWNER_POLICY });
      const audit = await inOrg((db) =>
        db.auditLog.findFirstOrThrow({
          where: { action: 'PHARMACY:SOLO_OWNER_PIN', targetId: 'solo' },
        })
      );
      expect(audit.actorId).toBe(owner);
      expect(audit.metadata).toMatchObject({
        policy: SOLO_OWNER_POLICY,
        reauthentication: 'PIN',
      });
      expect(JSON.stringify(audit)).not.toContain('493826');
      expect(toAuditJson({ approvalPin: { pin: '493826' } })).toEqual({
        approvalPin: '[REDACTED]',
      });
    });
    it('offers the sole active owner for business approval while preserving independent clinical witnesses', async () => {
      const { purchasingWorkspace } = await import('@/lib/pharmacy/purchasing-console');
      const workspace = await inOrg((db) =>
        purchasingWorkspace(db, { organizationId: org, actorId: owner })
      );
      expect(workspace.soloApprovalAllowed).toBe(true);
      expect(workspace.directPurchaseApprovers?.map((person) => person.id)).toEqual([owner]);
      expect(workspace.approvers.map((person) => person.id)).toEqual([owner]);
    });
    it('commits failed PIN counters through the outer router request transaction and locks repeated guesses', async () => {
      const { pharmacyPurchasingRouter } = await import('./pharmacy-purchasing');
      const order = await inOrg(async (db) => {
        const supplier = await db.pharmacySupplier.create({
          data: {
            name: 'Lockout supplier',
            authorized: true,
            licences: {
              create: {
                licenceType: 'Wholesale',
                licenceNumber: 'LOCKOUT',
                issuingAuthority: 'Test',
                issuedAt: new Date('2020-01-01'),
                expiresAt: new Date('2030-01-01'),
                verifiedAt: new Date(),
                verifiedByUserId: owner,
              },
            },
          },
        });
        return db.pharmacyPurchaseOrder.create({
          data: {
            reference: 'LOCKOUT',
            branchId: branchA,
            supplierId: supplier.id,
            createdByUserId: owner,
            status: 'SUBMITTED',
          },
        });
      });
      const request = () =>
        inOrg((db) =>
          pharmacyPurchasingRouter
            .createCaller({
              db,
              entitlements: { organizationId: org, enabledModules: ['pharmacy-procurement'] },
              session: {
                user: { id: owner, role: 'ADMIN', organizationId: org, status: 'ACTIVE' },
              },
              organization: { id: org, vertical: 'PHARMACY' },
              support: null,
              requestMeta: { ip: null, userAgent: null },
            } as never)
            .approvePurchaseOrder({
              purchaseOrderId: order.id,
              decision: 'APPROVED',
              pin: '111111',
            })
        );
      for (let attempt = 1; attempt <= 5; attempt++) {
        await expect(request()).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'SELF_APPROVAL',
        });
        expect(
          (
            await inOrg((db) =>
              db.restaurantOperatorCredential.findUniqueOrThrow({ where: { id: credentialId } })
            )
          ).failedAttempts
        ).toBe(attempt === 5 ? 0 : attempt);
      }
      expect(
        (
          await inOrg((db) =>
            db.restaurantOperatorCredential.findUniqueOrThrow({ where: { id: credentialId } })
          )
        ).lockedUntil!.getTime()
      ).toBeGreaterThan(Date.now());
      await expect(request()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(
        await inOrg((db) =>
          db.pharmacyPurchaseOrderApproval.count({ where: { purchaseOrderId: order.id } })
        )
      ).toBe(0);
      await inOrg((db) =>
        db.restaurantOperatorCredential.update({
          where: { id: credentialId },
          data: { failedAttempts: 0, lockedUntil: null },
        })
      );
    });
    it('posts a solo-owner PIN approval through the router and then requires a distinct approver with two staff', async () => {
      const { pharmacyPurchasingRouter } = await import('./pharmacy-purchasing');
      const { clearRateLimit } = await import('@/lib/rate-limit');
      await clearRateLimit(`pharmacy:solo-owner-pin:${org}:${owner}`);
      await inOrg(async (db) => {
        const supplier = await db.pharmacySupplier.create({
          data: {
            name: 'Licensed supplier',
            authorized: true,
            licences: {
              create: {
                licenceType: 'Wholesale',
                licenceNumber: 'TEST',
                issuingAuthority: 'Test',
                issuedAt: new Date('2020-01-01'),
                expiresAt: new Date('2030-01-01'),
                verifiedAt: new Date(),
                verifiedByUserId: owner,
              },
            },
          },
        });
        const createOrder = (reference: string) =>
          db.pharmacyPurchaseOrder.create({
            data: {
              reference,
              branchId: branchA,
              supplierId: supplier.id,
              createdByUserId: owner,
              status: 'SUBMITTED',
            },
          });
        const api = (actorId: string) =>
          pharmacyPurchasingRouter.createCaller({
            db,
            entitlements: { organizationId: org, enabledModules: ['pharmacy-procurement'] },
            session: {
              user: {
                id: actorId,
                role: actorId === owner ? 'ADMIN' : 'EMPLOYEE',
                organizationId: org,
                status: 'ACTIVE',
              },
            },
            organization: { id: org, vertical: 'PHARMACY' },
            support: null,
            requestMeta: { ip: null, userAgent: null },
          } as never);
        const solo = await createOrder('SOLO');
        const approved = await api(owner).approvePurchaseOrder({
          purchaseOrderId: solo.id,
          decision: 'APPROVED',
          pin: '493826',
        });
        if ('blocked' in approved) throw new Error('Valid solo-owner approval was blocked');
        expect(approved.status).toBe('APPROVED');
        expect(
          (
            await db.pharmacyPurchaseOrderApproval.findFirstOrThrow({
              where: { purchaseOrderId: solo.id },
            })
          ).policy
        ).toBe(SOLO_OWNER_POLICY);
        expect(
          await db.auditLog.count({
            where: { targetId: solo.id, action: 'PHARMACY:SOLO_OWNER_PIN' },
          })
        ).toBe(1);
        await db.user.update({ where: { id: cashier }, data: { status: 'ACTIVE' } });
        const multi = await createOrder('MULTI');
        await expect(
          api(owner).approvePurchaseOrder({
            purchaseOrderId: multi.id,
            decision: 'APPROVED',
            pin: '493826',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_APPROVAL' });
        expect(
          await db.pharmacyPurchaseOrderApproval.count({ where: { purchaseOrderId: multi.id } })
        ).toBe(0);
        const member = await db.user.findUniqueOrThrow({ where: { id: cashier } });
        await db.organizationRolePermission.create({
          data: {
            organizationRoleId: member.organizationRoleId!,
            capability: 'pharmacy:procurement',
            effect: 'ALLOW',
          },
        });
        await api(cashier).approvePurchaseOrder({
          purchaseOrderId: multi.id,
          decision: 'APPROVED',
        });
        expect(
          (
            await db.pharmacyPurchaseOrderApproval.findFirstOrThrow({
              where: { purchaseOrderId: multi.id },
            })
          ).actorUserId
        ).toBe(cashier);
      });
    });
    it('preserves owner-role capabilities and automatic assignments independently of the ADMIN enum', async () => {
      await inOrg(async (db) => {
        const role = await db.organizationRole.findFirstOrThrow({ where: { key: 'owner' } });
        await db.user.update({
          where: { id: owner },
          data: { role: 'EMPLOYEE', organizationRoleId: role.id },
        });
        const branch = await db.pharmacyBranch.create({
          data: {
            code: 'OWNER-ROLE',
            name: 'Owner role branch',
            addressLine: '1 Test Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        await expect(
          assertBranchAssignment(db, scope(owner, branch.id), { counter: true })
        ).resolves.toEqual(scope(owner, branch.id));
        expect(
          await db.pharmacyBranchAssignment.count({
            where: { userId: owner, branchId: branch.id, active: true },
          })
        ).toBe(1);
        for (const action of ALL_ACTIONS.filter(
          (a) =>
            a.startsWith('pharmacy:') || a === 'reports:operational' || a === 'reports:financial'
        ))
          expect(
            await can(
              { id: owner, role: 'EMPLOYEE', status: 'ACTIVE', department: null },
              action,
              undefined,
              { db }
            ),
            action
          ).toBe(true);
      });
    });
    it('revokes automatically inherited assignments when the proprietor is demoted', async () => {
      await inOrg((db) =>
        db.user.update({
          where: { id: owner },
          data: { role: 'EMPLOYEE', organizationRoleId: null },
        })
      );
      await expect(inOrg((db) => assertBranchAssignment(db, scope(owner)))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
    it('preserves manual assignments across owner promotion, reactivation and demotion', async () => {
      await inOrg(async (db) => {
        const role = await db.organizationRole.findFirstOrThrow({
          where: { key: 'owner', isSystem: true },
        });
        const promoted = `promoted_${suffix}`;
        const ordinary = `ordinary_${suffix}`;
        for (const id of [promoted, ordinary]) {
          await db.user.create({
            data: {
              id,
              name: id,
              email: `${id}@test.invalid`,
              department: 'COUNTER',
              title: 'Staff',
              status: 'ACTIVE',
            },
          });
          await db.pharmacyBranchAssignment.create({
            data: { id: `pba_${id}`, branchId: branchA, userId: id, ownerManaged: false },
          });
        }
        await db.user.update({ where: { id: promoted }, data: { organizationRoleId: role.id } });
        expect(
          await db.pharmacyBranchAssignment.findUniqueOrThrow({ where: { id: `pba_${promoted}` } })
        ).toMatchObject({ active: true, ownerManaged: false });
        await db.user.update({ where: { id: promoted }, data: { status: 'INACTIVE' } });
        expect(
          await db.pharmacyBranchAssignment.findUniqueOrThrow({ where: { id: `pba_${promoted}` } })
        ).toMatchObject({ active: true, ownerManaged: false });
        await db.user.update({ where: { id: promoted }, data: { status: 'ACTIVE' } });
        expect(
          await db.pharmacyBranchAssignment.findUniqueOrThrow({ where: { id: `pba_${promoted}` } })
        ).toMatchObject({ active: true, ownerManaged: false });
        expect(
          await db.pharmacyBranchAssignment.findFirst({
            where: { userId: promoted, branchId: branchB },
          })
        ).toMatchObject({ active: true, ownerManaged: true });
        await db.user.update({ where: { id: promoted }, data: { organizationRoleId: null } });
        expect(
          await db.pharmacyBranchAssignment.findFirst({
            where: { userId: promoted, branchId: branchB },
          })
        ).toMatchObject({ active: false, ownerManaged: true });
        expect(
          await db.pharmacyBranchAssignment.findUniqueOrThrow({ where: { id: `pba_${promoted}` } })
        ).toMatchObject({ active: true, ownerManaged: false });
        expect(
          await db.pharmacyBranchAssignment.findUniqueOrThrow({ where: { id: `pba_${ordinary}` } })
        ).toMatchObject({ active: true, ownerManaged: false });
      });
    });
  }
);
