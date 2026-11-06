/** Run only against a NEW disposable wha1364_* database, never an existing tenant. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { addSaleLine, createSale } from './sales';
import { receiveLot, reverseMovements } from './stock-ledger';
import { applyPharmacyTender, readPharmacyTenderOutcome, refundPharmacyTender } from './settlement';
import { prepareExternalPaymentAttempt, readExternalPaymentAttempt } from './payment-attempts';
import {
  beginManualCollection,
  completeManualCollection,
  resolveManualCollection,
  recoverPaymentCollection,
  collectProviderPayment,
  registerUnpreparedManualCollection,
} from './payment-attempt-operations';

const url = process.env.WHA1364_RECEIPT_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/wha1364_')) {
  throw new Error(
    'New isolated WHA1364_RECEIPT_TEST_DATABASE_URL required; no skipped DB acceptance'
  );
}
// The app client, not a bare PrismaPg one: only it decodes the void result of the services'
// `SELECT pg_advisory_xact_lock(...)`. It reads DATABASE_URL lazily, on first use.
if (url) process.env.DATABASE_URL = url;
const client = url ? db : null;
const describeDatabase = url ? describe : describe.skip;
const org = `org_${randomUUID()}`;
const branch = `branch_${randomUUID()}`;
const scope = { organizationId: org, branchId: branch, actorId: `actor_${randomUUID()}` };
let manager: typeof scope;
let owner: typeof scope;
let unassignedManager: typeof scope;
let unknownRole: typeof scope;
const businessDate = new Date('2026-09-05T13:14:00.000Z');
function transaction<T>(work: (db: ScopedDb) => Promise<T>, organizationId = org) {
  if (!client) throw new Error('Isolated receipt database required');
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
        organizationId
      );
      return work(tx as ScopedDb);
    },
    { timeout: 30000 }
  );
}
beforeAll(async () => {
  if (!client) return;
  const [role] = await client.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  // Integrated tip (20261012120000_visibility_context_anchors): tenant rows must reference an
  // existing organization, so anchor this suite's synthetic tenant first.
  await client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
    await tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      org
    );
  });
  await transaction((db) =>
    db.pharmacyBranch.create({
      data: {
        id: branch,
        organizationId: org,
        code: branch,
        name: 'Receipt test',
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
        manualPaymentSettings: {
          JAZZCASH: { destination: 'Test till', allowReferenceSkip: false },
          RAAST: { destination: 'Test IBAN', allowReferenceSkip: true },
          EASYPAISA: { destination: 'Test till', allowReferenceSkip: false },
        },
      },
    })
  );
  await transaction(async (db) => {
    await db.organizationDepartment.create({
      data: { organizationId: org, key: 'payment-test', name: 'Payment test' },
    });
  });
  const member = async (actorId: string, key: string | null, isSystem = true, assigned = true) =>
    transaction(async (db) => {
      const role = key
        ? await db.organizationRole.create({
            data: {
              organizationId: org,
              key: `${key}-${actorId}`,
              name: key,
              isSystem,
              permissions: {
                create: [
                  { organizationId: org, capability: 'pharmacy:counter', effect: 'ALLOW' },
                  { organizationId: org, capability: 'pharmacy:close', effect: 'ALLOW' },
                ],
              },
            },
          })
        : null;
      // Approved system keys are exact; keep them unique per tenant, with only
      // the second manager sharing the same stored assigned role below.
      if (role && ['manager', 'cashier'].includes(key!))
        await db.organizationRole.update({ where: { id: role.id }, data: { key: key! } });
      await db.user.create({
        data: {
          id: actorId,
          organizationId: org,
          name: actorId,
          email: `${actorId}@example.invalid`,
          department: 'payment-test',
          title: 'Test',
          role: key ? 'EMPLOYEE' : 'ADMIN',
          organizationRoleId: role?.id,
        },
      });
      if (assigned)
        await db.pharmacyBranchAssignment.create({
          data: { organizationId: org, branchId: branch, userId: actorId },
        });
      return { ...scope, actorId };
    });
  await member(scope.actorId, 'cashier');
  manager = await member(`manager_${randomUUID()}`, 'manager');
  owner = await member(`owner_${randomUUID()}`, null, true, false);
  unknownRole = await member(`unknown_${randomUUID()}`, 'manager-looking-custom', false);
  unassignedManager = { ...scope, actorId: `unassigned_${randomUUID()}` };
  await transaction(async (db) => {
    const role = await db.organizationRole.findUniqueOrThrow({
      where: { organizationId_key: { organizationId: org, key: 'manager' } },
    });
    await db.user.create({
      data: {
        id: unassignedManager.actorId,
        organizationId: org,
        name: 'Unassigned',
        email: `${unassignedManager.actorId}@example.invalid`,
        department: 'payment-test',
        title: 'Test',
        role: 'EMPLOYEE',
        organizationRoleId: role.id,
      },
    });
  });
});
afterAll(() => client?.$disconnect());

async function fixture() {
  return transaction(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId: org,
        productName: 'Issued medicine',
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId: org, presentation: 'Issued tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const ingredient = await db.ingredient.create({
      data: { organizationId: org, name: `Ingredient ${randomUUID()}` },
    });
    await db.medicineStrengthComponent.create({
      data: {
        organizationId: org,
        medicineId: medicine.id,
        ingredientId: ingredient.id,
        value: 500,
        unit: 'mg',
      },
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
        branchId: branch,
        code: randomUUID(),
        name: 'Test stock',
        kind: 'STORE',
      },
    });
    const batches = [];
    for (const [index, quantity] of [3, 7].entries()) {
      const expiresAt = new Date(`203${index + 1}-01-01T00:00:00.000Z`);
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: `ISSUED-${index}`,
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Test',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1,
        printedMrpMinor: 1000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: quantity,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2026-01-01'),
      });
      batches.push(batch);
    }
    const sale = await createSale(db, scope);
    await addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: 'UNIT',
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      discountMinor: 50,
      discountKind: 'DISCOUNT',
      approvedByUserId: scope.actorId,
      approvalPolicy: 'test',
      idempotencyKey: randomUUID(),
    });
    return {
      sale,
      medicine,
      presentation,
      batches,
      input: {
        saleId: sale.id,
        deviceId: randomUUID(),
        businessDate,
        type: 'BANK_TRANSFER' as const,
        amountMinor: 950,
        idempotencyKey: randomUUID(),
      },
    };
  });
}
async function counts(saleId: string) {
  return transaction(async (db) => ({
    sale: await db.pharmacySale.findFirstOrThrow({ where: { id: saleId } }),
    tenders: await db.pharmacyTender.count({ where: { saleId } }),
    events: await db.pharmacySaleEvent.findMany({ where: { saleId, kind: 'COMPLETED' } }),
  }));
}

async function reservation(
  f: Awaited<ReturnType<typeof fixture>>,
  requestKey = randomUUID(),
  amountMinor = 950
) {
  const revision = await transaction(
    async (db) =>
      (await db.pharmacySale.findFirstOrThrow({ where: { id: f.sale.id } })).paymentRevision
  );
  return {
    saleId: f.sale.id,
    deviceId: f.input.deviceId,
    requestKey,
    method: 'JAZZCASH' as const,
    amountMinor,
    expectedRevision: revision,
  };
}

describeDatabase('durable payment attempt foundation on restricted PostgreSQL', () => {
  it('retains committed preparation after a later rollback and blocks mutation and provider dispatch', async () => {
    const f = await fixture();
    const input = await reservation(f);
    const prepared = await prepareExternalPaymentAttempt(scope, input);
    await expect(
      transaction(async () => {
        throw new Error('SYNTHETIC_FAILURE_AFTER_PREPARE');
      })
    ).rejects.toThrow('SYNTHETIC_FAILURE');
    expect(await readExternalPaymentAttempt(scope, prepared.attempt.id)).toMatchObject({
      state: 'PREPARED',
      saleId: f.sale.id,
    });
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 1 } })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    await expect(
      transaction((db) =>
        db.pharmacySale.update({ where: { id: f.sale.id }, data: { status: 'VOID' } })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    let calls = 0;
    const adapter = {
      name: 'CERTIFIED_TEST_PROVIDER',
      certified: true,
      execute: async () => {
        calls++;
        return { approved: true, providerRef: 'synthetic' };
      },
    };
    await expect(
      transaction((db) => applyPharmacyTender(db, scope, { ...f.input, type: 'CARD', adapter }))
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    expect(calls).toBe(0);
    const allocation = await transaction((db) =>
      db.pharmacySaleLineAllocation.findFirstOrThrow({ where: { saleLine: { saleId: f.sale.id } } })
    );
    await expect(
      transaction((db) =>
        db.pharmacySaleLineAllocation.update({
          where: { id: allocation.id },
          data: { canonicalUnits: 1 },
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.deleteMany({
          where: { saleId: f.sale.id },
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    await expect(
      transaction((db) =>
        reverseMovements(db, scope, {
          movementIds: [allocation.stockMovementId],
          reason: 'Attempted reversal',
          at: new Date(),
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    expect((await counts(f.sale.id)).tenders).toBe(0);
    expect(await transaction((db) => readPharmacyTenderOutcome(db, scope, f.input))).toEqual({
      status: 'UNKNOWN',
      replayUnsafe: true,
    });
  });

  it('retries one request exactly and refuses changed amounts and concurrent second requests', async () => {
    const f = await fixture();
    const input = await reservation(f);
    const [a, b] = await Promise.all([
      prepareExternalPaymentAttempt(scope, input),
      prepareExternalPaymentAttempt(scope, input),
    ]);
    expect(a.attempt.id).toBe(b.attempt.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    await expect(
      prepareExternalPaymentAttempt(scope, { ...input, amountMinor: 949 })
    ).rejects.toMatchObject({ reason: 'REQUEST_CONFLICT' });
    await expect(
      prepareExternalPaymentAttempt(scope, { ...input, requestKey: randomUUID() })
    ).rejects.toMatchObject({ reason: 'ATTEMPT_UNRESOLVED' });
  });

  it('retains evidence after synthetic external success, lost acknowledgement and database rollback', async () => {
    const f = await fixture();
    const input = await reservation(f);
    const { attempt } = await prepareExternalPaymentAttempt(scope, input);
    // No real provider is connected. This represents an irreversible success
    // after the separate preparation commit, followed by a failed tender tx.
    let syntheticExternalApprovals = 0;
    await expect(
      transaction(async () => {
        syntheticExternalApprovals++;
        throw new Error('SYNTHETIC_LOST_PROVIDER_ACK');
      })
    ).rejects.toThrow('SYNTHETIC_LOST_PROVIDER_ACK');
    const recovered = await prepareExternalPaymentAttempt(scope, input);
    expect(recovered).toMatchObject({
      replayed: true,
      attempt: { id: attempt.id, state: 'PREPARED' },
    });
    expect(syntheticExternalApprovals).toBe(1);
    expect((await counts(f.sale.id)).tenders).toBe(0);
    // A missing tender no longer permits edits to a prepared bill. The next
    // integration must reconcile this attempt, never infer non-payment.
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({
          where: { saleId: f.sale.id },
          data: { discountMinor: 1 },
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
  });

  it('serializes edits against reservation and rejects a stale bill revision', async () => {
    const f = await fixture();
    const input = await reservation(f);
    const results = await Promise.allSettled([
      prepareExternalPaymentAttempt(scope, input),
      transaction((db) =>
        db.pharmacySaleLine.updateMany({
          where: { saleId: f.sale.id },
          data: { discountMinor: 51 },
        })
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const active = await transaction((db) =>
      db.pharmacyPaymentAttempt.count({ where: { saleId: f.sale.id } })
    );
    if (active === 0)
      await expect(prepareExternalPaymentAttempt(scope, input)).rejects.toThrow(
        'PAYMENT_BILL_CHANGED'
      );
    else expect(results[1]!.status).toBe('rejected');
  });

  it('allows only one unresolved request when two devices reserve the same bill', async () => {
    const f = await fixture();
    const input = await reservation(f);
    const results = await Promise.allSettled([
      prepareExternalPaymentAttempt(scope, input),
      prepareExternalPaymentAttempt(scope, {
        ...input,
        deviceId: randomUUID(),
        requestKey: randomUUID(),
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await transaction((db) => db.pharmacyPaymentAttempt.count({ where: { saleId: f.sale.id } }))
    ).toBe(1);
  });

  it('refuses raw state release, forged scope, identity changes and deletion', async () => {
    const f = await fixture();
    const input = await reservation(f);
    const { attempt } = await prepareExternalPaymentAttempt(scope, input);
    // The first slice deliberately has no resolution operation. Same-tenant
    // database access, a supplied role or a missing actor must not unlock it.
    for (const actor of ['', 'cashier', 'owner', 'manager', 'unknown']) {
      await expect(
        transaction(async (db) => {
          await db.$executeRawUnsafe("SELECT set_config('app.current_user_id', $1, true)", actor);
          return db.pharmacyPaymentAttempt.update({
            where: { id: attempt.id },
            data: { state: 'RELEASED' },
          });
        })
      ).rejects.toThrow('PAYMENT_ATTEMPT_FORBIDDEN');
    }
    await expect(
      transaction((db) =>
        db.pharmacyPaymentAttempt.update({
          where: { id: attempt.id },
          data: { amountMinor: 1 },
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_IDENTITY_IMMUTABLE');
    await expect(
      transaction((db) => db.pharmacyPaymentAttempt.delete({ where: { id: attempt.id } }))
    ).rejects.toThrow('PAYMENT_ATTEMPT_APPEND_ONLY');
    await expect(
      prepareExternalPaymentAttempt({ ...scope, organizationId: 'other-organization' }, input)
    ).rejects.toMatchObject({ reason: 'SALE_NOT_FOUND' });
    expect(await readExternalPaymentAttempt(scope, attempt.id)).toMatchObject({
      state: 'PREPARED',
      amountMinor: 950,
    });
    const unscoped = await client!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT set_config('app.current_organization_id', '', true), set_config('app.is_platform_admin', 'true', true)"
      );
      return tx.pharmacyPaymentAttempt.findFirst({ where: { id: attempt.id } });
    });
    expect(unscoped).toBeNull();
  });

  it('binds partial balance and current revision, and isolates branch and tenant reads', async () => {
    const f = await fixture();
    await transaction((db) => applyPharmacyTender(db, scope, { ...f.input, amountMinor: 400 }));
    const input = await reservation(f, randomUUID(), 550);
    await expect(
      prepareExternalPaymentAttempt(scope, { ...input, amountMinor: 551 })
    ).rejects.toThrow('PAYMENT_AMOUNT_EXCEEDS_BALANCE');
    const prepared = await prepareExternalPaymentAttempt(scope, input);
    expect(prepared.attempt.amountMinor).toBe(550);
    expect(
      await readExternalPaymentAttempt({ ...scope, branchId: 'wrong-branch' }, prepared.attempt.id)
    ).toBeNull();
    expect(
      await readExternalPaymentAttempt(
        { ...scope, organizationId: 'other-organization' },
        prepared.attempt.id
      )
    ).toBeNull();
    await expect(
      prepareExternalPaymentAttempt({ ...scope, branchId: 'wrong-branch' }, input)
    ).rejects.toMatchObject({ reason: 'SALE_NOT_FOUND' });
    const foreignUpdated = await transaction(
      (db) =>
        db.pharmacyPaymentAttempt.updateMany({
          where: { id: prepared.attempt.id },
          data: { state: 'RELEASED' },
        }),
      'other-organization'
    );
    expect(foreignUpdated.count).toBe(0);
    expect(await readExternalPaymentAttempt(scope, prepared.attempt.id)).toMatchObject({
      state: 'PREPARED',
    });
  });

  it('refuses a prior partial-tender refund before a provider call and at the database boundary', async () => {
    const f = await fixture();
    let providerCalls = 0;
    const adapter = {
      name: 'CERTIFIED_TEST_PROVIDER',
      certified: true,
      execute: async () => {
        providerCalls++;
        return { approved: true, providerRef: 'synthetic-partial-approval' };
      },
    };
    const request = await reservation(f, f.input.idempotencyKey, 400);
    const paid = await collectProviderPayment(
      scope,
      { ...request, method: 'CARD', businessDate },
      adapter
    );
    expect(providerCalls).toBe(1);
    if (!('tenderId' in paid) || typeof paid.tenderId !== 'string')
      throw new Error('Missing test tender');
    const originalTenderId = paid.tenderId;
    await prepareExternalPaymentAttempt(scope, await reservation(f, randomUUID(), 550));
    providerCalls = 0;
    await expect(
      transaction((db) =>
        refundPharmacyTender(db, scope, {
          originalTenderId,
          deviceId: f.input.deviceId,
          businessDate,
          amountMinor: 100,
          reason: 'Synthetic refund while payment is uncertain',
          idempotencyKey: randomUUID(),
          adapter,
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    expect(providerCalls).toBe(0);
    await expect(
      transaction((db) =>
        db.pharmacyRefund.create({
          data: {
            organizationId: org,
            branchId: branch,
            saleId: f.sale.id,
            originalTenderId,
            businessDate,
            amountMinor: 100,
            reason: 'Direct refund bypass',
            actorId: scope.actorId,
          },
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    expect(
      await transaction((db) => db.pharmacyRefund.count({ where: { saleId: f.sale.id } }))
    ).toBe(0);
  });
});

describeDatabase('authenticated collection hand-off and recovery on restricted PostgreSQL', () => {
  const capture = { payerName: 'Ayesha', providerRef: '001234' };
  it('retains historical manual-card uncertainty without permitting manual card resolution', async () => {
    const f = await fixture();
    const reported = await registerUnpreparedManualCollection(scope, {
      ...f.input,
      type: 'CARD',
      providerRef: 'historic-external-reference',
    });
    expect(reported).toMatchObject({ state: 'UNKNOWN', method: 'CARD', canResolve: false });
    for (const decision of ['CONFIRM', 'RELEASE'] as const) {
      await expect(
        resolveManualCollection(manager, {
          attemptId: reported.id,
          decision,
          reason: 'Historical card requires certified reconciliation',
        })
      ).rejects.toThrow('PAYMENT_METHOD_NOT_SETUP');
    }
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({
          where: { saleId: f.sale.id },
          data: { discountMinor: 1 },
        })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    expect((await counts(f.sale.id)).tenders).toBe(0);
  });

  it('locks an older unprepared received report durably and requires authorized resolution', async () => {
    const f = await fixture();
    const input = { ...f.input, type: 'JAZZCASH', ...capture };
    const first = await registerUnpreparedManualCollection(scope, input);
    expect(first.state).toBe('UNKNOWN');
    expect((await registerUnpreparedManualCollection(scope, input)).id).toBe(first.id);
    await expect(
      registerUnpreparedManualCollection(scope, { ...input, amountMinor: 949 })
    ).rejects.toThrow('PAYMENT_REQUEST_CONFLICT');
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 1 } })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    await expect(
      resolveManualCollection(scope, {
        attemptId: first.id,
        decision: 'CONFIRM',
        reason: 'Cashier cannot resolve',
        ...capture,
      })
    ).rejects.toThrow('PAYMENT_FORBIDDEN');
    expect(
      await resolveManualCollection(manager, {
        attemptId: first.id,
        decision: 'CONFIRM',
        reason: 'Verified older reported funds',
        ...capture,
      })
    ).toMatchObject({ state: 'SETTLED' });
    expect((await counts(f.sale.id)).tenders).toBe(1);
  });

  it('retains an older stale overpayment report as uncertainty without changing settlement limits', async () => {
    const f = await fixture();
    const reported = await registerUnpreparedManualCollection(scope, {
      ...f.input,
      type: 'BANK_TRANSFER',
      amountMinor: 1000,
    });
    expect(
      await transaction((db) =>
        db.pharmacyPaymentAttempt.findUnique({ where: { id: reported.id } })
      )
    ).toMatchObject({ source: 'LEGACY_CAPTURE', state: 'UNKNOWN', amountMinor: 1000 });
    await expect(
      resolveManualCollection(owner, {
        attemptId: reported.id,
        decision: 'CONFIRM',
        reason: 'Reported funds exceed the bill',
      })
    ).rejects.toThrow('OVER_TENDER');
    expect((await counts(f.sale.id)).tenders).toBe(0);
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 1 } })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
  });

  it('retains every distinct older uncertainty report and keeps the bill locked until all are resolved', async () => {
    const f = await fixture();
    const a = await registerUnpreparedManualCollection(scope, {
      ...f.input,
      type: 'BANK_TRANSFER',
      amountMinor: 400,
    });
    const b = await registerUnpreparedManualCollection(scope, {
      ...f.input,
      type: 'BANK_TRANSFER',
      amountMinor: 550,
      idempotencyKey: randomUUID(),
    });
    expect(a.id).not.toBe(b.id);
    expect(
      await transaction((db) =>
        db.pharmacyPaymentAttempt.count({ where: { saleId: f.sale.id, state: 'UNKNOWN' } })
      )
    ).toBe(2);
    await resolveManualCollection(owner, {
      attemptId: a.id,
      decision: 'RELEASE',
      reason: 'First report verified no funds',
    });
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 1 } })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
    await resolveManualCollection(owner, {
      attemptId: b.id,
      decision: 'RELEASE',
      reason: 'Second report verified no funds',
    });
    await transaction((db) =>
      db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 1 } })
    );
  });

  it('relocks a released bill when its original collector reports late-arriving funds', async () => {
    const f = await fixture();
    const started = await beginManualCollection(scope, {
      ...(await reservation(f)),
      method: 'BANK_TRANSFER',
      businessDate,
    });
    await resolveManualCollection(owner, {
      attemptId: started.attempt.id,
      decision: 'RELEASE',
      reason: 'No funds at time of review',
    });
    await expect(
      completeManualCollection(scope, {
        attemptId: started.attempt.id,
        collectionToken: started.collectionToken!,
      })
    ).rejects.toThrow('PAYMENT_UNRESOLVED');
    expect(
      await transaction((db) =>
        db.pharmacyPaymentAttempt.findFirst({
          where: { saleId: f.sale.id, source: 'LEGACY_CAPTURE' },
        })
      )
    ).toMatchObject({ state: 'UNKNOWN' });
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 1 } })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
  });
  async function begin(f: Awaited<ReturnType<typeof fixture>>) {
    return beginManualCollection(scope, { ...(await reservation(f)), businessDate });
  }

  it('commits collection permission once and records one tender across concurrent completion and acknowledgement recovery', async () => {
    const f = await fixture();
    const request = { ...(await reservation(f)), businessDate };
    const first = await beginManualCollection(scope, request);
    expect(first.attempt.state).toBe('EXPOSED');
    expect(first.collectionToken).toHaveLength(43);
    const duplicate = await beginManualCollection(scope, request);
    expect(duplicate.collectionToken).toBeNull();
    const input = {
      attemptId: first.attempt.id,
      collectionToken: first.collectionToken!,
      ...capture,
    };
    const results = await Promise.allSettled([
      completeManualCollection(scope, input),
      completeManualCollection(scope, input),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect((await counts(f.sale.id)).tenders).toBe(1);
    const recovered = await recoverPaymentCollection(scope, { attemptId: first.attempt.id });
    expect(recovered).toMatchObject({
      state: 'SETTLED',
      result: { settled: true, remainingMinor: 0 },
    });
    expect(recovered).not.toHaveProperty('collectionTokenHash');
    expect(await completeManualCollection(scope, input)).toMatchObject({
      tenderId: recovered!.result!.tenderId,
      replayed: true,
    });
    const events = await transaction((db) =>
      db.pharmacyPaymentAttemptEvent.findMany({
        where: { attemptId: first.attempt.id },
        orderBy: { createdAt: 'asc' },
      })
    );
    expect(events.map((event) => event.toState)).toEqual(['EXPOSED', 'UNKNOWN', 'SETTLED']);
  });

  it('leaves a failed financial transaction uncertain, denies cashier resolution, and allows an assigned manager to confirm exactly once', async () => {
    const f = await fixture();
    const started = await begin(f);
    await transaction((db) =>
      db.medicine.update({ where: { id: f.medicine.id }, data: { productName: '' } })
    );
    await expect(
      completeManualCollection(scope, {
        attemptId: started.attempt.id,
        collectionToken: started.collectionToken!,
        ...capture,
      })
    ).rejects.toThrow('INVALID_RECEIPT_IDENTITY');
    expect((await counts(f.sale.id)).tenders).toBe(0);
    expect(await recoverPaymentCollection(scope, { attemptId: started.attempt.id })).toMatchObject({
      state: 'UNKNOWN',
      canResolve: false,
    });
    await transaction((db) =>
      db.medicine.update({
        where: { id: f.medicine.id },
        data: { productName: 'Restored test medicine' },
      })
    );
    await expect(
      completeManualCollection(scope, {
        attemptId: started.attempt.id,
        collectionToken: started.collectionToken!,
        ...capture,
      })
    ).rejects.toThrow('PAYMENT_UNRESOLVED');
    await expect(
      resolveManualCollection(scope, {
        attemptId: started.attempt.id,
        decision: 'CONFIRM',
        reason: 'Cashier cannot resolve',
        ...capture,
      })
    ).rejects.toThrow('PAYMENT_FORBIDDEN');
    const resolved = await resolveManualCollection(manager, {
      attemptId: started.attempt.id,
      decision: 'CONFIRM',
      reason: 'Verified branch wallet funds',
      ...capture,
    });
    expect(resolved).toMatchObject({ state: 'SETTLED', result: { settled: true } });
    expect((await counts(f.sale.id)).tenders).toBe(1);
    expect(
      await resolveManualCollection(manager, {
        attemptId: started.attempt.id,
        decision: 'CONFIRM',
        reason: 'Verified branch wallet funds',
        ...capture,
      })
    ).toMatchObject({ result: { replayed: true } });
  });

  it('enforces stored Owner/Manager identity, active branch assignment, deny precedence and missing roles', async () => {
    const f = await fixture();
    const started = await begin(f);
    for (const actor of [
      scope,
      unknownRole,
      unassignedManager,
      { ...scope, actorId: 'missing-user' },
    ]) {
      await expect(
        resolveManualCollection(actor, {
          attemptId: started.attempt.id,
          decision: 'RELEASE',
          reason: 'No funds arrived',
        })
      ).rejects.toThrow('PAYMENT_FORBIDDEN');
    }
    await expect(
      resolveManualCollection(
        { ...manager, organizationId: 'foreign-org' },
        { attemptId: started.attempt.id, decision: 'RELEASE', reason: 'Foreign tenant' }
      )
    ).rejects.toThrow('PAYMENT_FORBIDDEN');
    await expect(
      resolveManualCollection(
        { ...manager, branchId: 'unknown-branch' },
        { attemptId: started.attempt.id, decision: 'RELEASE', reason: 'Foreign branch' }
      )
    ).rejects.toThrow('PAYMENT_FORBIDDEN');
    await transaction((db) =>
      db.userPermissionOverride.create({
        data: {
          organizationId: org,
          userId: manager.actorId,
          capability: 'pharmacy:*',
          effect: 'DENY',
          reason: 'Test deny',
        },
      })
    );
    await expect(
      resolveManualCollection(manager, {
        attemptId: started.attempt.id,
        decision: 'RELEASE',
        reason: 'Denied manager',
      })
    ).rejects.toThrow('PAYMENT_FORBIDDEN');
    await transaction((db) =>
      db.userPermissionOverride.deleteMany({ where: { userId: manager.actorId } })
    );
    expect(
      await resolveManualCollection(owner, {
        attemptId: started.attempt.id,
        decision: 'RELEASE',
        reason: 'Owner verified no funds arrived',
      })
    ).toEqual({ state: 'RELEASED', result: null });
    await transaction((db) =>
      db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 51 } })
    );
  });

  it('serializes confirmation against release without a second tender or an unlocked uncertain bill', async () => {
    const f = await fixture();
    const started = await begin(f);
    await Promise.allSettled([
      resolveManualCollection(manager, {
        attemptId: started.attempt.id,
        decision: 'CONFIRM',
        reason: 'Funds verified',
        ...capture,
      }),
      resolveManualCollection(owner, {
        attemptId: started.attempt.id,
        decision: 'RELEASE',
        reason: 'No funds verified',
      }),
    ]);
    const recovered = await recoverPaymentCollection(manager, { attemptId: started.attempt.id });
    expect(['SETTLED', 'RELEASED']).toContain(recovered?.state);
    expect((await counts(f.sale.id)).tenders).toBe(recovered?.state === 'SETTLED' ? 1 : 0);
  });

  it('keeps bank transfer amount-only and rejects collection tokens from another attempt', async () => {
    const f = await fixture();
    const started = await beginManualCollection(scope, {
      ...(await reservation(f)),
      method: 'BANK_TRANSFER',
      businessDate,
    });
    await expect(
      completeManualCollection(scope, {
        attemptId: started.attempt.id,
        collectionToken: started.collectionToken!,
        ...capture,
      })
    ).rejects.toThrow('PAYMENT_INVALID_CAPTURE');
    await expect(
      completeManualCollection(scope, {
        attemptId: started.attempt.id,
        collectionToken: 'A'.repeat(43),
      })
    ).rejects.toThrow('PAYMENT_UNRESOLVED');
    expect(
      await completeManualCollection(scope, {
        attemptId: started.attempt.id,
        collectionToken: started.collectionToken!,
      })
    ).toMatchObject({ settled: true });
  });

  it('binds displayed merchant instructions and refuses a stale configuration at completion', async () => {
    const f = await fixture();
    const started = await beginManualCollection(scope, {
      ...(await reservation(f)),
      businessDate,
    });
    expect(started.merchant).toMatchObject({ destination: 'Test till' });
    const prior = await transaction((db) =>
      db.pharmacyBranch.findUniqueOrThrow({ where: { id: branch } })
    );
    try {
      await transaction((db) =>
        db.pharmacyBranch.update({
          where: { id: branch },
          data: {
            manualPaymentSettings: {
              JAZZCASH: { destination: 'Changed till', allowReferenceSkip: false },
            },
            manualPaymentRevision: { increment: 1 },
          },
        })
      );
      await expect(
        completeManualCollection(scope, {
          attemptId: started.attempt.id,
          collectionToken: started.collectionToken!,
          ...capture,
        })
      ).rejects.toThrow('PAYMENT_UNRESOLVED');
      expect((await counts(f.sale.id)).tenders).toBe(0);
      expect(
        await recoverPaymentCollection(manager, { attemptId: started.attempt.id })
      ).toMatchObject({
        state: 'EXPOSED',
        canResolve: true,
      });
      await expect(
        transaction((db) =>
          db.pharmacySaleLine.updateMany({
            where: { saleId: f.sale.id },
            data: { discountMinor: 1 },
          })
        )
      ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
      expect(
        await resolveManualCollection(manager, {
          attemptId: started.attempt.id,
          decision: 'CONFIRM',
          reason: 'Checked funds against the original displayed till',
          ...capture,
        })
      ).toMatchObject({ state: 'SETTLED' });
    } finally {
      await transaction((db) =>
        db.pharmacyBranch.update({
          where: { id: branch },
          data: {
            manualPaymentSettings: prior.manualPaymentSettings!,
            manualPaymentRevision: { increment: 1 },
          },
        })
      );
    }
  });

  it('keeps batch recall locks across provider dispatch and releases them after settlement', async () => {
    const f = await fixture();
    const request = { ...(await reservation(f)), method: 'CARD' as const, businessDate };
    const adapter = {
      name: 'CERTIFIED_TEST_PROVIDER',
      certified: true,
      execute: async () => {
        await expect(
          transaction((db) =>
            db.$queryRawUnsafe(
              'SELECT id FROM pharmacy_manufacturing_batches WHERE id=$1 FOR UPDATE NOWAIT',
              f.batches[0]!.id
            )
          )
        ).rejects.toThrow('could not obtain lock');
        return { approved: true, providerRef: 'batch-lock-test-response' };
      },
    };
    expect(await collectProviderPayment(scope, request, adapter)).toMatchObject({ settled: true });
    expect(
      await transaction((db) =>
        db.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM pharmacy_manufacturing_batches WHERE id=$1 FOR UPDATE NOWAIT',
          f.batches[0]!.id
        )
      )
    ).toHaveLength(1);
  });

  it('never calls a provider again after an external success with lost acknowledgement', async () => {
    const f = await fixture();
    let calls = 0;
    const request = { ...(await reservation(f)), method: 'CARD' as const, businessDate };
    const adapter = {
      name: 'CERTIFIED_TEST_PROVIDER',
      certified: true,
      execute: async () => {
        calls++;
        throw new Error('SYNTHETIC_SUCCESS_ACK_LOST');
      },
    };
    await expect(collectProviderPayment(scope, request, adapter)).rejects.toThrow(
      'SYNTHETIC_SUCCESS_ACK_LOST'
    );
    const recovered = await recoverPaymentCollection(scope, {
      saleId: f.sale.id,
      deviceId: request.deviceId,
      requestKey: request.requestKey,
    });
    expect(recovered).toMatchObject({ state: 'UNKNOWN', canResolve: false });
    await expect(collectProviderPayment(scope, request, adapter)).rejects.toThrow(
      'PAYMENT_UNRESOLVED'
    );
    expect(calls).toBe(1);
    expect((await counts(f.sale.id)).tenders).toBe(0);
    await expect(
      resolveManualCollection(manager, {
        attemptId: recovered!.id,
        decision: 'CONFIRM',
        reason: 'Cannot manually confirm a card',
      })
    ).rejects.toThrow('PAYMENT_METHOD_NOT_SETUP');
    await expect(
      transaction((db) =>
        db.pharmacySaleLine.updateMany({ where: { saleId: f.sale.id }, data: { discountMinor: 1 } })
      )
    ).rejects.toThrow('PAYMENT_ATTEMPT_UNRESOLVED');
  });

  it('recovers a committed certified approval after financial rollback without charging again', async () => {
    const f = await fixture();
    let calls = 0;
    const request = { ...(await reservation(f)), method: 'WALLET' as const, businessDate };
    const adapter = {
      name: 'CERTIFIED_TEST_PROVIDER',
      certified: true,
      execute: async () => {
        calls++;
        await transaction((db) =>
          db.medicine.update({ where: { id: f.medicine.id }, data: { productName: '' } })
        );
        return { approved: true, providerRef: 'real-test-adapter-response' };
      },
    };
    await expect(collectProviderPayment(scope, request, adapter)).rejects.toThrow(
      'INVALID_RECEIPT_IDENTITY'
    );
    expect((await counts(f.sale.id)).tenders).toBe(0);
    const recovered = await recoverPaymentCollection(scope, {
      saleId: f.sale.id,
      deviceId: request.deviceId,
      requestKey: request.requestKey,
    });
    expect(recovered?.state).toBe('CONFIRMED');
    await transaction((db) =>
      db.medicine.update({
        where: { id: f.medicine.id },
        data: { productName: 'Restored test medicine' },
      })
    );
    expect(await collectProviderPayment(scope, request, adapter)).toMatchObject({
      settled: true,
      replayed: false,
    });
    expect(await collectProviderPayment(scope, request, adapter)).toMatchObject({
      settled: true,
      replayed: true,
    });
    expect(calls).toBe(1);
    expect((await counts(f.sale.id)).tenders).toBe(1);
  });
});
