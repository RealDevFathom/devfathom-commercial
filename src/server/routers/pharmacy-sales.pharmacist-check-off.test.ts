import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-911: with the owner's pharmacist check switched off, a cashier sells a controlled
// medicine with no pharmacist step, and the controlled register still gets its entry, marked
// as written with the check switched off by the owner. With the check on nothing changes.
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
vi.mock('@/lib/pharmacy/controlled-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/controlled-register')>()),
  appendControlledSaleEntries: vi.fn(async () => undefined),
  lockRegister: vi.fn(async () => undefined),
}));

import { appendControlledSaleEntries } from '@/lib/pharmacy/controlled-register';
import { addSaleLine } from '@/lib/pharmacy/sales';
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
};

type Stored = 'ON' | 'OFF' | 'MISSING';

function cashierCaller(stored: Stored, requireSecondPharmacist = false) {
  const credential = vi.fn();
  const policy = vi.fn(async () =>
    stored === 'MISSING'
      ? null
      : { pharmacistCheckEnabled: stored === 'ON', pharmacistCheckPolicyVersion: 4 }
  );
  const db = {
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacySaleLine: { findFirst: vi.fn(async () => null) },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      Array.isArray(strings) && strings.join(' ').includes('"requireSecondPharmacist"')
        ? [{ requireSecondPharmacist }]
        : []
    ),
    pharmacyBranch: {
      findMany: async () => [{ id: 'branch-1' }],
      findFirst: async () => ({ id: 'branch-1' }),
    },
    pharmacyBranchAssignment: { findMany: async () => [{ branchId: 'branch-1' }] },
    medicine: {
      findFirst: async () => ({ id: 'medicine-1', controlled: true, manufacturer: 'Maker' }),
    },
    user: {
      findUnique: async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    restaurantOperatorCredential: { findFirst: credential },
    pharmacyOwnerPolicy: { findUnique: policy },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, credential, policy, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.mocked(addSaleLine).mockReset();
  vi.mocked(appendControlledSaleEntries).mockClear();
  vi.mocked(annotateAudit).mockClear();
});

describe('pharmacySales.addLine with the owner’s pharmacist check', () => {
  it('lets a cashier add a controlled line with no pharmacist step while it is off', async () => {
    const f = cashierCaller('OFF');
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'sale-line-1' },
      allocation: { movementIds: ['movement-1', 'movement-2'] },
    } as never);

    await expect(f.caller.addLine(line)).resolves.toMatchObject({ line: { id: 'sale-line-1' } });

    expect(f.policy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } })
    );
    expect(f.credential).not.toHaveBeenCalled();
    expect(addSaleLine).toHaveBeenCalledTimes(1);
    // The register still gets its entry for the controlled sale, marked with the policy
    // version that switched the check off. Nobody else witnessed it.
    expect(appendControlledSaleEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: 'org-1',
        branchId: 'branch-1',
        movementIds: ['movement-1', 'movement-2'],
        medicineId: 'medicine-1',
        patientId: null,
        prescriptionLineId: null,
        emergency: false,
        recordedByUserId: 'cashier-1',
        witnessedByUserId: 'cashier-1',
        signatureRef: 'pharmacist-check-off:v4',
      })
    );
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ pharmacistCheck: 'SWITCHED_OFF_BY_OWNER' }),
      })
    );
  });

  it.each<Stored>(['ON', 'MISSING'])(
    'refuses the cashier exactly as before when the setting is %s',
    async (stored) => {
      const f = cashierCaller(stored);
      await expect(f.caller.addLine(line)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'You do not have permission to dispense a controlled medicine.',
      });
      expect(addSaleLine).not.toHaveBeenCalled();
      expect(appendControlledSaleEntries).not.toHaveBeenCalled();
    }
  );

  it('keeps the check on when the setting cannot be read', async () => {
    const f = cashierCaller('OFF');
    f.policy.mockRejectedValueOnce(new Error('read failed'));
    await expect(f.caller.addLine(line)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('lets a cashier add a prescription-only line with no prescription while it is off', async () => {
    const f = cashierCaller('OFF');
    Object.assign(f.db.medicine, {
      findFirst: async () => ({
        id: 'medicine-1',
        controlled: false,
        rx: true,
        restricted: false,
        manufacturer: 'Maker',
      }),
    });
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'sale-line-rx' },
      allocation: { movementIds: ['movement-1'] },
    } as never);
    await expect(f.caller.addLine(line)).resolves.toMatchObject({ line: { id: 'sale-line-rx' } });
    expect(appendControlledSaleEntries).not.toHaveBeenCalled();

    // Back on: the same cashier is refused the prescription-only line again.
    f.policy.mockResolvedValue({ pharmacistCheckEnabled: true, pharmacistCheckPolicyVersion: 5 });
    await expect(
      f.caller.addLine({ ...line, idempotencyKey: 'counter:sale-1:rx-2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(addSaleLine).toHaveBeenCalledTimes(1);
  });

  it('returns at once when the owner turns the check back on', async () => {
    const f = cashierCaller('OFF');
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'sale-line-1' },
      allocation: { movementIds: ['movement-1'] },
    } as never);
    await f.caller.addLine(line);
    f.policy.mockResolvedValue({ pharmacistCheckEnabled: true, pharmacistCheckPolicyVersion: 5 });
    await expect(
      f.caller.addLine({ ...line, idempotencyKey: 'counter:sale-1:controlled-2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(addSaleLine).toHaveBeenCalledTimes(1);
  });
});

it('DEV-1043 refuses a cashier requesting solo controlled approval even with the business check OFF', async () => {
  const { caller } = cashierCaller('OFF');
  await expect(
    caller.addLine({
      ...line,
      controlledAuthorization: {
        patientId: 'patient-1',
        patientAddress: '12 Synthetic Street',
        staffProfileId: 'cashier-profile',
        pin: '1234',
        selfApproval: true,
        rxSerialWritten: true,
        emergency: false,
        prescriptionLineId: 'rx-1',
      },
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(addSaleLine).not.toHaveBeenCalled();
});

it('DEV-1043 requires an independent pharmacist at an opted-in branch even when the business check is OFF', async () => {
  const f = cashierCaller('OFF', true);
  await expect(f.caller.addLine(line)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(addSaleLine).not.toHaveBeenCalled();
  expect(appendControlledSaleEntries).not.toHaveBeenCalled();
});
