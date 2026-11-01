import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: vi.fn(async (_organizationId, work) => work({ auditLog: { create: vi.fn() } })),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
// Observe middleware calls while exercising the real audit writer.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn(actual.recordTrpcAudit) };
});

import { flushAuditWritesForTest, recordTrpcAudit } from '@/server/audit';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

function saleLine(id: string, medicineId: string, productName: string, salt: string) {
  return {
    id,
    medicineId,
    medicine: {
      productName,
      strengths: [{ ingredientId: `ing-${salt}`, ingredient: { name: salt } }],
    },
  };
}

function fixture({
  rules = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
  sale = {
    id: 'sale-1',
    lines: [
      saleLine('line-1', 'panadol', 'Panadol', 'Paracetamol'),
      saleLine('line-2', 'calpol', 'Calpol', 'Paracetamol'),
    ],
  } as unknown,
} = {}) {
  const saleRead = vi.fn(async () => sale);
  const db = {
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-1' }]) },
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: rules },
        permissionOverrides: [],
      })),
    },
    pharmacySale: { findFirst: saleRead, update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, saleRead, caller: app.createCaller(context).pharmacySales };
}

function lastAudit() {
  const calls = vi.mocked(recordTrpcAudit).mock.calls;
  expect(calls).toHaveLength(1);
  const [args] = calls[0]!;
  return { ...args, detail: args.ctx.audit?.detail };
}

const input = { branchId: 'branch-1', saleId: 'sale-1', ingredientKey: 'paracetamol' };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => flushAuditWritesForTest());

describe('pharmacySales.acknowledgeDuplicateSalt (#724)', () => {
  it('audit-logs the acknowledgement of two paracetamol brands', async () => {
    const f = fixture();

    const result = await f.caller.acknowledgeDuplicateSalt(input);

    expect(result).toMatchObject({ saleId: 'sale-1', ingredientName: 'Paracetamol' });
    const audit = lastAudit();
    expect(audit.outcome).toBe('SUCCESS');
    expect(audit.path).toBe('pharmacySales.acknowledgeDuplicateSalt');
    expect(audit.detail).toMatchObject({
      category: 'PHARMACY_SAFETY',
      action: 'duplicate_salt_acknowledged',
      targetType: 'PharmacySale',
      targetId: 'sale-1',
      metadata: {
        branchId: 'branch-1',
        ingredientKey: 'paracetamol',
        ingredientName: 'Paracetamol',
        medicineIds: ['panadol', 'calpol'],
        saleLineIds: ['line-1', 'line-2'],
      },
    });
    // Acknowledging never mutates (or blocks) the sale.
    expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
    expect(f.db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        actorId: 'actor-1',
        action: 'duplicate_salt_acknowledged',
        outcome: 'SUCCESS',
        metadata: audit.detail?.metadata,
      }),
    });
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it('does not return success until the acknowledgement audit write finishes', async () => {
    const f = fixture();
    let release!: (row: { id: string }) => void;
    f.db.auditLog.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    let finished = false;
    const call = f.caller.acknowledgeDuplicateSalt(input).then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(f.db.auditLog.create).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    release({ id: 'audit-1' });
    await expect(call).resolves.toMatchObject({ saleId: 'sale-1' });
  });

  it('rejects the acknowledgement if the audit insert fails, without mutating the sale', async () => {
    const f = fixture();
    f.db.auditLog.create.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(f.caller.acknowledgeDuplicateSalt(input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it('refuses, and audits the failed attempt, when the bill has no such duplicate', async () => {
    const f = fixture({
      sale: {
        id: 'sale-1',
        lines: [
          saleLine('line-1', 'panadol', 'Panadol', 'Paracetamol'),
          saleLine('line-2', 'brufen', 'Brufen', 'Ibuprofen'),
        ],
      },
    });
    await expect(f.caller.acknowledgeDuplicateSalt(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'NOT_DUPLICATE',
    });
    const audit = lastAudit();
    expect(audit.outcome).toBe('FAILURE');
    expect(audit.detail).not.toMatchObject({ action: 'duplicate_salt_acknowledged' });
  });

  it('returns NOT_FOUND for a sale outside the branch scope', async () => {
    const f = fixture({ sale: null });
    await expect(f.caller.acknowledgeDuplicateSalt(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a member whose counter capability is explicitly denied', async () => {
    const f = fixture({ rules: [{ capability: 'pharmacy:counter', effect: 'DENY' }] });
    await expect(f.caller.acknowledgeDuplicateSalt(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.saleRead).not.toHaveBeenCalled();
  });
});
