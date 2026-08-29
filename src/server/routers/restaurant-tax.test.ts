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
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  restaurantBranch: { findUnique: vi.fn() },
  restaurantTaxProfileVersion: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
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
  idempotencyKey: 'activation-key-42',
};

describe('restaurant tax activation router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.restaurantBranch.findUnique.mockResolvedValue({ id: 'branch_1' });
    db.$transaction.mockImplementation(async (run) => run(db));
    db.restaurantTaxProfileVersion.findUnique.mockResolvedValue(null);
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

  it('rejects a reduced profile unless every statutory control is confirmed', async () => {
    await expect(
      caller().activate({
        ...base,
        profileId: 'PK-ICT-RESTAURANT',
        eligibilityConfirmations: ['ictNoRefund'],
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.restaurantTaxProfileVersion.create).not.toHaveBeenCalled();
  });

  it('publishes the exact selected effective-dated profile after explicit confirmation', async () => {
    await caller().activate({
      ...base,
      profileId: 'PK-ICT-RESTAURANT',
      eligibilityConfirmations: ['ictNoInputTaxCreditOrAdjustment', 'ictNoRefund'],
    });
    expect(db.restaurantTaxProfileVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch_1',
          status: 'PUBLISHED',
          effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
          rules: {
            create: expect.arrayContaining([
              expect.objectContaining({ paymentCategory: 'CARD', rate: '0.05' }),
            ]),
          },
        }),
      })
    );
    expect(db.restaurantTaxProfileVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activationIdempotencyKey: 'activation-key-42',
          activationPayloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          eligibilityEvidence: expect.objectContaining({
            confirmations: expect.arrayContaining([
              expect.objectContaining({ id: 'ictNoInputTaxCreditOrAdjustment' }),
              expect.objectContaining({ id: 'ictNoRefund' }),
            ]),
          }),
        }),
      })
    );
  });

  it('returns the original profile for a matching idempotent replay', async () => {
    db.restaurantTaxProfileVersion.findUnique.mockResolvedValue({
      id: 'profile_1',
      activationPayloadHash: 'placeholder',
      rules: [],
    });
    const firstInput = {
      ...base,
      profileId: 'PK-ICT-RESTAURANT',
      eligibilityConfirmations: ['ictNoRefund', 'ictNoInputTaxCreditOrAdjustment'],
    };
    const payload = {
      branchId: firstInput.branchId,
      profileId: firstInput.profileId,
      effectiveFrom: firstInput.effectiveFrom,
      accountantConfirmation: true,
      approvalReference: firstInput.approvalReference,
      eligibilityConfirmations: ['ictNoInputTaxCreditOrAdjustment', 'ictNoRefund'],
    };
    db.restaurantTaxProfileVersion.findUnique.mockResolvedValue({
      id: 'profile_1',
      activationPayloadHash: (await import('node:crypto'))
        .createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
      rules: [],
    });
    await expect(caller().activate(firstInput)).resolves.toMatchObject({ id: 'profile_1' });
    expect(db.restaurantTaxProfileVersion.create).not.toHaveBeenCalled();
  });

  it('conflicts when an idempotency key is reused with a different payload', async () => {
    db.restaurantTaxProfileVersion.findUnique.mockResolvedValue({
      id: 'profile_1',
      activationPayloadHash: '0'.repeat(64),
      rules: [],
    });
    await expect(
      caller().activate({
        ...base,
        profileId: 'PK-ICT-RESTAURANT',
        eligibilityConfirmations: ['ictNoInputTaxCreditOrAdjustment', 'ictNoRefund'],
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
