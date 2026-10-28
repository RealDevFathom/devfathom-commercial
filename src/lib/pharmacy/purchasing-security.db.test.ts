// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';
import { assertDisposableRlsDatabase } from '../../../tests/disposable-rls-database';

vi.mock('@/lib/storage', () => ({ putUpload: vi.fn().mockResolvedValue({}) }));
import { putUpload } from '@/lib/storage';

const enabled = Boolean(process.env.DATABASE_URL && process.env.FIX469_OWNER_DATABASE_URL);
const org = `pur_security_${randomUUID().replaceAll('-', '')}`;
const id = (key: string) => `${org}_${key}`;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let purchasing: (typeof import('@/server/routers/pharmacy-purchasing'))['pharmacyPurchasingRouter'];
let supplierLinks: typeof import('./supplier-action-links');
let sequence = 0;
const unique = (key: string) => `${key}_${++sequence}`;
const pin = '1234';
const pinHash = hashSync(pin, 4);
const expiry = new Date('2035-01-01');
const now = new Date();

function context(db: ScopedDb, userId = id('owner')): TRPCContext {
  return {
    db,
    entitlements: {
      organizationId: org,
      enabledModules: ['pharmacy-procurement'],
      modules: [],
      limits: {},
      activeSeats: 2,
      seatLimit: 10,
    },
    session: {
      expires: 'later',
      user: { id: userId, organizationId: org, role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {}, db },
  } as unknown as TRPCContext;
}
const inOrg = <T>(run: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(org, run, { skipDrain: true, timeout: 60000 });
function receiptInput(approver = id('owner'), enteredPin = pin) {
  return {
    reference: unique('GRN'),
    branchId: id('branch'),
    supplierId: id('supplier'),
    supplierInvoiceRef: unique('INV'),
    supplierInvoiceDate: now,
    warrantyEvidenceRef: 'warranty',
    receivedAt: now,
    directPurchase: { reason: 'Urgent supply', approvedByUserId: approver, pin: enteredPin },
    lines: [
      {
        medicineId: id('medicine'),
        packLevelId: id('pack'),
        batchNumber: unique('batch'),
        printedExpiry: expiry,
        expiryPrecision: 'DAY' as const,
        printedMrpMinor: 100,
        canonicalUnitsPerPack: 10,
        receivedPacks: 1,
        invoicedPricePerPackMinor: 80,
        stockLocationId: id('shelf'),
      },
    ],
  };
}
async function newLink() {
  const order = await inOrg((db) =>
    db.pharmacyPurchaseOrder.create({
      data: {
        organizationId: org,
        branchId: id('branch'),
        reference: unique('PO'),
        supplierId: id('supplier'),
        createdByUserId: id('owner'),
      },
    })
  );
  return inOrg((db) =>
    supplierLinks.issueSupplierActionLink(db, {
      organizationId: org,
      branchId: id('branch'),
      relationshipId: id('relationship'),
      purchaseOrderId: order.id,
      actorUserId: id('owner'),
      expiresAt: expiry,
    })
  );
}

(enabled ? describe : describe.skip)(
  'purchasing security boundaries on restricted PostgreSQL',
  () => {
    beforeAll(async () => {
      assertDisposableRlsDatabase(process.env.DATABASE_URL!);
      assertDisposableRlsDatabase(process.env.FIX469_OWNER_DATABASE_URL!);
      vi.stubEnv('AUTH_SECRET', 'local-security-fixture-signing-key');
      const owner = new pg.Client({ connectionString: process.env.FIX469_OWNER_DATABASE_URL });
      await owner.connect();
      try {
        await owner.query("SELECT set_config('app.is_platform_admin','true',false)");
        await owner.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now())`,
          [org]
        );
      } finally {
        await owner.end();
      }
      ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
      ({ pharmacyPurchasingRouter: purchasing } =
        await import('@/server/routers/pharmacy-purchasing'));
      supplierLinks = await import('./supplier-action-links');
      await inOrg(async (db) => {
        const [role] = await db.$queryRaw<
          { rolsuper: boolean; rolbypassrls: boolean }[]
        >`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
        expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
        await db.organizationDepartment.create({
          data: { organizationId: org, key: 'Pharmacy', name: 'Pharmacy' },
        });
        await db.organizationRole.create({
          data: {
            id: id('role'),
            organizationId: org,
            key: 'owner',
            name: 'Owner',
            isSystem: true,
            permissions: { create: [{ organizationId: org, capability: '*', effect: 'ALLOW' }] },
          },
        });
        await db.organizationRole.create({
          data: {
            id: id('procurement'),
            organizationId: org,
            key: 'procurement',
            name: 'Procurement',
            permissions: {
              create: [
                { organizationId: org, capability: 'pharmacy:procurement', effect: 'ALLOW' },
              ],
            },
          },
        });
        await db.user.create({
          data: {
            id: id('owner'),
            organizationId: org,
            organizationRoleId: id('role'),
            role: 'ADMIN',
            name: 'Owner',
            email: `${org}@test.invalid`,
            department: 'Pharmacy',
            title: 'Owner',
          },
        });
        await db.restaurantStaffProfile.create({
          data: {
            id: id('staff'),
            organizationId: org,
            userId: id('owner'),
            displayName: 'Owner',
            credentials: {
              create: {
                id: id('credential'),
                organizationId: org,
                type: 'PIN',
                credentialHash: pinHash,
              },
            },
          },
        });
        for (const key of ['branch', 'other'])
          await db.pharmacyBranch.create({
            data: {
              id: id(key),
              organizationId: org,
              code: key,
              name: key,
              addressLine: '1 Test Road',
              city: 'Lahore',
              provinceCode: 'PB',
            },
          });
        await db.pharmacyStockLocation.create({
          data: {
            id: id('shelf'),
            organizationId: org,
            branchId: id('branch'),
            code: 'MAIN',
            name: 'Shelf',
            kind: 'STORE',
          },
        });
        await db.medicine.create({
          data: {
            id: id('medicine'),
            organizationId: org,
            saleable: true,
            productName: 'Security fixture medicine',
            productFamily: 'PHARMACEUTICAL',
            presentations: {
              create: {
                id: id('presentation'),
                organizationId: org,
                presentation: 'Tablet',
                packLevels: {
                  create: {
                    id: id('pack'),
                    organizationId: org,
                    versionGroupId: id('pack'),
                    version: 1,
                    level: 'STRIP',
                    unitsPerParent: 10,
                    effectiveFrom: new Date('2020-01-01'),
                  },
                },
              },
            },
          },
        });
        await db.pharmacySupplier.create({
          data: {
            id: id('supplier'),
            organizationId: org,
            name: 'Supplier',
            authorized: true,
            licences: {
              create: {
                licenceType: 'WHOLESALE',
                licenceNumber: 'TEST',
                issuingAuthority: 'Test',
                issuedAt: new Date('2020-01-01'),
                expiresAt: expiry,
                verifiedAt: now,
              },
            },
          },
        });
        await db.pharmacySupplierRelationship.create({
          data: {
            id: id('relationship'),
            organizationId: org,
            branchId: id('branch'),
            supplierId: id('supplier'),
          },
        });
      });
    }, 60000);

    it('gives the live owner every capability and every active tenant branch without assignments', async () => {
      const { can } = await import('@/lib/abac');
      const { ALL_ACTIONS } = await import('@/lib/abac/policies');
      const { assignedRegisterBranchIds } = await import('./controlled-register');
      const { actorCanProcure, actorCanReadPurchasing } = await import('./procurement-access');
      const { assertProcurementBranch } = await import('@/server/pharmacy-procurement-access');
      await inOrg(async (db) => {
        // No explicit assignment is needed, including branches created after the owner.
        await db.pharmacyBranchAssignment.deleteMany({ where: { userId: id('owner') } });
        await db.userPermissionOverride.create({
          data: {
            organizationId: org,
            userId: id('owner'),
            capability: '*',
            effect: 'DENY',
            reason: 'Owner authority regression fixture',
          },
        });
        try {
          for (const action of ALL_ACTIONS) {
            expect(
              await can(
                { id: id('owner'), role: 'ADMIN', status: 'ACTIVE', department: 'Pharmacy' },
                action,
                undefined,
                { db }
              )
            ).toBe(true);
          }
          await db.pharmacyBranch.create({
            data: {
              id: id('newBranch'),
              organizationId: org,
              code: 'newBranch',
              name: 'New branch',
              addressLine: '1 Test Road',
              city: 'Lahore',
              provinceCode: 'PB',
            },
          });
          await expect(
            assertProcurementBranch(context(db), id('newBranch'))
          ).resolves.toMatchObject({ branchId: id('newBranch') });
          await db.pharmacyBranch.update({
            where: { id: id('newBranch') },
            data: { active: false },
          });
          await expect(assertProcurementBranch(context(db), id('newBranch'))).rejects.toMatchObject(
            { code: 'FORBIDDEN' }
          );
          expect(await actorCanProcure(db, id('owner'))).toBe(true);
          expect(await actorCanReadPurchasing(db, id('owner'))).toBe(true);
          expect(await assignedRegisterBranchIds(db, org, id('owner'))).toEqual(
            expect.arrayContaining([id('branch'), id('other')])
          );
          await expect(assertProcurementBranch(context(db), id('branch'))).resolves.toMatchObject({
            branchId: id('branch'),
          });
          await expect(
            assertProcurementBranch(context(db), 'outside-tenant')
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        } finally {
          await db.userPermissionOverride.deleteMany({
            where: { userId: id('owner'), reason: 'Owner authority regression fixture' },
          });
        }
      });
    });

    it('PIN reauthenticates a solo owner for both PO and direct receipt with durable audit evidence', async () => {
      await inOrg(async (db) => {
        const ctx = context(db);
        const caller = purchasing.createCaller(ctx);
        const po = await caller.createPurchaseOrder({
          reference: unique('SOLO'),
          branchId: id('branch'),
          supplierId: id('supplier'),
          lines: [
            {
              medicineId: id('medicine'),
              packLevelId: id('pack'),
              orderedPacks: 1,
              canonicalUnitsPerPack: 10,
              listPricePerPackMinor: 80,
            },
          ],
        });
        await caller.submitPurchaseOrder({ purchaseOrderId: po.id });
        expect(
          await caller.approvePurchaseOrder({ purchaseOrderId: po.id, decision: 'APPROVED' })
        ).toHaveProperty('blocked');
        expect(
          await caller.approvePurchaseOrder({ purchaseOrderId: po.id, decision: 'APPROVED', pin })
        ).toMatchObject({ status: 'APPROVED', approvedByUserId: id('owner') });
        const approvalAudit = await db.auditLog.findFirst({
          where: { organizationId: org, action: 'pharmacy.purchaseOrderApproval', targetId: po.id },
        });
        expect(approvalAudit).toMatchObject({
          actorId: id('owner'),
          metadata: {
            policy: 'PHARMACY_SOLO_OWNER_PIN',
            pinVerified: true,
            decision: 'APPROVED',
          },
        });
        expect(
          await db.pharmacyPurchaseOrderApproval.findMany({ where: { purchaseOrderId: po.id } })
        ).toHaveLength(1);
        const result = await caller.createGoodsReceipt(receiptInput());
        expect(result).toMatchObject({
          directPurchase: true,
          receivedByUserId: id('owner'),
          bypassApprovedByUserId: id('owner'),
        });
        const logs = await db.auditLog.findMany({
          where: { organizationId: org, path: 'createGoodsReceipt' },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].input).toBe('[skipped]');
        expect(logs[0].metadata).toMatchObject({ policy: 'PHARMACY_SOLO_OWNER_PIN' });
        // The audit redactor also hides pinVerified; the receipt and approval event
        // retain the actual actor and named policy, never a substituted identity.
        expect(ctx.audit.detail.metadata?.pinVerified).toBe(true);
      });
    });

    it('commits strikes on denied PINs and serializes concurrent guesses', async () => {
      await inOrg((db) =>
        db.restaurantOperatorCredential.update({
          where: { id: id('credential') },
          data: { failedAttempts: 0, lockedUntil: null },
        })
      );
      const attempts = await Promise.all(
        Array.from({ length: 7 }, () =>
          inOrg((db) =>
            purchasing
              .createCaller(context(db))
              .createGoodsReceipt(receiptInput(id('owner'), '9999'))
          )
        )
      );
      expect(attempts.every((result) => 'blocked' in result)).toBe(true);
      await inOrg(async (db) => {
        const credential = await db.restaurantOperatorCredential.findUniqueOrThrow({
          where: { id: id('credential') },
        });
        expect(credential.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
        expect(credential.failedAttempts).toBe(0);
        await db.restaurantOperatorCredential.update({
          where: { id: id('credential') },
          data: { failedAttempts: 0, lockedUntil: null },
        });
      });
    });

    it('requires second approval with another active staff member; checks credential and branch, not ID', async () => {
      await inOrg(async (db) => {
        await db.user.create({
          data: {
            id: id('second'),
            organizationId: org,
            organizationRoleId: id('procurement'),
            name: 'Second',
            email: `${org}_second@test.invalid`,
            department: 'Pharmacy',
            title: 'Buyer',
          },
        });
        await db.pharmacyBranchAssignment.create({
          data: {
            organizationId: org,
            branchId: id('branch'),
            userId: id('second'),
          },
        });
        await db.restaurantStaffProfile.create({
          data: {
            id: id('secondStaff'),
            organizationId: org,
            userId: id('second'),
            displayName: 'Second',
            credentials: { create: { organizationId: org, type: 'PIN', credentialHash: pinHash } },
          },
        });
      });
      await inOrg(async (db) => {
        await db.user.create({
          data: {
            id: id('clinical'),
            organizationId: org,
            name: 'Qualified pharmacist',
            email: `${org}_clinical@test.invalid`,
            department: 'Pharmacy',
            title: 'Pharmacist',
          },
        });
        await db.userPermissionOverride.create({
          data: {
            organizationId: org,
            userId: id('clinical'),
            capability: 'pharmacy:dispense',
            effect: 'ALLOW',
            reason: 'Qualified pharmacist fixture',
          },
        });
        await db.pharmacyBranchAssignment.create({
          data: { organizationId: org, branchId: id('other'), userId: id('clinical') },
        });
        await db.restaurantStaffProfile.create({
          data: {
            organizationId: org,
            userId: id('clinical'),
            displayName: 'Qualified pharmacist',
            credentials: { create: { organizationId: org, type: 'PIN', credentialHash: pinHash } },
          },
        });
        const { purchasingWorkspace } = await import('./purchasing-console');
        const workspace = await purchasingWorkspace(db, {
          organizationId: org,
          actorId: id('owner'),
        });
        expect(workspace.approvers.map((person) => person.id)).toContain(id('clinical'));
        expect(workspace.approvers.map((person) => person.id)).not.toContain(id('second'));
        expect(workspace.procurementApprovers.map((person) => person.id)).toContain(id('second'));
        expect(workspace.procurementApprovers.map((person) => person.id)).not.toContain(
          id('clinical')
        );
      });
      await expect(
        inOrg((db) => purchasing.createCaller(context(db)).createGoodsReceipt(receiptInput()))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await inOrg(async (db) => {
        const order = await db.pharmacyPurchaseOrder.create({
          data: {
            organizationId: org,
            reference: unique('MULTI'),
            branchId: id('branch'),
            supplierId: id('supplier'),
            createdByUserId: id('owner'),
            status: 'SUBMITTED',
          },
        });
        await expect(
          purchasing.createCaller(context(db)).approvePurchaseOrder({
            purchaseOrderId: order.id,
            decision: 'APPROVED',
            pin,
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(
          await db.pharmacyPurchaseOrderApproval.count({ where: { purchaseOrderId: order.id } })
        ).toBe(0);
        expect(
          await purchasing.createCaller(context(db, id('second'))).approvePurchaseOrder({
            purchaseOrderId: order.id,
            decision: 'APPROVED',
          })
        ).toMatchObject({ approvedByUserId: id('second'), status: 'APPROVED' });
      });
      await inOrg(async (db) => {
        expect(
          await purchasing.createCaller(context(db)).createGoodsReceipt(receiptInput(id('second')))
        ).toMatchObject({ bypassApprovedByUserId: id('second') });
        expect(
          await purchasing
            .createCaller(context(db))
            .createGoodsReceipt(receiptInput(id('second'), '9999'))
        ).toHaveProperty('blocked');
      });
      await expect(
        inOrg((db) =>
          purchasing
            .createCaller(context(db, id('second')))
            .goodsReceipts({ branchId: id('other') })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await inOrg(async (db) => {
        // A pre-remediation draft has an approver ID but no durable PIN proof.
        const legacy = await db.pharmacyGoodsReceipt.create({
          data: {
            organizationId: org,
            branchId: id('branch'),
            supplierId: id('supplier'),
            reference: unique('LEGACY'),
            supplierInvoiceRef: unique('INV'),
            supplierInvoiceDate: now,
            warrantyEvidenceRef: 'warranty',
            receivedAt: now,
            receivedByUserId: id('owner'),
            directPurchase: true,
            bypassReason: 'Historical approval',
            bypassApprovedByUserId: id('second'),
            bypassApprovedAt: now,
            lines: {
              create: [
                {
                  lineNumber: 1,
                  medicineId: id('medicine'),
                  packLevelId: id('pack'),
                  batchNumber: unique('legacyBatch'),
                  printedExpiry: expiry,
                  expiryPrecision: 'DAY',
                  printedMrpMinor: 100,
                  canonicalUnitsPerPack: 10,
                  receivedPacks: 1,
                  bonusPacks: 0,
                  receivedCanonicalUnits: 10,
                  bonusCanonicalUnits: 0,
                  acceptedCanonicalUnits: 10,
                  rejectedCanonicalUnits: 0,
                  invoicedPricePerPackMinor: 80,
                  unitCostMinor: 8,
                  stockLocationId: id('shelf'),
                },
              ],
            },
          },
        });
        const caller = purchasing.createCaller(context(db));
        expect(
          await caller.postGoodsReceipt({ branchId: id('branch'), goodsReceiptId: legacy.id })
        ).toHaveProperty('blocked');
        expect(
          await caller.postGoodsReceipt({
            branchId: id('branch'),
            goodsReceiptId: legacy.id,
            approvalPin: '9999',
          })
        ).toHaveProperty('blocked');
        expect(
          await db.pharmacyGoodsReceipt.findUniqueOrThrow({ where: { id: legacy.id } })
        ).toMatchObject({ status: 'DRAFT' });
        expect(
          await caller.postGoodsReceipt({
            branchId: id('branch'),
            goodsReceiptId: legacy.id,
            approvalPin: pin,
          })
        ).toHaveProperty('postedAt');
        expect(
          await db.auditLog.count({
            where: {
              organizationId: org,
              action: 'pharmacy.directPurchaseApproval',
              targetId: legacy.id,
            },
          })
        ).toBe(1);
      });
      await inOrg((db) =>
        db.userPermissionOverride.create({
          data: {
            organizationId: org,
            userId: id('second'),
            capability: 'pharmacy:procurement',
            effect: 'DENY',
            reason: 'Test revocation',
          },
        })
      );
      await inOrg(async (db) => {
        expect(
          await purchasing.createCaller(context(db)).createGoodsReceipt(receiptInput(id('second')))
        ).toHaveProperty('blocked');
      });
      await expect(
        inOrg((db) => purchasing.createCaller(context(db, id('second'))).purchaseOrders())
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('lets a branch-solo owner approve when the other staff works at another branch', async () => {
      await inOrg(async (db) => {
        await db.pharmacyBranchAssignment.updateMany({
          where: { userId: id('second') },
          data: { branchId: id('other') },
        });
      });
      await inOrg(async (db) => {
        expect(
          await purchasing.createCaller(context(db)).createGoodsReceipt(receiptInput())
        ).toMatchObject({ bypassApprovedByUserId: id('owner') });
      });
    });

    it('counts an all-capability ADMIN override as a second person at every branch', async () => {
      await inOrg(async (db) => {
        await db.user.create({
          data: {
            id: id('adminOverride'),
            organizationId: org,
            role: 'ADMIN',
            name: 'Administrator',
            email: `${org}_admin@test.invalid`,
            department: 'Pharmacy',
            title: 'Administrator',
          },
        });
        await db.userPermissionOverride.create({
          data: {
            organizationId: org,
            userId: id('adminOverride'),
            capability: '*',
            effect: 'ALLOW',
            reason: 'Administrator fixture',
          },
        });
        await db.$queryRaw`SELECT set_config('app.pharmacy_purchase_pin_verified_user_id', ${id('owner')}, true)`;
        const [decision] = await db.$queryRaw<
          { allowed: boolean }[]
        >`SELECT pharmacy_solo_purchase_owner(${org}, ${id('owner')}, ${id('branch')}) AS allowed`;
        expect(decision.allowed).toBe(false);
      });
      await expect(
        inOrg((db) => purchasing.createCaller(context(db)).createGoodsReceipt(receiptInput()))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await inOrg((db) =>
        db.user.update({ where: { id: id('adminOverride') }, data: { status: 'INACTIVE' } })
      );
    });

    it('preserves a valid solo approval through sending, posting, and later staffing changes', async () => {
      const receipt = await inOrg((db) =>
        purchasing.createCaller(context(db)).createGoodsReceipt(receiptInput())
      );
      if ('blocked' in receipt) throw new Error('Solo receipt was refused');
      await inOrg((db) =>
        db.pharmacyBranchAssignment.updateMany({
          where: { userId: id('second') },
          data: { branchId: id('branch') },
        })
      );
      await inOrg(async (db) => {
        const result = await purchasing
          .createCaller(context(db))
          .postGoodsReceipt({ branchId: id('branch'), goodsReceiptId: receipt.id });
        expect(result).toHaveProperty('postedAt');
        const po = await db.pharmacyPurchaseOrder.findFirstOrThrow({
          where: { approvedByUserId: id('owner'), status: 'APPROVED' },
        });
        expect(
          await purchasing.createCaller(context(db)).sendPurchaseOrder({ purchaseOrderId: po.id })
        ).toMatchObject({ status: 'SENT' });
      });
    });

    it('serializes per-link submission quotas across independent transactions and preserves idempotent replay', async () => {
      const { token } = await newLink();
      const linkId = supplierLinks.supplierLinkId(token)!;
      await inOrg((db) =>
        db.pharmacySupplierSubmission.createMany({
          data: Array.from(
            { length: supplierLinks.SUPPLIER_LINK_LIMITS.submissions - 1 },
            (_, i) => ({
              id: `old-${linkId}-${i}`,
              organizationId: org,
              branchId: id('branch'),
              actionLinkId: linkId,
              versionGroupId: `old-${linkId}-${i}`,
              version: 1,
              kind: 'ACKNOWLEDGEMENT' as const,
              source: 'SIGNED_LINK' as const,
              idempotencyKey: `old-${i}`,
              payload: {},
            })
          ),
        })
      );
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) =>
          inOrg((db) =>
            supplierLinks.submitSupplierEvidence(db, {
              token,
              kind: 'ACKNOWLEDGEMENT',
              idempotencyKey: `race-${i}`,
              payload: {},
            })
          )
        )
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ reason: 'LINK_LIMIT_EXCEEDED' });
      const winner = results.find((r) => r.status === 'fulfilled')!;
      if (winner.status !== 'fulfilled') throw new Error('No winning request');
      await inOrg(async (db) => {
        expect(await db.pharmacySupplierSubmission.count({ where: { actionLinkId: linkId } })).toBe(
          supplierLinks.SUPPLIER_LINK_LIMITS.submissions
        );
        expect(
          await supplierLinks.submitSupplierEvidence(db, {
            token,
            kind: 'ACKNOWLEDGEMENT',
            idempotencyKey: winner.value.idempotencyKey,
            payload: {},
          })
        ).toMatchObject({ id: winner.value.id });
      });
    });

    it('serializes document byte reservations across independent transactions before storage writes', async () => {
      const { token } = await newLink();
      const linkId = supplierLinks.supplierLinkId(token)!;
      await inOrg((db) =>
        db.pharmacySupplierSubmission.create({
          data: {
            id: `existing-${linkId}`,
            organizationId: org,
            branchId: id('branch'),
            actionLinkId: linkId,
            versionGroupId: `existing-${linkId}`,
            version: 1,
            kind: 'DOCUMENT',
            source: 'SIGNED_LINK',
            idempotencyKey: 'existing',
            payload: { byteSize: supplierLinks.SUPPLIER_LINK_LIMITS.documentBytes - 8 },
          },
        })
      );
      vi.mocked(putUpload).mockClear();
      const input = {
        token,
        fileName: 'invoice.pdf',
        declaredMimeType: 'application/pdf',
        content: Buffer.from('%PDF-1.7'),
      };
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, (_, i) =>
          inOrg((db) =>
            supplierLinks.uploadSupplierDocument(db, { ...input, idempotencyKey: `doc-${i}` })
          )
        )
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ reason: 'LINK_LIMIT_EXCEEDED' });
      expect(putUpload).toHaveBeenCalledTimes(1);
      const winner = results.find((result) => result.status === 'fulfilled');
      if (!winner || winner.status !== 'fulfilled') throw new Error('No successful upload');
      await inOrg(async (db) => {
        const submission = await db.pharmacySupplierSubmission.findUniqueOrThrow({
          where: { id: winner.value.submissionId },
        });
        expect(
          await supplierLinks.uploadSupplierDocument(db, {
            ...input,
            idempotencyKey: submission.idempotencyKey.slice('document:'.length),
          })
        ).toMatchObject({ id: winner.value.id });
      });
      expect(putUpload).toHaveBeenCalledTimes(1);
    });
  }
);
