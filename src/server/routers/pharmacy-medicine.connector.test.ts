import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  hasModule: vi.fn(() => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role?: string; status?: string }) => ({
    id: user.id,
    role: user.role ?? 'EMPLOYEE',
    status: user.status ?? null,
  }),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { MANUAL_FILE_RIGHTS } from '@/lib/pharmacy/reference-connectors';
import { moduleForProcedure } from '@/lib/module-catalog';
import type { TRPCContext } from '../trpc';
import { pharmacyMedicineRouter } from './pharmacy-medicine';

function caller(db: object) {
  return pharmacyMedicineRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org-a',
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'pharmacist-a', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  mocks.can.mockClear();
  mocks.hasModule.mockClear();
});

describe('MED-06 connector router boundary', () => {
  it('aborts a structurally inconsistent file before any connector write', async () => {
    const transaction = vi.fn();
    const db = { $transaction: transaction };

    await expect(
      caller(db).runReferenceConnectorNow({
        connectorId: 'manual-file',
        batchId: 'batch-a',
        fileName: 'catalog.csv',
        rows: [
          {
            batchId: 'different-batch',
            rowSourceKey: 'row-a',
            values: { productName: 'Medicine' },
            assertions: [
              {
                field: 'productName',
                value: 'Medicine',
                source: 'catalog.csv',
                sourceType: 'IMPORT',
                retrievedAt: '2030-01-01T00:00:00.000Z',
                batchId: 'batch-a',
                rowSourceKey: 'row-a',
                rights: MANUAL_FILE_RIGHTS,
              },
            ],
            blockingIssues: [],
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('gates pharmacist proposal reads on the narrow catalogue-review capability', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await caller({
      pharmacyReferenceConnectorProposal: { findMany },
    }).referenceConnectorProposals();

    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pharmacist-a' }),
      'pharmacy:catalogue-review',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(findMany).toHaveBeenCalledOnce();
    expect(moduleForProcedure('pharmacyMedicine.runReferenceConnectorNow')).toBe('pharmacy-core');
  });
});
