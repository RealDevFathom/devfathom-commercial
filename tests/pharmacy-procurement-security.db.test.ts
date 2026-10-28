// @vitest-environment node
import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { can } from '@/lib/abac';
import { EXACT_GRANT_ONLY_ACTIONS } from '@/lib/abac/capabilities';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';
import { organizationAdminRouter } from '@/server/routers/organization-admin';
import { ALL_ACTIONS } from '@/lib/abac/policies';
import { requireProcurementBranch } from '@/lib/pharmacy/procurement-authorization';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { pharmacyPurchasingRouter } from '@/server/routers/pharmacy-purchasing';
import { pharmacySupplierLinksRouter } from '@/server/routers/pharmacy-supplier-links';
import { toAuditJson } from '@/server/audit';
import type { TRPCContext } from '@/server/trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.SECURITY_TEST_OWNER_DATABASE_URL;
const org = `sec_h3_${randomUUID().replaceAll('-', '')}`;
const rollback = new Error('rollback test fixtures');
let pinHash: string;
const pin = '482916';

async function fixture(run: (tx: ScopedDb, ctx: TRPCContext) => Promise<void>) {
  await expect(
    withTenantDb(
      org,
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES (${org},${org},${org},${org},'ACTIVE','SHARED','PHARMACY',now(),now())`;
        await tx.$queryRaw`SELECT set_config('app.is_platform_admin', 'false', true)`;
        await tx.organizationDepartment.create({ data: { key: 'PHARMACY', name: 'PHARMACY' } });
        const role = await tx.organizationRole.create({
          data: { key: 'owner', name: 'Owner', isSystem: true },
        });
        await tx.organizationRolePermission.createMany({
          data: roleTemplatesForVertical('PHARMACY')
            .find((r) => r.key === 'owner-operator')!
            .capabilities.map((capability) => ({
              organizationRoleId: role.id,
              capability,
              effect: 'ALLOW' as const,
            })),
        });
        await tx.pharmacyBranch.create({
          data: {
            id: `${org}_branch`,
            code: 'A',
            name: 'A',
            addressLine: 'Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        const user = await tx.user.create({
          data: {
            id: `${org}_owner`,
            name: 'Owner',
            email: `${org}@example.test`,
            department: 'PHARMACY',
            title: 'Owner',
            organizationRoleId: role.id,
          },
        });
        const profile = await tx.restaurantStaffProfile.create({
          data: { userId: user.id, displayName: 'Owner' },
        });
        await tx.restaurantOperatorCredential.create({
          data: { staffProfileId: profile.id, type: 'PIN', credentialHash: pinHash },
        });
        const supplier = await tx.pharmacySupplier.create({
          data: { name: 'Supplier', authorized: true },
        });
        await tx.pharmacySupplierLicence.create({
          data: {
            supplierId: supplier.id,
            licenceType: 'Wholesale',
            licenceNumber: 'TEST',
            issuingAuthority: 'Test',
            issuedAt: new Date('2020-01-01'),
            expiresAt: new Date('2035-01-01'),
            verifiedAt: new Date(),
          },
        });
        await tx.pharmacyPurchaseOrder.create({
          data: {
            id: `${org}_order`,
            reference: 'PO',
            branchId: `${org}_branch`,
            supplierId: supplier.id,
            createdByUserId: user.id,
            status: 'SUBMITTED',
          },
        });
        const ctx = {
          db: tx,
          entitlements: {
            organizationId: org,
            enabledModules: ['pharmacy-procurement'],
            modules: [],
          },
          session: {
            expires: '2099-01-01',
            user: { id: user.id, organizationId: org, status: 'ACTIVE', role: 'EMPLOYEE' },
          },
          organization: null,
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {}, db: tx },
        } as unknown as TRPCContext;
        await run(tx, ctx);
        throw rollback;
      },
      { timeout: 60_000, skipDrain: true }
    )
  ).rejects.toBe(rollback);
}

// This suite requires a local migrated database and a separate migrator connection.
describe.skipIf(!url || !ownerUrl)('procurement authorization with real PostgreSQL', () => {
  beforeAll(async () => {
    for (const value of [url!, ownerUrl!])
      expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(value).hostname);
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(
        readFileSync(
          'prisma/migrations/20261028120000_pharmacy_owner_branch_security/migration.sql',
          'utf8'
        )
      );
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    pinHash = await hashOperatorCredential('PIN', pin);
    const [role] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  afterAll(async () => db.$disconnect());
  beforeEach(async () => clearRateLimit(`pharmacy:solo-owner-pin:${org}:${org}_owner`));

  it('grants owner capabilities and requires exact sensitive grants for admins; assigns current and future branches', async () =>
    fixture(async (tx, ctx) => {
      const actorId = ctx.session!.user.id;
      for (const action of ALL_ACTIONS)
        expect(
          await can(
            { id: actorId, role: 'EMPLOYEE', status: 'ACTIVE', department: 'PHARMACY' },
            action,
            undefined,
            { db: tx }
          )
        ).toBe(true);
      expect(
        await tx.pharmacyBranchAssignment.count({ where: { userId: actorId, active: true } })
      ).toBe(1);
      await tx.pharmacyBranch.create({
        data: {
          id: `${org}_second`,
          code: 'B',
          name: 'B',
          addressLine: 'Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      expect(
        await tx.pharmacyBranchAssignment.count({ where: { userId: actorId, active: true } })
      ).toBe(2);
      await requireProcurementBranch(tx, org, actorId, `${org}_second`);
      await tx.user.update({
        where: { id: actorId },
        data: { role: 'ADMIN', organizationRoleId: null },
      });
      for (const action of ALL_ACTIONS)
        expect(
          await can(
            { id: actorId, role: 'ADMIN', status: 'ACTIVE', department: 'PHARMACY' },
            action,
            undefined,
            { db: tx }
          )
        ).toBe(!EXACT_GRANT_ONLY_ACTIONS.has(action));
      await requireProcurementBranch(tx, org, actorId, `${org}_branch`);
    }));

  it('revokes automatic owner branches on demotion through updateMember', async () =>
    fixture(async (tx, ctx) => {
      const actorId = ctx.session!.user.id;
      // A separate administrator performs the demotion.
      await tx.user.create({
        data: {
          id: `${org}_admin`,
          name: 'Admin',
          email: `${org}_admin@example.test`,
          role: 'ADMIN',
          department: 'PHARMACY',
          title: 'Admin',
        },
      });
      ctx.session!.user.id = `${org}_admin`;
      ctx.session!.user.role = 'ADMIN';
      await organizationAdminRouter.createCaller(ctx).updateMember({
        id: actorId,
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationRoleId: null,
        title: 'Buyer',
        department: 'PHARMACY',
      });
      expect(
        await tx.pharmacyBranchAssignment.count({ where: { userId: actorId, active: true } })
      ).toBe(0);
      await expect(
        requireProcurementBranch(tx, org, actorId, `${org}_branch`)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));

  it.each(['ADMIN', 'EMPLOYEE'] as const)(
    'creates a %s owner with explicit branch selections without duplicate assignments',
    async (role) =>
      fixture(async (tx, ctx) => {
        await tx.user.update({ where: { id: ctx.session!.user.id }, data: { role: 'ADMIN' } });
        ctx.session!.user.role = 'ADMIN';
        ctx.entitlements.seatLimit = 10;
        const ownerRole = await tx.organizationRole.findFirstOrThrow({ where: { key: 'owner' } });
        const member = await organizationAdminRouter.createCaller(ctx).createMember({
          name: 'New owner',
          email: `${org}_new@example.test`,
          password: 'Temporary-123456',
          title: 'Owner',
          role,
          department: 'PHARMACY',
          organizationRoleId: ownerRole.id,
          branchIds: [`${org}_branch`],
        });
        expect(
          await tx.pharmacyBranchAssignment.count({ where: { userId: member.id, active: true } })
        ).toBe(1);
      })
  );

  it('allows sole owner self approval with a fresh PIN and atomically records audit and policy', async () =>
    fixture(async (tx, ctx) => {
      const result = await pharmacyPurchasingRouter
        .createCaller(ctx)
        .approvePurchaseOrder({ purchaseOrderId: `${org}_order`, decision: 'APPROVED', pin });
      expect(result.status).toBe('APPROVED');
      const approval = await tx.pharmacyPurchaseOrderApproval.findFirstOrThrow({
        where: { purchaseOrderId: result.id },
      });
      expect(approval.policy).toBe('PUR-02:SOLO_OWNER_PIN');
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'pharmacyPurchasing.soloOwnerApproval', targetId: result.id },
      });
      expect(audit.actorId).toBe(ctx.session!.user.id);
      expect(audit.metadata).toMatchObject({ activeStaffCount: 1, branchId: `${org}_branch` });
      expect(JSON.stringify(audit)).not.toContain(pin);
    }));

  it.each([
    { label: 'missing', value: undefined },
    { label: 'incorrect', value: '999999' },
  ])('refuses sole owner approval without a valid PIN ($label)', async ({ value: invalidPin }) =>
    fixture(async (tx, ctx) => {
      await expect(
        pharmacyPurchasingRouter.createCaller(ctx).approvePurchaseOrder({
          purchaseOrderId: `${org}_order`,
          decision: 'APPROVED',
          pin: invalidPin,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await tx.pharmacyPurchaseOrderApproval.count()).toBe(0);
      expect(
        await tx.auditLog.count({ where: { action: 'pharmacyPurchasing.soloOwnerApproval' } })
      ).toBe(0);
      expect((await tx.pharmacyPurchaseOrder.findFirstOrThrow()).status).toBe('SUBMITTED');
    })
  );

  it.each(['assigned', 'unassigned'] as const)(
    'requires a different approver for a second %s active staff member, even with a valid owner PIN',
    async (assignment) =>
      fixture(async (tx, ctx) => {
        const role = await tx.organizationRole.create({
          data: {
            key: 'buyer',
            name: 'Buyer',
            permissions: { create: { capability: 'pharmacy:procurement', effect: 'ALLOW' } },
          },
        });
        const second = await tx.user.create({
          data: {
            name: 'Second',
            email: `second_${org}@example.test`,
            department: 'PHARMACY',
            title: 'Buyer',
            organizationRoleId: role.id,
          },
        });
        if (assignment === 'assigned')
          await tx.pharmacyBranchAssignment.create({
            data: { userId: second.id, branchId: `${org}_branch` },
          });
        await expect(
          pharmacyPurchasingRouter
            .createCaller(ctx)
            .approvePurchaseOrder({ purchaseOrderId: `${org}_order`, decision: 'APPROVED', pin })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(await tx.pharmacyPurchaseOrderApproval.count()).toBe(0);
        if (assignment === 'unassigned')
          await tx.pharmacyBranchAssignment.create({
            data: { userId: second.id, branchId: `${org}_branch` },
          });
        const secondCtx = {
          ...ctx,
          session: { ...ctx.session!, user: { ...ctx.session!.user, id: second.id } },
        };
        const result = await pharmacyPurchasingRouter
          .createCaller(secondCtx)
          .approvePurchaseOrder({ purchaseOrderId: `${org}_order`, decision: 'APPROVED' });
        expect(result.approvedByUserId).toBe(second.id);
        expect((await tx.pharmacyPurchaseOrderApproval.findFirstOrThrow()).policy).toBe(
          'PUR-02:SEGREGATION_OF_DUTIES'
        );
        expect(
          await tx.auditLog.count({ where: { action: 'pharmacyPurchasing.soloOwnerApproval' } })
        ).toBe(0);
      })
  );

  it('denies cashier procurement and sibling branch access for both routers before writes', async () =>
    fixture(async (tx, ctx) => {
      await tx.user.update({
        where: { id: ctx.session!.user.id },
        data: { organizationRoleId: null },
      });
      const purchasing = pharmacyPurchasingRouter.createCaller(ctx);
      await expect(purchasing.createSupplier({ name: 'Forbidden' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        purchasing.approvePurchaseOrder({
          purchaseOrderId: `${org}_order`,
          decision: 'APPROVED',
          pin,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        purchasing.reverseGoodsReceipt({
          branchId: `${org}_branch`,
          goodsReceiptId: 'missing',
          reason: 'Wrong',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        pharmacySupplierLinksRouter
          .createCaller(ctx)
          .createRelationship({ branchId: `${org}_branch`, supplierId: 'missing' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const role = await tx.organizationRole.create({
        data: {
          key: 'procurement',
          name: 'Procurement',
          permissions: { create: { capability: 'pharmacy:procurement', effect: 'ALLOW' } },
        },
      });
      await tx.user.update({
        where: { id: ctx.session!.user.id },
        data: { organizationRoleId: role.id },
      });
      await tx.pharmacyBranchAssignment.updateMany({
        where: { userId: ctx.session!.user.id },
        data: { active: false },
      });
      await expect(
        purchasing.approvePurchaseOrder({
          purchaseOrderId: `${org}_order`,
          decision: 'APPROVED',
          pin,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        pharmacySupplierLinksRouter
          .createCaller(ctx)
          .createRelationship({ branchId: `${org}_branch`, supplierId: 'missing' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await tx.pharmacySupplierRelationship.count()).toBe(0);
    }));

  it('allows a sole branch owner when other active staff are assigned exclusively elsewhere', async () =>
    fixture(async (tx, ctx) => {
      const branch = await tx.pharmacyBranch.create({
        data: {
          code: 'OTHER',
          name: 'Other branch',
          addressLine: 'Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      const other = await tx.user.create({
        data: {
          name: 'Other branch staff',
          email: `elsewhere_${org}@example.test`,
          department: 'PHARMACY',
          title: 'Staff',
        },
      });
      await tx.pharmacyBranchAssignment.create({ data: { userId: other.id, branchId: branch.id } });
      const result = await pharmacyPurchasingRouter
        .createCaller(ctx)
        .approvePurchaseOrder({ purchaseOrderId: `${org}_order`, decision: 'APPROVED', pin });
      expect(result.status).toBe('APPROVED');
      expect(
        await tx.auditLog.count({
          where: { action: 'pharmacyPurchasing.soloOwnerApproval', targetId: result.id },
        })
      ).toBe(1);
    }));

  it('refuses a direct creator self-approval write without same-transaction PIN audit evidence', async () =>
    fixture(async (tx) => {
      await tx.$executeRawUnsafe('SAVEPOINT no_pin_evidence');
      await expect(
        tx.$executeRaw`UPDATE pharmacy_purchase_orders SET status='APPROVED', "approvedByUserId"=${`${org}_owner`}, "approvedAt"=now() WHERE id=${`${org}_order`}`
      ).rejects.toThrow(/SELF_APPROVAL/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT no_pin_evidence');
      expect((await tx.pharmacyPurchaseOrder.findFirstOrThrow()).status).toBe('SUBMITTED');
    }));

  it('honors explicit capability revocation for the owner and refuses foreign branch scope', async () =>
    fixture(async (tx, ctx) => {
      await expect(
        requireProcurementBranch(tx, org, ctx.session!.user.id, 'foreign_branch')
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await tx.userPermissionOverride.create({
        data: {
          userId: ctx.session!.user.id,
          capability: 'pharmacy:procurement',
          effect: 'DENY',
          reason: 'Revoked',
        },
      });
      expect(
        await can(
          { id: ctx.session!.user.id, role: 'EMPLOYEE', status: 'ACTIVE', department: 'PHARMACY' },
          'pharmacy:procurement',
          undefined,
          { db: tx }
        )
      ).toBe(false);
      await expect(
        pharmacyPurchasingRouter.createCaller(ctx).createSupplier({ name: 'Denied' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));

  it.each(['revoked', 'locked'] as const)(
    'refuses a %s PIN without approval or solo audit',
    async (state) =>
      fixture(async (tx, ctx) => {
        await tx.restaurantOperatorCredential.updateMany({
          data:
            state === 'revoked'
              ? { revokedAt: new Date() }
              : { lockedUntil: new Date(Date.now() + 60_000) },
        });
        await expect(
          pharmacyPurchasingRouter
            .createCaller(ctx)
            .approvePurchaseOrder({ purchaseOrderId: `${org}_order`, decision: 'APPROVED', pin })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(await tx.pharmacyPurchaseOrderApproval.count()).toBe(0);
        expect(
          await tx.auditLog.count({ where: { action: 'pharmacyPurchasing.soloOwnerApproval' } })
        ).toBe(0);
      })
  );

  it('denies PIN retries after the shared attempt limit, including a correct PIN', async () =>
    fixture(async (tx, ctx) => {
      const api = pharmacyPurchasingRouter.createCaller(ctx);
      for (let attempt = 0; attempt < 5; attempt++)
        await expect(
          api.approvePurchaseOrder({
            purchaseOrderId: `${org}_order`,
            decision: 'APPROVED',
            pin: '999999',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.approvePurchaseOrder({ purchaseOrderId: `${org}_order`, decision: 'APPROVED', pin })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await tx.pharmacyPurchaseOrderApproval.count()).toBe(0);
    }));

  it('clears the shared failed-attempt budget after successful PIN reauthentication', async () =>
    fixture(async (_tx, ctx) => {
      const key = `pharmacy:solo-owner-pin:${org}:${org}_owner`;
      for (let attempt = 0; attempt < 4; attempt++) await rateLimit(key, 5, 15 * 60 * 1000);
      await pharmacyPurchasingRouter
        .createCaller(ctx)
        .approvePurchaseOrder({ purchaseOrderId: `${org}_order`, decision: 'APPROVED', pin });
      expect((await rateLimit(key, 5, 15 * 60 * 1000)).remaining).toBe(4);
    }));

  it('redacts PINs even in denied or invalid request audit inputs', () => {
    expect(toAuditJson({ pin, nested: { PIN: pin } })).toEqual({
      pin: '[REDACTED]',
      nested: { PIN: '[REDACTED]' },
    });
  });
});
