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
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/substitute-finder', () => ({
  findSubstituteProposals: vi.fn(async () => []),
  declineSubstitute: vi.fn(),
  PharmacySubstituteError: class PharmacySubstituteError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { findSubstituteProposals } from '@/lib/pharmacy/substitute-finder';
import type { TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const input = {
  branchId: 'branch-1',
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  quantityCanonicalUnits: 10,
};

function caller(branch: { id: string } | null) {
  const db = {
    pharmacyBranch: { findFirst: vi.fn(async () => branch) },
  };
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('substitute proposals', () => {
  beforeEach(() => {
    vi.mocked(findSubstituteProposals).mockClear();
  });

  it('refuses an inactive branch before looking for equivalents', async () => {
    await expect(caller(null).substituteProposals(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });

  it('derives the price rule on the server for an active branch', async () => {
    await caller({ id: 'branch-1' }).substituteProposals(input);
    expect(findSubstituteProposals).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' },
      {
        medicineId: 'medicine-1',
        presentationId: 'presentation-1',
        quantityCanonicalUnits: 10,
      }
    );
  });

  it('rejects a client requireLowerPrice flag', async () => {
    await expect(
      caller({ id: 'branch-1' }).substituteProposals({
        ...input,
        requireLowerPrice: false,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });
});
