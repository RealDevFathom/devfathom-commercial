import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(),
}));
// DEV-629: the prescription reference rules have their own suites; here they resolve.
vi.mock('@/lib/pharmacy/rx-prescription-reference', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/rx-prescription-reference')>()),
  resolvePrescriptionReference: vi.fn(async () => ({
    prescriptionLineId: 'rx-line-1',
    patientId: 'patient-1',
  })),
  attachPrescriptionReference: vi.fn(async () => undefined),
}));
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(),
}));

import { addSaleLine } from '@/lib/pharmacy/sales';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

const line = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  saleUnit: 'UNIT' as const,
  quantity: 2,
  canonicalUnitsPerSaleUnit: 1,
  idempotencyKey: 'counter:sale-1:controlled',
  controlledAuthorization: {
    patientId: 'patient-1',
    patientAddress: '12 Mall Road, Gulberg',
    staffProfileId: 'witness-staff',
    pin: '1234',
    rxSerialWritten: true,
    emergency: true,
    prescriberName: 'Dr Khan',
  },
};

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };
const COUNTER_GATE_DENIED = 'You do not have permission for this action.';

function callerFor(
  permissions: Permission[],
  permissionOverrides: Permission[] = [],
  organization: { id: string; timezone?: string } = { id: 'org-1' }
) {
  const credential = vi.fn();
  const register = vi.fn();
  const lock = vi.fn();
  const db = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    $queryRaw: lock,
    pharmacyBranch: {
      findMany: async () => [{ id: 'branch-1' }],
      findFirst: async () => ({ id: 'branch-1' }),
    },
    // DEV-607: addLine admits only an active member assigned to the branch.
    pharmacyBranchAssignment: { findMany: async () => [{ branchId: 'branch-1' }] },
    branchRegulatoryProfile: {
      findFirst: async () => ({
        branchId: 'branch-1',
        provinceCode: 'PK-PB',
        premises: { addressLine: '12 Mall Road', city: 'Lahore' },
        branch: {
          active: true,
          provinceCode: 'PB',
          addressLine: '12 Mall Road',
          city: 'Lahore',
        },
        licenceCategory: 'PHARMACY',
        licenceValidFrom: new Date('2020-01-01T00:00:00.000Z'),
        licenceValidTo: new Date('2100-01-01T00:00:00.000Z'),
        licenceEvidenceFileRef: 'evidence://pharmacy-licence',
        permittedSchedules: ['*'],
        qualifiedPersonRegistration: 'QP-1',
        qualifiedPersonValidFrom: new Date('2020-01-01T00:00:00.000Z'),
        qualifiedPersonValidTo: new Date('2100-01-01T00:00:00.000Z'),
        qualifiedPersonCoverageRosterRef: 'roster-1',
        jurisdictionRuleSet: {
          licenceCategories: { provisional: false, values: ['PHARMACY'] },
          permittedSchedules: { provisional: false, values: ['*'] },
          pharmacistCoverageRule: { provisional: false },
        },
      }),
    },
    medicine: {
      findFirst: async () => ({ id: 'medicine-1', controlled: true, manufacturer: 'Maker' }),
    },
    user: {
      findUnique: async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions },
        permissionOverrides,
      }),
    },
    restaurantOperatorCredential: { findFirst: credential },
    pharmacyControlledRegisterEntry: { create: register, findFirst: vi.fn(), aggregate: vi.fn() },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, credential, register, lock, caller: app.createCaller(context).pharmacySales };
}

function emergencyCallerFor(
  jurisdictionRuleSet: { id: string; controlledRegisterFlags: unknown } | null,
  organization?: { id: string; timezone?: string }
) {
  const fixture = callerFor(
    [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
    [],
    organization
  );
  vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
  fixture.credential.mockResolvedValue({
    id: 'credential-1',
    credentialHash: 'hash',
    failedAttempts: 0,
    lockedUntil: null,
    staffProfile: {
      status: 'ACTIVE',
      user: { id: 'pharmacist-1', organizationId: 'org-1', status: 'ACTIVE', role: 'EMPLOYEE' },
    },
  });
  const profile = vi.fn().mockResolvedValue({ provinceCode: 'PB', jurisdictionRuleSet });
  const recentSupplies = vi.fn().mockResolvedValue(0);
  const openFollowUp = vi.fn().mockResolvedValue(null);
  const consent = vi.fn().mockResolvedValue(null);
  Object.assign(fixture.db.restaurantOperatorCredential, { update: vi.fn() });
  Object.assign(fixture.db.branchRegulatoryProfile, { findFirst: profile });
  Object.assign(fixture.db.pharmacyControlledRegisterEntry, { count: recentSupplies });
  Object.assign(fixture.db, {
    pharmacyPatient: {
      findFirst: async () => ({ id: 'patient-1', cnic: '35202-1234567-1' }),
    },
    pharmacyEmergencyRxFollowUp: { findFirst: openFollowUp },
    patientConsent: { findFirst: consent },
  });
  return { ...fixture, profile, recentSupplies, openFollowUp, consent };
}

beforeEach(() => {
  vi.mocked(addSaleLine).mockReset();
  vi.mocked(annotateAudit).mockClear();
});

describe('pharmacySales.addLine controlled actor', () => {
  it('denies a cashier before the witness PIN and writes no register row', async () => {
    const { caller, credential, register, lock } = callerFor([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ]);
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to dispense a controlled medicine.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it('honors an explicit ABAC deny even when the role grants dispense', async () => {
    const { caller, credential, register } = callerFor(
      [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
      [{ capability: 'pharmacy:dispense', effect: 'DENY' }]
    );
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      // DEV-607: an explicit DENY on a counter alias is refused by the counter gate first.
      message: COUNTER_GATE_DENIED,
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it.each(['pharmacy:dispense', 'pharmacy:*', '*'])(
    'honors a role DENY for %s even when an override grants dispense',
    async (capability) => {
      const { caller, credential, register, lock } = callerFor(
        [{ capability, effect: 'DENY' }],
        [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]
      );
      await expect(caller.addLine(line)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        // DEV-607: the DENY covers a counter alias, so the counter gate refuses first.
        message: COUNTER_GATE_DENIED,
      });
      expect(lock).not.toHaveBeenCalled();
      expect(credential).not.toHaveBeenCalled();
      expect(addSaleLine).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    }
  );

  it('does not treat the legacy dotted capability as a dispense grant', async () => {
    const { caller, credential, register } = callerFor([
      { capability: 'pharmacy.dispense', effect: 'ALLOW' },
    ]);
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to dispense a controlled medicine.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('accepts the canonical exact dispense capability at the actor check', async () => {
    const { caller, credential, register } = callerFor([
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
    ]);
    const { controlledAuthorization, ...plain } = line;
    void controlledAuthorization;
    await expect(caller.addLine(plain)).resolves.toEqual({
      blocked:
        'Controlled medicine requires the patient address, an independent pharmacist PIN, and either a valid prescription or an emergency supply with the prescriber name.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('checks the independent witness after accepting an authorized actor', async () => {
    const { caller, credential, register, lock } = callerFor([
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
    ]);
    credential.mockResolvedValue(null);

    await expect(caller.addLine(line)).resolves.toEqual({
      blocked:
        'Controlled medicine requires the patient address, an independent pharmacist PIN, and either a valid prescription or an emergency supply with the prescriber name.',
    });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(credential).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org-1',
        staffProfileId: 'witness-staff',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
      },
      include: { staffProfile: { include: { user: true } } },
    });
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('enforces the branch rule-set emergency cap and audits the policy it used', async () => {
    const { caller, register, profile } = emergencyCallerFor({
      id: 'pk_pb_v2',
      controlledRegisterFlags: {
        values: { emergencySupply: { maxUnits: 1, repeatWindowHours: 24 } },
      },
    });

    await expect(caller.addLine(line)).resolves.toEqual({
      blocked: expect.stringMatching(/limited to 1 units/),
    });
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(profile).toHaveBeenCalledOnce();
    const { where } = profile.mock.calls[0][0];
    expect(where).toMatchObject({ organizationId: 'org-1', branchId: 'branch-1' });
    expect(where).not.toHaveProperty('jurisdictionRuleSet');
    expect(annotateAudit).toHaveBeenCalledWith(expect.anything(), {
      metadata: {
        emergencySupply: {
          ruleSetId: 'pk_pb_v2',
          provinceCode: 'PB',
          source: 'JURISDICTION_RULE_SET',
          maxUnits: 1,
          repeatWindowHours: 24,
          medicineId: 'medicine-1',
          requestedCanonicalUnits: 2,
        },
      },
    });
  });

  it.each([24, 96])(
    'uses a configured %i-hour repeat window and permits units above the legacy cap',
    async (repeatWindowHours) => {
      const { caller, register, profile, recentSupplies, consent } = emergencyCallerFor({
        id: 'pk_pb_v2',
        controlledRegisterFlags: {
          values: { emergencySupply: { maxUnits: 20, repeatWindowHours } },
        },
      });

      // Stop at the independent consent guard after emergency eligibility succeeds.
      await expect(caller.addLine({ ...line, quantity: 12 })).resolves.toEqual({
        blocked: 'Patient dispensing consent is required.',
      });
      expect(consent).toHaveBeenCalledOnce();
      const now = profile.mock.calls[0][0].where.effectiveFrom.lte as Date;
      expect(profile).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          branchId: 'branch-1',
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        select: {
          provinceCode: true,
          jurisdictionRuleSet: { select: { id: true, controlledRegisterFlags: true } },
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      expect(recentSupplies).toHaveBeenCalledExactlyOnceWith({
        where: {
          organizationId: 'org-1',
          patientId: 'patient-1',
          medicineId: 'medicine-1',
          entryKind: 'SALE',
          emergency: true,
          createdAt: { gte: new Date(now.getTime() - repeatWindowHours * 60 * 60 * 1000) },
        },
      });
      expect(annotateAudit).toHaveBeenCalledWith(expect.anything(), {
        metadata: {
          emergencySupply: {
            ruleSetId: 'pk_pb_v2',
            provinceCode: 'PB',
            source: 'JURISDICTION_RULE_SET',
            maxUnits: 20,
            repeatWindowHours,
            medicineId: 'medicine-1',
            requestedCanonicalUnits: 12,
          },
        },
      });
      expect(addSaleLine).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    }
  );

  it.each([null, { id: 'legacy', controlledRegisterFlags: {} }])(
    'audits the legacy default when the rule-set policy is absent: %j',
    async (ruleSet) => {
      const { caller, profile, recentSupplies, consent } = emergencyCallerFor(ruleSet);

      await expect(caller.addLine({ ...line, quantity: 11 })).resolves.toEqual({
        blocked: expect.stringMatching(/limited to 10 units/),
      });
      const now = profile.mock.calls[0][0].where.effectiveFrom.lte as Date;
      expect(recentSupplies).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          patientId: 'patient-1',
          medicineId: 'medicine-1',
          entryKind: 'SALE',
          emergency: true,
          createdAt: { gte: new Date(now.getTime() - 72 * 60 * 60 * 1000) },
        },
      });
      expect(annotateAudit).toHaveBeenCalledWith(expect.anything(), {
        metadata: {
          emergencySupply: {
            ruleSetId: ruleSet?.id ?? null,
            provinceCode: 'PB',
            source: 'DEFAULT_POLICY',
            maxUnits: 10,
            repeatWindowHours: 72,
            medicineId: 'medicine-1',
            requestedCanonicalUnits: 11,
          },
        },
      });
      expect(consent).not.toHaveBeenCalled();
      expect(addSaleLine).not.toHaveBeenCalled();
    }
  );

  it('locks the sale row before the register lock, then dispenses (DEV-825)', async () => {
    const { caller, lock, consent } = emergencyCallerFor(null);
    consent.mockResolvedValue({ granted: true, revokedAt: null });
    vi.mocked(addSaleLine).mockRejectedValue(new Error('stop after the lock order'));

    await expect(caller.addLine(line)).rejects.toBeDefined();
    const sql = lock.mock.calls.map(([strings]) => (strings as string[]).join('?'));
    const saleLock = sql.findIndex((text) => text.includes('FROM pharmacy_sales'));
    const registerLock = sql.findIndex(
      (text, index) =>
        text.includes('pg_advisory_xact_lock') &&
        lock.mock.calls[index]!.slice(1).join('') === 'org-1:branch-1'
    );
    expect(saleLock).toBeGreaterThanOrEqual(0);
    expect(lock.mock.calls[saleLock]!.slice(1)).toEqual(['sale-1', 'org-1', 'branch-1']);
    expect(registerLock).toBeGreaterThan(saleLock);
    expect(lock.mock.invocationCallOrder[registerLock]).toBeLessThan(
      vi.mocked(addSaleLine).mock.invocationCallOrder[0]!
    );
  });
});

describe('emergency supply rules on a profile start day (DEV-298)', () => {
  it.each([
    ['00:30 PKT on the start day', '2026-10-20T19:30:00.000Z', '2026-10-21T00:00:00.000Z'],
    ['23:59 PKT the day before', '2026-10-20T18:59:00.000Z', '2026-10-20T18:59:00.000Z'],
  ])('reads the profile in force on the workspace day at %s', async (_label, now, asOf) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    try {
      const { caller, profile } = emergencyCallerFor(
        {
          id: 'pk_pb_v2',
          controlledRegisterFlags: {
            values: { emergencySupply: { maxUnits: 1, repeatWindowHours: 24 } },
          },
        },
        { id: 'org-1', timezone: 'Asia/Karachi' }
      );
      await caller.addLine(line);
      expect(profile).toHaveBeenCalledOnce();
      expect(profile.mock.calls[0][0].where).toMatchObject({
        organizationId: 'org-1',
        branchId: 'branch-1',
        effectiveFrom: { lte: new Date(asOf) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date(asOf) } }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pharmacySales.addLine prescription reference (DEV-629)', () => {
  it('queues the pharmacist review that settlement waits on when a pharmacist attaches a prescription', async () => {
    const { caller, db } = callerFor([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
    ]);
    db.medicine.findFirst = async () =>
      ({
        id: 'medicine-1',
        controlled: false,
        rx: true,
        restricted: false,
        manufacturer: 'Maker',
      }) as never;
    const review = vi.fn().mockResolvedValue({ id: 'review-1' });
    Object.assign(db, { pharmacyPharmacistReviewItem: { create: review } });
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'sale-line-1' } } as never);
    await caller.addLine({
      ...line,
      controlledAuthorization: undefined,
      idempotencyKey: 'counter:sale-1:rx',
      prescription: { prescriptionLineId: 'rx-line-1', patientId: 'patient-1' },
    });
    expect(review).toHaveBeenCalledExactlyOnceWith({
      data: {
        organizationId: 'org-1',
        prescriptionLineId: 'rx-line-1',
        saleLineId: 'sale-line-1',
        requestedByUserId: 'cashier-1',
      },
    });
  });
});
