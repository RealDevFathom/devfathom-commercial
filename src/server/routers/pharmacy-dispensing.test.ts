import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  create: vi.fn(),
  findMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyDispensingRouter } from './pharmacy-dispensing';

function caller() {
  return pharmacyDispensingRouter.createCaller({
    db: {
      pharmacySubstitutionRecord: { create: mocks.create },
      pharmacyPharmacistReviewItem: { findMany: mocks.findMany },
    },
    entitlements: { enabledModules: ['pharmacy-core'] },
    session: {
      expires: 'later',
      user: { id: 'counter-user', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('AI-05 pharmacist gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
  });

  it('refuses accepting a proposal on an Rx line without pharmacist capability', async () => {
    await expect(
      caller().recordSubstitution({
        prescriptionLineId: 'rx-line',
        saleLineId: 'sale-line',
        prescribedPresentationId: 'prescribed',
        suppliedPresentationId: 'supplied',
        equivalenceBasis: 'Exact ingredient, strength, form and route',
        patientCommunication: 'Patient accepted after pharmacist explanation.',
        jurisdictionRuleRef: 'RX-04',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('DEV-35 substitution workspace access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
  });
  const grant = (...held: string[]) =>
    mocks.can.mockImplementation((async (_subject: unknown, action: string) =>
      held.includes(action)) as unknown as () => Promise<boolean>);

  it('refuses a member with neither dispense nor safety', async () => {
    grant('reports:operational');
    await expect(caller().substitutionWorkspace()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('opens review-only for a Pharmacy Safety holder', async () => {
    grant('pharmacy:safety');
    await expect(caller().substitutionWorkspace()).resolves.toEqual({
      canRecord: false,
      lines: [],
    });
  });

  it('lets a dispensing pharmacist record', async () => {
    grant('pharmacy:dispense');
    await expect(caller().substitutionWorkspace()).resolves.toEqual({ canRecord: true, lines: [] });
  });

  it('still refuses recording to a safety-only holder', async () => {
    grant('pharmacy:safety');
    await expect(
      caller().recordSubstitution({
        prescriptionLineId: 'rx-line',
        saleLineId: 'sale-line',
        prescribedPresentationId: 'prescribed',
        suppliedPresentationId: 'supplied',
        equivalenceBasis: 'Exact ingredient, strength, form and route',
        patientCommunication: 'Patient accepted after pharmacist explanation.',
        jurisdictionRuleRef: 'RX-04',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
