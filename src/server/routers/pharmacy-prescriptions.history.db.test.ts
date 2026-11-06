/** Requires the disposable, seeded pharmacy E2E database and restricted runtime role. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PHARMACY_E2E as fixture } from '../../../tests/e2e/pharmacy-counter-fixture';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});
const enabled = Boolean(url && process.env.PHARMACY_E2E === '1');
const suffix = randomUUID().slice(0, 8);
const patientId = `hist_patient_${suffix}`;
const customerId = `hist_customer_${suffix}`;
const saleId = `hist_sale_${suffix}`;
const unlinkedId = `hist_unlinked_${suffix}`;
const otherBranch = `hist_branch_${suffix}`;
const otherOrg = `hist_org_${suffix}`;
const otherPatient = `hist_other_${suffix}`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let router: typeof import('./pharmacy-prescriptions').pharmacyPrescriptionsRouter;
let writeConsent: typeof import('@/lib/pharmacy/consent-writer').writePatientConsent;
const tenant = fixture.organizationId;
const actor = fixture.adminId;

function caller(db: unknown, userId: string = actor, role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN') {
  return router.createCaller({
    db,
    entitlements: {
      organizationId: tenant,
      enabledModules: ['pharmacy-counter', 'pharmacy-dispensing'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: tenant,
      },
    },
    organization: { id: tenant, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}
const act = <T>(f: (db: import('@/lib/tenancy/scoped-db').ScopedDb) => Promise<T>) =>
  withTenantDb(tenant, f, { userId: actor, timeout: 60000 });
const read = (
  userId: string = actor,
  role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN',
  branchId: string = fixture.branchId,
  patient = patientId
) => act((db) => caller(db, userId, role).counterPurchaseHistory({ patientId: patient, branchId }));
const consent = (
  purpose: 'LOYALTY' | 'DISPENSING',
  channel: 'IN_PERSON' | 'PHONE',
  granted: boolean,
  at: string
) =>
  act((db) =>
    writeConsent(db, tenant, actor, { patientId, purpose, channel, granted }, new Date(at))
  );

describe.skipIf(!enabled)('counter patient purchase history restricted database', () => {
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
    await scoped.withPlatformDb(async (db) => {
      await db.organization.create({
        data: {
          id: otherOrg,
          slug: otherOrg,
          legalName: 'Synthetic other',
          displayName: 'Synthetic other',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          deploymentMode: 'SHARED',
        },
      });
    });
    await scoped.withTenantDb(otherOrg, async (db) => {
      await db.pharmacyPatient.create({
        data: { id: otherPatient, organizationId: otherOrg, displayName: 'Synthetic other' },
      });
    });
    ({ pharmacyPrescriptionsRouter: router } = await import('./pharmacy-prescriptions'));
    ({ writePatientConsent: writeConsent } = await import('@/lib/pharmacy/consent-writer'));
    await act(async (db) => {
      const [role] = await db.$queryRaw<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await db.pharmacyBranchAssignment.upsert({
        where: {
          organizationId_branchId_userId: {
            organizationId: tenant,
            branchId: fixture.branchId,
            userId: actor,
          },
        },
        create: { organizationId: tenant, branchId: fixture.branchId, userId: actor, active: true },
        update: { active: true },
      });
      await db.pharmacyPatient.create({
        data: {
          id: patientId,
          organizationId: tenant,
          displayName: 'Synthetic History',
          phone: '03001111457',
        },
      });
      await db.pharmacyPatient.create({
        data: {
          id: unlinkedId,
          organizationId: tenant,
          displayName: 'Synthetic History',
          phone: '03001111457',
        },
      });
      await db.pharmacyBranch.create({
        data: {
          id: otherBranch,
          organizationId: tenant,
          code: otherBranch,
          name: 'Synthetic branch',
          addressLine: 'Test',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      await db.pharmacyCustomer.create({
        data: {
          id: customerId,
          organizationId: tenant,
          patientId,
          displayName: 'Synthetic History',
        },
      });
      await db.pharmacySale.create({
        data: {
          id: saleId,
          organizationId: tenant,
          branchId: fixture.branchId,
          createdByUserId: actor,
          customerId,
          status: 'COMPLETED',
          completedAt: new Date('2026-10-01T00:00:00Z'),
        },
      });
      await db.pharmacySale.create({
        data: {
          id: `other_sale_${suffix}`,
          organizationId: tenant,
          branchId: otherBranch,
          createdByUserId: actor,
          customerId,
          status: 'COMPLETED',
          completedAt: new Date('2026-10-02T00:00:00Z'),
        },
      });
      await db.pharmacySaleLine.create({
        data: {
          organizationId: tenant,
          branchId: fixture.branchId,
          saleId,
          medicineId: fixture.medicines.otc.id,
          presentationId: fixture.medicines.otc.presentationId,
          packLevelId: fixture.medicines.otc.packLevelIds.unit,
          saleUnit: 'UNIT',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 1,
          canonicalUnits: 1,
          unitPriceMinor: 100,
          grossMinor: 100,
          proRataCeilingMinor: 100,
          unitCostMinor: 50,
          idempotencyKey: `history_${suffix}`,
        },
      });
    });
  }, 60000);
  it('requires both purpose grants and honors cross-channel revoke until rerecorded', async () => {
    expect((await read()).state).toBe('consent_needed');
    await consent('LOYALTY', 'IN_PERSON', true, '2026-01-01T00:00:00Z');
    expect((await read()).state).toBe('consent_needed');
    await consent('DISPENSING', 'IN_PERSON', true, '2026-01-02T00:00:00Z');
    expect(await read()).toMatchObject({
      state: 'ready',
      purchases: [{ saleId, medicines: [fixture.medicines.otc.name] }],
    });
    await act((db) =>
      writeConsent(
        db,
        tenant,
        actor,
        { patientId, purpose: 'MARKETING', channel: 'PHONE', granted: false },
        new Date('2026-01-15T00:00:00Z')
      )
    );
    expect((await read()).state).toBe('ready');
    await consent('LOYALTY', 'PHONE', false, '2026-02-01T00:00:00Z');
    expect((await read()).state).toBe('consent_needed');
    await consent('LOYALTY', 'IN_PERSON', true, '2026-03-01T00:00:00Z');
    expect((await read()).state).toBe('ready');
    await consent('DISPENSING', 'PHONE', false, '2026-04-01T00:00:00Z');
    expect((await read()).state).toBe('consent_needed');
  });
  it('serializes a history read behind a purpose revocation', async () => {
    await consent('DISPENSING', 'IN_PERSON', true, '2026-05-01T00:00:00Z');
    expect((await read()).state).toBe('ready');
    let release!: () => void;
    let locked!: () => void;
    const entered = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { lockPatientConsent } = await import('@/lib/pharmacy/consent-writer');
    const writer = act(async (db) => {
      await lockPatientConsent(db, tenant, patientId);
      locked();
      await gate;
      await writeConsent(
        db,
        tenant,
        actor,
        { patientId, purpose: 'LOYALTY', channel: 'PHONE', granted: false },
        new Date('2026-06-01T00:00:00Z')
      );
    });
    await entered;
    let resolved = false;
    const reading = read().then((result) => {
      resolved = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(resolved).toBe(false);
    } finally {
      release();
    }
    await writer;
    expect((await reading).state).toBe('consent_needed');
  });
  it('must not expose history when a later committed revoke has an earlier captured timestamp', async () => {
    let release!: () => void;
    let locked!: () => void;
    const entered = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { lockPatientConsent } = await import('@/lib/pharmacy/consent-writer');
    const grant = act(async (db) => {
      await lockPatientConsent(db, tenant, patientId);
      locked();
      await gate;
      await writeConsent(
        db,
        tenant,
        actor,
        { patientId, purpose: 'LOYALTY', channel: 'IN_PERSON', granted: true },
        new Date('2026-08-02T00:00:00Z')
      );
    });
    await entered;
    const revoke = act((db) =>
      writeConsent(
        db,
        tenant,
        actor,
        { patientId, purpose: 'LOYALTY', channel: 'PHONE', granted: false },
        new Date('2026-08-01T00:00:00Z')
      )
    );
    release();
    await grant;
    await revoke;
    expect((await read()).state).toBe('consent_needed');
  });
  it('sequences direct consent inserts as well as writer calls', async () => {
    await act((db) =>
      db.patientConsent.create({
        data: {
          organizationId: tenant,
          patientId,
          purpose: 'LOYALTY',
          channel: 'SMS',
          version: 1,
          granted: true,
          recordedByUserId: actor,
          recordedAt: new Date('2025-01-01T00:00:00Z'),
        },
      })
    );
    expect((await read()).state).toBe('ready');
    await act((db) =>
      db.patientConsent.create({
        data: {
          organizationId: tenant,
          patientId,
          purpose: 'LOYALTY',
          channel: 'EMAIL',
          version: 1,
          granted: false,
          revokedAt: new Date('2024-01-01T00:00:00Z'),
          recordedByUserId: actor,
          recordedAt: new Date('2024-01-01T00:00:00Z'),
        },
      })
    );
    expect((await read()).state).toBe('consent_needed');
  });
  it.skipIf(!process.env.PHARMACY_HISTORY_LEGACY_PATIENT_ID)(
    'withholds ambiguous legacy consent until its purpose is rerecorded',
    async () => {
      const legacy = process.env.PHARMACY_HISTORY_LEGACY_PATIENT_ID!;
      expect((await read(actor, 'ADMIN', fixture.branchId, legacy)).state).toBe('consent_needed');
      await act((db) =>
        writeConsent(db, tenant, actor, {
          patientId: legacy,
          purpose: 'LOYALTY',
          channel: 'PHONE',
          granted: true,
        })
      );
      expect((await read(actor, 'ADMIN', fixture.branchId, legacy)).state).toBe('not_linked');
    }
  );
  it('denies cashiers and unassigned branches and never infers a patient link', async () => {
    await expect(read(fixture.cashierId, 'EMPLOYEE')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(read(actor, 'ADMIN', otherBranch)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(read(actor, 'ADMIN', fixture.branchId, otherPatient)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('does not infer identity from matching patient details and does not audit medicine names', async () => {
    await act(async (db) => {
      for (const purpose of ['LOYALTY', 'DISPENSING'] as const)
        await writeConsent(
          db,
          tenant,
          actor,
          { patientId: unlinkedId, purpose, channel: 'IN_PERSON', granted: true },
          new Date('2026-01-02T00:00:00Z')
        );
    });
    const result = await read(actor, 'ADMIN', fixture.branchId, unlinkedId);
    expect(result).toEqual({ state: 'not_linked', purchases: [] });
    const audit = await act((db) =>
      db.auditLog.findFirst({
        where: { action: 'pharmacy.patient.purchase_history.read', targetId: unlinkedId },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain(fixture.medicines.otc.name);
    expect(JSON.stringify(result)).not.toContain('03001111457');
  });
});
