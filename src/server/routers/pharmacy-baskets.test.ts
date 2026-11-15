import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSync } from 'bcryptjs';
import type { Prisma } from '@/generated/prisma/client';
import type { TRPCContext } from '../trpc';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }) =>
    entitlements.enabledModules.includes('pharmacy-crm'),
  resolveOrganizationEntitlements: async () => ({
    organizationId: 'org-a',
    enabledModules: ['pharmacy-crm'],
  }),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMarketingRouter } from './pharmacy-marketing';

const pinHash = hashSync('1234', 4);
const product = (id: string, flags = {}) => ({
  id,
  productName: id,
  productFamily: 'FRONT_SHOP',
  rx: false,
  otc: false,
  restricted: false,
  controlled: false,
  ...flags,
});
const generate = {
  branchId: 'branch-a',
  from: new Date('2026-10-01'),
  cutoff: new Date('2026-10-03'),
  config: {
    minimumPairCount: 2,
    minimumSupport: 0.3,
    minimumConfidence: 0.5,
    minimumLift: 1,
    maximumProposals: 3,
  },
};

function setup(role = 'ADMIN') {
  let saved: { id: string; snapshot: unknown; output: unknown; createdAt: Date } | undefined;
  let review: { decision: string; campaignId: string | null; settings: unknown } | undefined;
  const template = {
    id: 'template-a',
    approvedByUserId: 'owner-a',
    approvedAt: new Date(),
    body: 'A new in-store retail offer may be available. Ask our team for details. Reply STOP to opt out.',
  };
  const credential = {
    id: 'pin-a',
    credentialHash: pinHash,
    failedAttempts: 0,
    lockedUntil: null as Date | null,
  };
  const db = {
    organization: {
      findUnique: vi.fn(async () => ({
        id: 'org-a',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'UTC',
      })),
    },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch-a' })) },
    user: {
      findFirst: vi.fn(async () => ({ id: 'owner-a' })),
      // Growth snapshots require both report capabilities through the real ABAC engine.
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: [
            { capability: 'reports:operational', effect: 'ALLOW' as const },
            { capability: 'reports:financial', effect: 'ALLOW' as const },
          ],
        },
        permissionOverrides: [] as Array<{ capability: string; effect: 'ALLOW' | 'DENY' }>,
      })),
    },
    pharmacySale: {
      findMany: vi.fn(async () => [
        {
          id: 's1',
          lines: [
            { medicineId: 'soap' },
            { medicineId: 'cream' },
            { medicineId: 'cream' },
            { medicineId: 'rx' },
            { medicineId: 'restricted' },
            { medicineId: 'controlled' },
          ],
        },
        { id: 's2', lines: [{ medicineId: 'soap' }, { medicineId: 'cream' }] },
        { id: 's3', lines: [{ medicineId: 'otc' }] },
        { id: 's4', lines: [{ medicineId: 'otc' }] },
      ]),
    },
    medicine: {
      findMany: vi.fn(async (args: { select: { productName?: boolean } }) =>
        args.select.productName
          ? [
              product('soap'),
              product('cream'),
              product('rx', { rx: true }),
              product('restricted', { restricted: true }),
              product('controlled', { controlled: true }),
              product('otc', { otc: true, productFamily: 'PHARMACEUTICAL' }),
            ]
          : [{ id: 'cream' }, { id: 'soap' }]
      ),
    },
    // Catalogue names read by the WhatsApp compliance linter at template approval.
    medicineAlias: { findMany: vi.fn(async () => []) },
    ingredient: { findMany: vi.fn(async () => []) },
    restaurantStaffProfile: { findMany: vi.fn(async () => [{ id: 'staff-owner' }]) },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => credential),
      update: vi.fn(async ({ data }: { data: Partial<typeof credential> }) =>
        Object.assign(credential, data)
      ),
    },
    pharmacyMarketingTemplate: {
      create: vi.fn(async () => template),
      findFirst: vi.fn(async () => template),
    },
    pharmacyMarketingSegment: { create: vi.fn(async () => ({ id: 'segment-a' })) },
    pharmacyCampaign: {
      create: vi.fn(async () => ({
        id: 'campaign-a',
        name: 'Basket bundle retail offer',
        status: 'DRAFT',
      })),
    },
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      if (sql.text.includes('current_setting')) return [{ allowed: true }];
      if (sql.text.includes('FROM growth_insights')) return saved ? [saved] : [];
      if (sql.text.includes('FROM pharmacy_growth_reviews')) return review ? [review] : [];
      return [];
    }),
    $executeRaw: vi.fn(async (sql: Prisma.Sql) => {
      const values = sql.values;
      if (sql.text.includes('INSERT INTO growth_insights'))
        saved = {
          id: String(values[0]),
          snapshot: JSON.parse(String(values[6])),
          output: JSON.parse(String(values[7])),
          createdAt: new Date(),
        };
      if (sql.text.includes('INSERT INTO pharmacy_growth_reviews'))
        review = {
          decision: String(values[5]),
          settings: values[7] ? JSON.parse(String(values[7])) : null,
          campaignId: values[8] as string | null,
        };
      return 1;
    }),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((work) => work(db));
  const ctx = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-crm'] },
    organization: { id: 'org-a' },
    session: {
      expires: 'later',
      user: { id: 'owner-a', role, status: 'ACTIVE', organizationId: 'org-a' },
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  const caller = pharmacyMarketingRouter.createCaller(ctx as unknown as TRPCContext);
  const approve = async (overrides = {}) => {
    const { id } = await caller.generateBaskets(generate);
    return caller.reviewBasket({
      branchId: 'branch-a',
      insightId: id,
      recommendation: 0,
      decision: 'APPROVE',
      pinCredential: '1234',
      scheduledAt: new Date('2026-11-02'),
      ...overrides,
    });
  };
  return { caller, db, ctx, approve, credential, saved: () => saved, review: () => review };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('reachable pharmacy basket workflow', () => {
  it('reads completed tenant/branch receipts, persists evidence, and lets the solo owner PIN-approve an audited generic draft', async () => {
    const { caller, db, ctx, approve, review } = setup();
    expect(await approve()).toEqual({ campaignId: 'campaign-a', replay: false });
    expect(db.pharmacySale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          status: 'COMPLETED',
          receiptNumber: { not: null },
          completedAt: { gte: generate.from, lt: generate.cutoff },
        },
      })
    );
    expect(db.medicine.findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: 'org-a', saleable: true },
    });
    const history = await caller.basketHistory({ branchId: 'branch-a' });
    expect(history.insights[0].output.recommendations).toEqual([
      expect.objectContaining({
        productIds: ['cream', 'soap'],
        status: 'PENDING_OWNER_APPROVAL',
        evidence: { basketCount: 4, pairCount: 2, support: 0.5, confidence: 1, lift: 2 },
      }),
    ]);
    expect(db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', userId: 'owner-a', status: 'ACTIVE' },
      })
    );
    expect(db.pharmacyCampaign.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        status: 'DRAFT',
        promotesRegulatedItem: false,
      }),
    });
    expect(db.pharmacyMarketingTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        body: expect.stringContaining('Reply STOP'),
        approvedByUserId: 'owner-a',
      }),
    });
    expect(review()).toMatchObject({
      decision: 'APPROVE',
      settings: {
        staffProfileId: 'staff-owner',
        ownerPinReauthenticatedAt: '2026-10-31T12:00:00.000Z',
      },
      campaignId: 'campaign-a',
    });
    const insert = db.$executeRaw.mock.calls.find(([sql]) =>
      sql.text.includes('INSERT INTO pharmacy_growth_reviews')
    )![0];
    expect(insert.values).toContain('owner-a');
    expect(JSON.stringify(insert.values)).not.toContain('1234');
    expect(ctx.audit.detail).toMatchObject({ skipInput: true });
  });

  it.each(['STAFF', 'MANAGER', 'PHARMACIST'])('refuses %s before reading sales', async (role) => {
    const { caller, db } = setup(role);
    await expect(caller.generateBaskets(generate)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySale.findMany).not.toHaveBeenCalled();
  });

  it.each(['reports:operational', 'reports:financial'] as const)(
    'refuses an owner with a current %s DENY before reading or saving evidence',
    async (capability) => {
      const { caller, db } = setup();
      const permissions = await db.user.findUnique();
      db.user.findUnique.mockResolvedValue({
        ...permissions,
        permissionOverrides: [{ capability, effect: 'DENY' }],
      });

      await expect(caller.generateBaskets(generate)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Financial report permission is required.',
      });
      expect(db.pharmacySale.findMany).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.pharmacyCampaign.create).not.toHaveBeenCalled();
    }
  );

  it.each(['actor', 'branch', 'lifecycle'])(
    'rejects current %s revocation before reading evidence',
    async (kind) => {
      const { caller, db } = setup();
      if (kind === 'actor') db.user.findFirst.mockResolvedValue(null!);
      if (kind === 'branch') db.pharmacyBranch.findFirst.mockResolvedValue(null!);
      if (kind === 'lifecycle')
        db.organization.findUnique.mockResolvedValue({
          id: 'org-a',
          vertical: 'PHARMACY',
          status: 'SUSPENDED',
          timezone: 'UTC',
        });
      await expect(caller.generateBaskets(generate)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.pharmacySale.findMany).not.toHaveBeenCalled();
    }
  );

  it('requires a PIN and persists wrong-PIN lockout counters without creating campaigns', async () => {
    const { caller, db, credential } = setup();
    const { id } = await caller.generateBaskets(generate);
    const input = {
      branchId: 'branch-a',
      insightId: id,
      recommendation: 0,
      decision: 'APPROVE' as const,
      scheduledAt: new Date('2026-11-02'),
    };
    expect(await caller.reviewBasket(input)).toHaveProperty('blocked');
    for (let i = 0; i < 5; i++) {
      expect(await caller.reviewBasket({ ...input, pinCredential: '9999' })).toHaveProperty(
        'blocked'
      );
      expect(credential.failedAttempts).toBe(i === 4 ? 0 : i + 1);
    }
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledTimes(5);
    expect(credential.lockedUntil).toEqual(new Date('2026-10-31T12:15:00Z'));
    expect(await caller.reviewBasket({ ...input, pinCredential: '1234' })).toHaveProperty(
      'blocked'
    );
    expect(db.pharmacyCampaign.create).not.toHaveBeenCalled();
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('rechecks current product safety before approval', async () => {
    const { db, approve } = setup();
    db.medicine.findMany
      .mockResolvedValueOnce([product('soap'), product('cream')])
      .mockResolvedValueOnce([{ id: 'soap' }]);
    await expect(approve()).rejects.toThrow('no longer eligible');
    expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
    expect(db.pharmacyCampaign.create).not.toHaveBeenCalled();
  });

  it('serializes replay without duplicating campaigns and rejects conflicting decisions', async () => {
    const { caller, db, approve, saved } = setup();
    await approve();
    const input = {
      branchId: 'branch-a',
      insightId: saved()!.id,
      recommendation: 0,
      decision: 'APPROVE' as const,
      scheduledAt: new Date('2026-11-02'),
    };
    expect(await caller.reviewBasket(input)).toEqual({ campaignId: 'campaign-a', replay: true });
    await expect(caller.reviewBasket({ ...input, decision: 'REJECT' })).rejects.toThrow(
      'already resolved'
    );
    expect(db.pharmacyCampaign.create).toHaveBeenCalledTimes(1);
    expect(
      db.$queryRaw.mock.calls.some(
        ([sql]) => sql.text.includes('FROM growth_insights') && sql.text.includes('FOR UPDATE')
      )
    ).toBe(true);
  });

  it('records rejection without a PIN or campaign and rejects a foreign proposal', async () => {
    const { caller, db, review } = setup();
    await expect(
      caller.reviewBasket({
        branchId: 'branch-a',
        insightId: '00000000-0000-4000-8000-000000000001',
        recommendation: 0,
        decision: 'REJECT',
      })
    ).rejects.toThrow('not found');
    const { id } = await caller.generateBaskets(generate);
    await caller.reviewBasket({
      branchId: 'branch-a',
      insightId: id,
      recommendation: 0,
      decision: 'REJECT',
    });
    expect(review()).toMatchObject({ decision: 'REJECT', campaignId: null });
    expect(db.pharmacyCampaign.create).not.toHaveBeenCalled();
  });

  it('rejects forged evidence, out-of-range thresholds and oversized receipt periods', async () => {
    const { caller, db } = setup();
    await expect(
      caller.generateBaskets({ ...generate, products: [] } as typeof generate)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.generateBaskets({ ...generate, config: { ...generate.config, maximumProposals: 4 } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    db.pharmacySale.findMany.mockResolvedValue(
      Array.from({ length: 5001 }, (_, i) => ({ id: `s${i}`, lines: [] }))
    );
    await expect(caller.generateBaskets(generate)).rejects.toThrow('Narrow the period');
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
