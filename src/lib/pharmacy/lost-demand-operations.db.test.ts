// @vitest-environment node
/** Real production loader and boundary against migrated, FORCE-RLS PostgreSQL. No DB mocks. */
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const suite = url ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const organizationId = `org_ld_${suffix}`;
const foreignOrg = `org_ld_other_${suffix}`;
const userId = `user_ld_${suffix}`;
const approverId = `user_ld_approve_${suffix}`;
const roleId = `role_ld_${suffix}`;
let scoped: typeof import('@/lib/tenancy/scoped-db');
let operations: typeof import('./lost-demand-operations');
let demand: typeof import('./lost-demand-procurement');
let ledger: typeof import('./stock-ledger');
let inventory: typeof import('./inventory-operations');
let purchasing: typeof import('@/server/routers/pharmacy-purchasing');
let hashPin: (pin: string) => Promise<string>;
const actor = { organizationId, userId };
const inOrg = <T>(work: (db: ScopedDb) => Promise<T>) =>
  scoped.withTenantDb(organizationId, work, { userId });

beforeAll(async () => {
  if (!url) return;
  scoped = await import('@/lib/tenancy/scoped-db');
  const guard = await import('@/lib/testing/rls-role-guard');
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  operations = await import('./lost-demand-operations');
  demand = await import('./lost-demand-procurement');
  ledger = await import('./stock-ledger');
  inventory = await import('./inventory-operations');
  purchasing = await import('@/server/routers/pharmacy-purchasing');
  const credentials = await import('@/lib/restaurant/operator-credentials');
  hashPin = (pin) => credentials.hashOperatorCredential('PIN', pin);
  await scoped.withPlatformDb(async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations
      (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
      SELECT id,id,id,id,'PHARMACY','ACTIVE','SHARED',now(),now() FROM unnest($1::text[]) AS id`,
      [organizationId, foreignOrg]
    );
    await db.$executeRawUnsafe(
      `INSERT INTO organization_roles
      (id,"organizationId",key,name,"isSystem","createdAt","updatedAt") VALUES ($1,$2,'solo-owner','Owner',false,now(),now())`,
      roleId,
      organizationId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO organization_role_permissions
      (id,"organizationId","organizationRoleId",capability,effect,"createdAt") VALUES ($1,$2,$3,'*','ALLOW',now())`,
      `perm_ld_${suffix}`,
      organizationId,
      roleId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO organization_departments
      (id,"organizationId",key,name,active,"sortOrder","createdAt","updatedAt")
      VALUES ($1,$2,'operations','Operations',true,0,now(),now())`,
      `dept_ld_${suffix}`,
      organizationId
    );
    for (const id of [userId, approverId])
      await db.$executeRawUnsafe(
        `INSERT INTO users
      (id,"organizationId","organizationRoleId",name,email,role,department,title,"startDate",status,"createdAt","updatedAt")
      VALUES ($1,$2,$3,'Owner',$4,'ADMIN','operations','Owner',now(),'ACTIVE',now(),now())`,
        id,
        organizationId,
        roleId,
        `${id}@example.test`
      );
  });
  await inOrg(async (db) => {
    const staff = await db.restaurantStaffProfile.create({
      data: { organizationId, userId, displayName: 'Pharmacy owner' },
    });
    await db.restaurantOperatorCredential.create({
      data: {
        organizationId,
        staffProfileId: staff.id,
        type: 'PIN',
        credentialHash: await hashPin('4821'),
      },
    });
  });
}, 120_000);

async function fixture() {
  return inOrg(async (db) => {
    const tag = randomUUID();
    const branches = [];
    for (const label of ['destination', 'source']) {
      const branch = await db.pharmacyBranch.create({
        data: {
          organizationId,
          code: `${label}-${tag}`,
          name: label,
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: { organizationId, branchId: branch.id, code: 'MAIN', name: 'Main', kind: 'STORE' },
      });
      await db.pharmacyBranch.update({
        where: { id: branch.id },
        data: { defaultStockLocationId: location.id },
      });
      branches.push({ ...branch, locationId: location.id });
    }
    const [branch, source] = branches;
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Medicine ${tag}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0].id,
        versionGroupId: tag,
        version: 1,
        level: 'PACK',
        unitsPerParent: 10,
        effectiveFrom: new Date('2020-01-01Z'),
      },
    });
    const expiresAt = new Date(Date.now() + 365 * 86_400_000);
    const supplier = await db.pharmacySupplier.create({
      data: {
        organizationId,
        name: `Supplier ${tag}`,
        authorized: true,
        licences: {
          create: {
            licenceType: 'DISTRIBUTOR',
            licenceNumber: tag,
            issuingAuthority: 'Test',
            issuedAt: new Date('2020-01-01Z'),
            expiresAt,
            verifiedAt: new Date(),
            verifiedByUserId: userId,
          },
        },
      },
    });
    const requisition = await db.pharmacyRequisition.create({
      data: {
        organizationId,
        branchId: branch.id,
        reference: tag,
        requestedByUserId: userId,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: medicine.id,
            packLevelId: pack.id,
            quantityPacks: 10,
            canonicalUnitsPerPack: 10,
            canonicalUnits: 100,
          },
        },
      },
      include: { lines: true },
    });
    await db.pharmacyQuote.create({
      data: {
        organizationId,
        requisitionId: requisition.id,
        supplierId: supplier.id,
        quotedAt: new Date(Date.now() - 86_400_000),
        validUntil: expiresAt,
        lines: {
          create: {
            requisitionLineId: requisition.lines[0].id,
            pricePerPackMinor: 1000,
            canonicalUnitsPerPack: 10,
            leadTimeDays: 7,
            schemeBuyPacks: 5,
            schemeFreePacks: 1,
          },
        },
      },
    });
    for (const target of [branch, source])
      await db.pharmacySafetyStock.create({
        data: {
          organizationId,
          branchId: target.id,
          medicineId: medicine.id,
          safetyStockUnits: 10,
          approvedByUserId: userId,
          approvedAt: new Date(),
        },
      });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: { organizationId, medicineId: medicine.id, batchNumber: tag, expiresAt },
    });
    await ledger.receiveLot(
      db,
      { organizationId, branchId: source.id, actorId: userId },
      {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: source.locationId,
        unitsPerPack: 10,
        supplierName: supplier.name,
        supplierInvoiceRef: tag,
        unitCostMinor: 100,
        printedMrpMinor: 2000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: tag,
        receivedAt: new Date(Date.now() - 86_400_000),
      }
    );
    for (let n = 0; n < 3; n++)
      await db.unfulfilledDemandEvent.create({
        data: {
          organizationId,
          branchId: branch.id,
          requestedMedicineId: medicine.id,
          saleUnit: 'UNIT',
          quantity: 20,
          reason: 'STOCKOUT',
          inventoryRuleSnapshot: {},
          capturedByUserId: userId,
        },
      });
    return {
      branchId: branch.id,
      sourceId: source.id,
      medicineId: medicine.id,
      supplierId: supplier.id,
    };
  });
}

const callerContext = (db: ScopedDb, id: string) =>
  ({
    db,
    session: { expires: 'later', user: { id, role: 'ADMIN', status: 'ACTIVE', organizationId } },
    entitlements: { organizationId, enabledModules: ['pharmacy-procurement'], modules: [] },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  }) as unknown as import('@/server/trpc').TRPCContext;

suite('lost-demand production persistence and boundaries', () => {
  it('commits failed PIN counters, creates an inert native PO and leaves approval to a permitted colleague', async () => {
    const f = await fixture();
    const advice = (
      await inOrg((db) =>
        operations.loadLostDemandAdvice(db, { organizationId, branchId: f.branchId })
      )
    )[0];
    expect(advice.distributors[0].quantity).toMatchObject({
      orderedPacks: 6,
      bonusPacks: 1,
      suppliedUnits: 70,
    });
    expect(advice.transfers[0]).toMatchObject({ fromBranchId: f.sourceId, surplusUnits: 90 });
    const input = {
      branchId: f.branchId,
      adviceId: advice.id,
      action: 'DRAFT_PO' as const,
      supplierId: f.supplierId,
      pin: '9999',
    };
    await expect(operations.executeLostDemandAction(actor, input)).rejects.toThrow(
      'PIN_INVALID_OR_LOCKED'
    );
    await inOrg(async (db) => {
      expect(
        (await db.restaurantOperatorCredential.findFirstOrThrow({ where: { organizationId } }))
          .failedAttempts
      ).toBe(1);
      expect(await db.pharmacyPurchaseOrder.count({ where: { branchId: f.branchId } })).toBe(0);
    });
    const before = await inOrg((db) => db.pharmacyStockMovement.count());
    const result = await operations.executeLostDemandAction(actor, { ...input, pin: '4821' });
    if (!('id' in result)) throw new Error('Expected native draft');
    await inOrg(async (db) => {
      const order = await db.pharmacyPurchaseOrder.findFirstOrThrow({
        where: { id: result.id },
        include: { lines: true },
      });
      expect(order.status).toBe('DRAFT');
      expect(order.lines[0]).toMatchObject({
        orderedPacks: 6,
        bonusPacks: 1,
        orderedCanonicalUnits: 60,
        bonusCanonicalUnits: 10,
      });
      expect(await db.pharmacyStockMovement.count()).toBe(before);
      const audit = await db.auditLog.findFirstOrThrow({
        where: { targetId: advice.id, action: 'lostDemand.DRAFT_PO' },
      });
      expect(audit.actorId).toBe(userId);
      expect(audit.result).toMatchObject({ draftId: result.id, status: 'DRAFT' });
      expect(audit.input).toBeNull();
      expect(audit.result).toEqual({
        branchId: f.branchId,
        action: 'DRAFT_PO',
        draftId: result.id,
        status: 'DRAFT',
      });
      const api = purchasing.pharmacyPurchasingRouter.createCaller(callerContext(db, userId));
      await api.submitPurchaseOrder({ purchaseOrderId: result.id });
      await expect(
        api.approvePurchaseOrder({ purchaseOrderId: result.id, decision: 'APPROVED' })
      ).rejects.toThrow('SELF_APPROVAL');
    });
    await inOrg(async (db) => {
      const api = purchasing.pharmacyPurchasingRouter.createCaller(callerContext(db, approverId));
      expect(
        (await api.approvePurchaseOrder({ purchaseOrderId: result.id, decision: 'APPROVED' }))
          ?.status
      ).toBe('APPROVED');
    });
    await expect(
      operations.executeLostDemandAction(actor, { ...input, pin: '4821' })
    ).rejects.toThrow('LOST_DEMAND_ADVICE_NOT_AVAILABLE');
  });

  it('persists a DRAFT transfer and Ignore audits without moving or reserving stock', async () => {
    const f = await fixture();
    const advice = (
      await inOrg((db) =>
        operations.loadLostDemandAdvice(db, { organizationId, branchId: f.branchId })
      )
    )[0];
    const before = await inOrg((db) => db.pharmacyStockMovement.count());
    const result = await operations.executeLostDemandAction(actor, {
      branchId: f.branchId,
      adviceId: advice.id,
      action: 'DRAFT_TRANSFER',
      fromBranchId: f.sourceId,
      pin: '4821',
    });
    if (!('id' in result)) throw new Error('Expected draft');
    await inOrg(async (db) => {
      const transfer = await db.pharmacyInterbranchTransfer.findFirstOrThrow({
        where: { id: result.id },
        include: { lines: true },
      });
      expect(transfer.status).toBe('DRAFT');
      expect(transfer.lines[0].quantityUnits).toBe(70);
      expect(await db.pharmacyStockMovement.count()).toBe(before);
      expect(await db.pharmacySupplierClaim.count()).toBe(0);
      expect(
        await db.auditLog.count({
          where: { targetId: advice.id, action: 'lostDemand.DRAFT_TRANSFER' },
        })
      ).toBe(1);
    });
    await inOrg(async (db) => {
      const scope = { organizationId, branchId: f.sourceId, actorId: userId };
      await expect(inventory.approveTransfer(db, scope, result.id)).rejects.toThrow(
        'COAUTH_REQUIRED'
      );
      expect((await operations.submitTransferDraft(db, scope, result.id)).status).toBe('ALLOCATED');
      await expect(inventory.approveTransfer(db, scope, result.id)).rejects.toThrow(
        'COAUTH_REQUIRED'
      );
      expect(
        (await inventory.approveTransfer(db, { ...scope, actorId: approverId }, result.id)).status
      ).toBe('APPROVED');
      expect(await db.pharmacyStockMovement.count()).toBe(before);
    });
    const ignored = await fixture();
    const [next] = await inOrg((db) =>
      operations.loadLostDemandAdvice(db, { organizationId, branchId: ignored.branchId })
    );
    await expect(
      operations.executeLostDemandAction(actor, {
        branchId: ignored.branchId,
        adviceId: next.id,
        action: 'IGNORE',
        pin: '4821',
      })
    ).resolves.toEqual({ status: 'IGNORED' });
    expect(
      await inOrg((db) =>
        operations.loadLostDemandAdvice(db, { organizationId, branchId: ignored.branchId })
      )
    ).toEqual([]);
    expect(
      await inOrg((db) =>
        db.auditLog.count({ where: { targetId: next.id, action: 'lostDemand.IGNORE' } })
      )
    ).toBe(1);
  });

  it('uses persisted branch settings and explicit idempotent visit evidence under tenant and branch RLS', async () => {
    const f = await fixture();
    const config = {
      ...demand.DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
      requestsInWindow: 100,
      walkOutRateBps: 1000,
    };
    await inOrg(async (db) => {
      await operations.saveLostDemandConfig(
        db,
        { organizationId, branchId: f.branchId, actorId: userId },
        config
      );
      const visit = { id: randomUUID(), medicineId: f.medicineId, walkedOut: true };
      await operations.captureLostDemandVisit(
        db,
        { organizationId, branchId: f.branchId, actorId: userId },
        visit
      );
      await operations.captureLostDemandVisit(
        db,
        { organizationId, branchId: f.branchId, actorId: userId },
        visit
      );
      for (let n = 0; n < 8; n++)
        await operations.captureLostDemandVisit(
          db,
          { organizationId, branchId: f.branchId, actorId: userId },
          { id: randomUUID(), walkedOut: false }
        );
    });
    const result = await inOrg((db) =>
      demand.loadLostDemandScopeAlerts(
        db,
        { organizationId, branchId: f.branchId },
        { financial: false }
      )
    );
    expect(result.config.requestsInWindow).toBe(100);
    expect(result.alerts[0]).toMatchObject({ visits: 9, walkOuts: 1, fired: ['WALK_OUT_RATE'] });
    await inOrg(async (db) => {
      expect(
        (await demand.loadLostDemandConfig(db, { organizationId, branchId: f.sourceId }))
          .requestsInWindow
      ).toBe(3);
      await db.$queryRaw`SELECT set_config('app.current_branch_id', ${f.sourceId}, true)`;
      expect(
        await db.$queryRaw`SELECT "id" FROM "pharmacy_demand_visits" WHERE "branchId"=${f.branchId}`
      ).toEqual([]);
    });
    expect(
      await scoped.withTenantDb(
        foreignOrg,
        (db) =>
          db.$queryRaw`SELECT "id" FROM "pharmacy_demand_visits" WHERE "organizationId"=${organizationId}`
      )
    ).toEqual([]);
  });
  it('refuses changed supplier terms and an explicit capability denial before creating a draft', async () => {
    const f = await fixture();
    const scope = { organizationId, branchId: f.branchId };
    const [old] = await inOrg((db) => operations.loadLostDemandAdvice(db, scope));
    await inOrg((db) =>
      db.pharmacyQuoteLine.updateMany({
        where: { organizationId, requisitionLine: { medicineId: f.medicineId } },
        data: { pricePerPackMinor: 1100 },
      })
    );
    await expect(
      operations.executeLostDemandAction(actor, {
        branchId: f.branchId,
        adviceId: old.id,
        action: 'DRAFT_PO',
        supplierId: f.supplierId,
        pin: '4821',
      })
    ).rejects.toThrow('LOST_DEMAND_ADVICE_NOT_AVAILABLE');
    const [current] = await inOrg((db) => operations.loadLostDemandAdvice(db, scope));
    expect(current.id).not.toBe(old.id);
    await inOrg((db) =>
      db.userPermissionOverride.create({
        data: {
          organizationId,
          userId: approverId,
          capability: 'pharmacy:procurement',
          effect: 'DENY',
          reason: 'Review regression',
          createdById: userId,
        },
      })
    );
    await expect(
      operations.executeLostDemandAction(
        { organizationId, userId: approverId },
        {
          branchId: f.branchId,
          adviceId: current.id,
          action: 'DRAFT_PO',
          supplierId: f.supplierId,
          pin: '4821',
        }
      )
    ).rejects.toThrow('PROCUREMENT_FORBIDDEN');
    expect(
      await inOrg((db) => db.pharmacyPurchaseOrder.count({ where: { branchId: f.branchId } }))
    ).toBe(0);
  });

  it('lets a pharmacy-only owner enrol a PIN without restaurant credentials and then act on advice', async () => {
    const pinUserId = `user_ld_pin_${suffix}`;
    await scoped.withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO users
      (id,"organizationId","organizationRoleId",name,email,role,department,title,"startDate",status,"createdAt","updatedAt")
      VALUES ($1,$2,$3,'Pin Owner',$4,'ADMIN','operations','Owner',now(),'ACTIVE',now(),now())`,
        pinUserId,
        organizationId,
        roleId,
        `${pinUserId}@example.test`
      )
    );
    const pinActor = { organizationId, userId: pinUserId };
    const enrolment = await import('./operator-pin');
    const f = await fixture();
    const [advice] = await inOrg((db) =>
      operations.loadLostDemandAdvice(db, { organizationId, branchId: f.branchId })
    );
    // No staff profile or PIN exists yet: the action is refused.
    await expect(
      operations.executeLostDemandAction(pinActor, {
        branchId: f.branchId,
        adviceId: advice.id,
        action: 'IGNORE',
        pin: '1357',
      })
    ).rejects.toThrow('PIN_INVALID_OR_LOCKED');
    const enrolled = await scoped.withTenantDb(
      organizationId,
      (db) =>
        enrolment.enrolPharmacyOperatorPin(db, { ...pinActor, role: 'ADMIN' }, { pin: '1357' }),
      { userId: pinUserId }
    );
    if (!enrolled.ok) throw new Error('Expected enrolment');
    await inOrg(async (db) => {
      const credential = await db.restaurantOperatorCredential.findFirstOrThrow({
        where: { id: enrolled.credentialId },
      });
      expect(credential.credentialHash).not.toContain('1357');
      const audit = await db.auditLog.findFirstOrThrow({
        where: { targetId: enrolled.credentialId, action: 'pharmacyOperatorPin.set' },
      });
      expect(audit.actorId).toBe(pinUserId);
      expect(JSON.stringify(audit)).not.toContain('1357');
      expect(JSON.stringify(audit)).not.toContain(credential.credentialHash);
    });
    await expect(
      operations.executeLostDemandAction(pinActor, {
        branchId: f.branchId,
        adviceId: advice.id,
        action: 'IGNORE',
        pin: '1357',
      })
    ).resolves.toEqual({ status: 'IGNORED' });
    // A reset revokes the previous PIN.
    const reset = await scoped.withTenantDb(
      organizationId,
      (db) =>
        enrolment.enrolPharmacyOperatorPin(db, { ...pinActor, role: 'ADMIN' }, { pin: '2468' }),
      { userId: pinUserId }
    );
    expect(reset).toMatchObject({ ok: true, reset: true });
    await inOrg(async (db) => {
      expect(
        (
          await db.restaurantOperatorCredential.findFirstOrThrow({
            where: { id: enrolled.credentialId },
          })
        ).revokedAt
      ).not.toBeNull();
      expect(
        await db.restaurantOperatorCredential.count({
          where: { staffProfile: { userId: pinUserId }, revokedAt: null },
        })
      ).toBe(1);
    });
  });
});
