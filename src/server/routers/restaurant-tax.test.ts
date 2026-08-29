import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { restaurantTaxRouter } from './restaurant-tax';

const db = {
  restaurantBranch: { findUnique: vi.fn() },
  restaurantTaxProfileVersion: { findFirst: vi.fn(), create: vi.fn() },
  restaurantTaxOfficialSource: { upsert: vi.fn() },
};

function caller() {
  return restaurantTaxRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-core'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: 'admin_1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

const base = {
  branchId: 'branch_1',
  effectiveFrom: '2026-07-01T00:00:00.000Z',
  accountantConfirmation: true,
  approvalReference: 'Accountant memo 42',
};

describe('restaurant tax activation router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.restaurantBranch.findUnique.mockResolvedValue({ id: 'branch_1' });
    db.restaurantTaxProfileVersion.findFirst.mockResolvedValue(null);
    db.restaurantTaxOfficialSource.upsert.mockResolvedValue({ id: 'source_1' });
    db.restaurantTaxProfileVersion.create.mockResolvedValue({ id: 'profile_1', rules: [] });
  });

  it('rejects Punjab before any database write', async () => {
    await expect(
      caller().activate({ ...base, profileId: 'PK-PB-RESTAURANT', eligibilityConfirmations: [] })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.restaurantTaxProfileVersion.create).not.toHaveBeenCalled();
  });

  it('rejects a BRA reduced profile unless every exclusion and eligibility control is confirmed', async () => {
    await expect(
      caller().activate({
        ...base,
        profileId: 'PK-BA-RESTAURANT-BRA-POS',
        eligibilityConfirmations: ['braLinkedPos'],
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.restaurantTaxProfileVersion.create).not.toHaveBeenCalled();
  });

  it('publishes the exact selected effective-dated profile after explicit confirmation', async () => {
    await caller().activate({
      ...base,
      profileId: 'PK-BA-RESTAURANT-BRA-POS',
      eligibilityConfirmations: [
        'braLinkedPos',
        'allElectronic',
        'noInputAdjustment',
        'notExcludedPremises',
        'notFranchise',
      ],
    });
    expect(db.restaurantTaxProfileVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch_1',
          status: 'PUBLISHED',
          effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
          rules: {
            create: expect.arrayContaining([
              expect.objectContaining({ paymentCategory: 'CARD', rate: '0.04' }),
            ]),
          },
        }),
      })
    );
  });
});
