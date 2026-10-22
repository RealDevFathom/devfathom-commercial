/**
 * #523 — the counter return panel's controlled-medicine contract, against PostgreSQL as a
 * NOSUPERUSER NOBYPASSRLS role.
 *
 * - returnHistory marks a controlled line, so the panel knows to ask for a witness;
 * - returnWitnesses lists independent pharmacists with an active staff PIN to a pharmacist actor,
 *   never the actor, and nobody to a cashier (who cannot record a controlled return);
 * - returnLine answers a missing or wrong witness PIN with `{ blocked }`, records nothing, and
 *   keeps the failed PIN attempt, which is why the panel must treat `{ blocked }` as a failure.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  org: `org_r523_${suffix}`,
  branch: `br_r523_${suffix}`,
  rolePharmacist: `role_r523_pharm_${suffix}`,
  roleCashier: `role_r523_cash_${suffix}`,
  actor: `user_r523_actor_${suffix}`,
  witness: `user_r523_witness_${suffix}`,
  cashier: `user_r523_cashier_${suffix}`,
  actorStaff: `staff_r523_actor_${suffix}`,
  witnessStaff: `staff_r523_witness_${suffix}`,
  sale: `sale_r523_${suffix}`,
  controlledLine: `line_r523_ctl_${suffix}`,
  ordinaryLine: `line_r523_otc_${suffix}`,
};
const WITNESS_PIN = '4821';

type Session = { id: string; role: 'ADMIN' | 'EMPLOYEE' };
type SalesCaller = {
  returnHistory: (input: { branchId: string; saleId: string }) => Promise<{
    lines: Array<{ id: string; controlled: boolean }>;
  }>;
  returnWitnesses: (input: { branchId: string }) => Promise<{
    actorCanDispense: boolean;
    witnesses: Array<{ id: string; name: string }>;
  }>;
  returnLine: (input: {
    branchId: string;
    saleLineId: string;
    canonicalUnits: number;
    reason: string;
    integrityDecision: string;
    idempotencyKey: string;
    controlledWitness?: { staffProfileId: string; pin: string };
  }) => Promise<unknown>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;

function act<T>(user: Session, run: (api: SalesCaller) => Promise<T>) {
  return withTenantDb(
    ids.org,
    (db) =>
      run(
        pharmacySalesRouter.createCaller({
          db,
          entitlements: {
            organizationId: ids.org,
            enabledModules: ['pharmacy-counter'],
            modules: [],
            limits: {},
            seatLimit: 10,
            activeSeats: 1,
          },
          session: {
            expires: 'later',
            user: {
              id: user.id,
              role: user.role,
              department: 'LEADERSHIP',
              status: 'ACTIVE',
              organizationId: ids.org,
            },
          },
          organization: { id: ids.org, vertical: 'PHARMACY' },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as never) as SalesCaller
      ),
    { timeout: 60_000, userId: user.id }
  );
}

const actor: Session = { id: ids.actor, role: 'EMPLOYEE' };
const cashier: Session = { id: ids.cashier, role: 'EMPLOYEE' };

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = sales.pharmacySalesRouter;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Witness', 'Witness', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );
  const pinHash = await hashOperatorCredential('PIN', WITNESS_PIN);

  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: {
        id: ids.branch,
        code: 'W',
        name: 'Witness counter',
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.rolePharmacist,
        key: ids.rolePharmacist,
        name: 'Pharmacist',
        permissions: {
          create: [
            { capability: 'pharmacy:dispense', effect: 'ALLOW' },
            { capability: 'pharmacy:counter', effect: 'ALLOW' },
          ],
        },
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.roleCashier,
        key: ids.roleCashier,
        name: 'Cashier',
        permissions: { create: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
      },
    });
    for (const [id, roleId] of [
      [ids.actor, ids.rolePharmacist],
      [ids.witness, ids.rolePharmacist],
      [ids.cashier, ids.roleCashier],
    ] as const) {
      await tx.user.create({
        data: {
          id,
          name: id,
          email: `${id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          organizationRoleId: roleId,
        },
      });
      await tx.pharmacyBranchAssignment.create({ data: { userId: id, branchId: ids.branch } });
    }
    // Both pharmacists hold an active staff PIN; only the other one may witness.
    for (const [staffId, userId, name] of [
      [ids.actorStaff, ids.actor, 'Acting Pharmacist'],
      [ids.witnessStaff, ids.witness, 'Witness Pharmacist'],
    ] as const) {
      await tx.restaurantStaffProfile.create({
        data: { id: staffId, userId, displayName: name },
      });
      await tx.restaurantOperatorCredential.create({
        data: { staffProfileId: staffId, type: 'PIN', credentialHash: pinHash },
      });
    }
    const medicine = async (label: string, controlled: boolean) => {
      const created = await tx.medicine.create({
        data: {
          productName: `${label} ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          controlled,
          presentations: { create: { presentation: 'Tablet, 10 per strip' } },
        },
        include: { presentations: true },
      });
      const pack = await tx.packLevel.create({
        data: {
          presentationId: created.presentations[0]!.id,
          versionGroupId: `strip-${label}-${suffix}`,
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      return { id: created.id, presentationId: created.presentations[0]!.id, packId: pack.id };
    };
    const morphine = await medicine('Morphine', true);
    const paracetamol = await medicine('Paracetamol', false);
    await tx.pharmacySale.create({
      data: {
        id: ids.sale,
        branchId: ids.branch,
        status: 'COMPLETED',
        createdByUserId: ids.actor,
        receiptNumber: 3,
        receiptDeviceId: 'device-w',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        completedAt: new Date('2026-10-01T08:00:00.000Z'),
      },
    });
    for (const [lineId, item] of [
      [ids.controlledLine, morphine],
      [ids.ordinaryLine, paracetamol],
    ] as const) {
      await tx.pharmacySaleLine.create({
        data: {
          id: lineId,
          branchId: ids.branch,
          saleId: ids.sale,
          medicineId: item.id,
          presentationId: item.presentationId,
          packLevelId: item.packId,
          saleUnit: 'STRIP',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 10,
          canonicalUnits: 10,
          unitPriceMinor: 500,
          proRataCeilingMinor: 500,
          unitCostMinor: 300,
          idempotencyKey: `seed-${lineId}`,
        },
      });
    }
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('controlled return witness contract (#523)', () => {
  it('marks the controlled line in the return history', async () => {
    const history = await act(cashier, (api) =>
      api.returnHistory({ branchId: ids.branch, saleId: ids.sale })
    );
    const flags = Object.fromEntries(history.lines.map((line) => [line.id, line.controlled]));
    expect(flags).toEqual({ [ids.controlledLine]: true, [ids.ordinaryLine]: false });
  });

  it('lists the other PIN pharmacist to a pharmacist and nobody to a cashier', async () => {
    await expect(
      act(actor, (api) => api.returnWitnesses({ branchId: ids.branch }))
    ).resolves.toEqual({
      actorCanDispense: true,
      witnesses: [{ id: ids.witnessStaff, name: 'Witness Pharmacist' }],
    });
    await expect(
      act(cashier, (api) => api.returnWitnesses({ branchId: ids.branch }))
    ).resolves.toEqual({ actorCanDispense: false, witnesses: [] });
  });

  it('answers a missing or wrong witness PIN with blocked, records nothing, keeps the attempt', async () => {
    const input = {
      branchId: ids.branch,
      saleLineId: ids.controlledLine,
      canonicalUnits: 1,
      reason: 'WRONG_ITEM',
      integrityDecision: 'Sealed strip',
    };
    await expect(
      act(actor, (api) => api.returnLine({ ...input, idempotencyKey: randomUUID() }))
    ).resolves.toEqual({ blocked: 'A different pharmacist must enter a fresh witness PIN.' });
    await expect(
      act(actor, (api) =>
        api.returnLine({
          ...input,
          idempotencyKey: randomUUID(),
          controlledWitness: { staffProfileId: ids.witnessStaff, pin: '0000' },
        })
      )
    ).resolves.toEqual({ blocked: 'A different pharmacist must enter a fresh witness PIN.' });
    // The actor cannot witness their own return, even with their own correct PIN.
    await expect(
      act(actor, (api) =>
        api.returnLine({
          ...input,
          idempotencyKey: randomUUID(),
          controlledWitness: { staffProfileId: ids.actorStaff, pin: WITNESS_PIN },
        })
      )
    ).resolves.toEqual({ blocked: 'A different pharmacist must enter a fresh witness PIN.' });
    // A cashier cannot record a controlled return at all.
    await expect(
      act(cashier, (api) =>
        api.returnLine({
          ...input,
          idempotencyKey: randomUUID(),
          controlledWitness: { staffProfileId: ids.witnessStaff, pin: WITNESS_PIN },
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Dispense permission is required.' });

    const state = await withTenantDb(ids.org, async (tx) => ({
      returns: await tx.pharmacySaleReturn.count({ where: { originalSaleId: ids.sale } }),
      credential: await tx.restaurantOperatorCredential.findFirst({
        where: { staffProfileId: ids.witnessStaff },
        select: { failedAttempts: true },
      }),
    }));
    expect(state.returns).toBe(0);
    expect(state.credential?.failedAttempts).toBe(1);
  });
});
