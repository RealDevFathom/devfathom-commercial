import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async () => ({
  // The integrated addLine labels its audit row through the real merge helper.
  annotateAudit: (await vi.importActual<typeof import('@/server/audit')>('@/server/audit'))
    .annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => false),
}));
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(),
}));
vi.mock('@/lib/pharmacy/stock-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/stock-ledger')>()),
  onHand: vi.fn(),
}));

import { can } from '@/lib/abac';
import { addSaleLine } from '@/lib/pharmacy/sales';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

const line = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  medicineId: 'medicine-rx',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  saleUnit: 'STRIP' as const,
  quantity: 1,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: 'counter:sale-1:medicine-rx',
};

function fixture(flags: { rx?: boolean; restricted?: boolean } = { rx: true }) {
  const authorizationCreate = vi.fn(async ({ data }: { data: unknown }) => data);
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn(async () => []),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-rx',
        rx: false,
        restricted: false,
        controlled: false,
        ...flags,
      })),
    },
    prescriptionLine: { findFirst: vi.fn(async () => null as unknown) },
    restaurantOperatorCredential: { findFirst: vi.fn(async () => null), update: vi.fn() },
    pharmacyRxLineAuthorization: {
      findFirst: vi.fn(async () => null),
      create: authorizationCreate,
    },
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
  return { db, authorizationCreate, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(can).mockResolvedValue(false);
  vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' }, allocation: {} } as never);
});

describe('pharmacySales.addLine prescription gate (SEC)', () => {
  it.each([{ rx: true }, { restricted: true }])(
    'refuses a direct addLine for %o with no prescription or override',
    async (flags) => {
      const f = fixture(flags);
      await expect(f.caller.addLine(line)).resolves.toMatchObject({
        blocked: expect.stringContaining('prescription'),
      });
      expect(addSaleLine).not.toHaveBeenCalled();
      expect(f.authorizationCreate).not.toHaveBeenCalled();
    }
  );

  it('still adds an OTC line without any authorization', async () => {
    const f = fixture({ rx: false });
    await f.caller.addLine(line);
    expect(addSaleLine).toHaveBeenCalledOnce();
    expect(f.authorizationCreate).not.toHaveBeenCalled();
  });

  it('refuses a prescription line for another medicine or an expired prescription', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-other' } })
    ).resolves.toHaveProperty('blocked');
    f.db.prescriptionLine.findFirst.mockResolvedValueOnce({
      id: 'rx-line-1',
      authorizedCanonicalUnits: 30,
      prescription: { validFrom: new Date('2020-01-01'), validUntil: new Date('2020-02-01') },
    });
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-1' } })
    ).resolves.toHaveProperty('blocked');
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('records a PRESCRIPTION authorization for a valid linked prescription line', async () => {
    const f = fixture();
    f.db.prescriptionLine.findFirst.mockResolvedValueOnce({
      id: 'rx-line-1',
      authorizedCanonicalUnits: 30,
      prescription: {
        validFrom: new Date(Date.now() - 86_400_000),
        validUntil: new Date(Date.now() + 86_400_000),
      },
    });
    await f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-1' } });
    expect(f.db.prescriptionLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'rx-line-1',
          organizationId: 'org-1',
          medicineId: 'medicine-rx',
          presentationId: 'presentation-1',
        }),
      })
    );
    expect(f.authorizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        saleLineId: 'line-1',
        kind: 'PRESCRIPTION',
        prescriptionLineId: 'rx-line-1',
        recordedByUserId: 'cashier-1',
      }),
    });
  });

  it('refuses a cashier override without an independent pharmacist PIN', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { override: { reason: 'Patient known' } } })
    ).resolves.toHaveProperty('blocked');
    await expect(
      f.caller.addLine({
        ...line,
        rxAuthorization: {
          override: { reason: 'Patient known', staffProfileId: 'sp-1', pin: '1234' },
        },
      })
    ).resolves.toHaveProperty('blocked');
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('records an audited OVERRIDE when the actor holds pharmacy:dispense', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    await f.caller.addLine({
      ...line,
      rxAuthorization: { override: { reason: 'Repeat chronic therapy, script at home' } },
    });
    expect(vi.mocked(can).mock.calls[0]![1]).toBe('pharmacy:dispense');
    expect(f.authorizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        saleLineId: 'line-1',
        kind: 'OVERRIDE',
        prescriptionLineId: null,
        pharmacistUserId: 'cashier-1',
        reason: 'Repeat chronic therapy, script at home',
      }),
    });
    const [args] = vi.mocked(recordTrpcAudit).mock.calls[0]!;
    expect(args.ctx.audit?.detail).toMatchObject({
      category: 'PHARMACY_SAFETY',
      action: 'rx_override',
      metadata: { reason: 'Repeat chronic therapy, script at home' },
    });
  });

  it('rejects giving both a prescription line and an override', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({
        ...line,
        rxAuthorization: { prescriptionLineId: 'rx-line-1', override: { reason: 'both' } },
      })
    ).rejects.toThrow();
  });
});
