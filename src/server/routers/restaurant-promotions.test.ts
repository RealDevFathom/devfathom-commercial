import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(async () => true), hasModule: vi.fn(() => true) }));
vi.mock('server-only', () => ({}));
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
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { router, type TRPCContext } from '../trpc';
import { Prisma } from '@/generated/prisma/client';
import { restaurantPromotionsRouter } from './restaurant-promotions';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;
const delegate = (): Delegate => ({
  count: vi.fn().mockResolvedValue(0),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'generated', ...data })),
  update: vi.fn().mockImplementation(async ({ where, data }) => ({ ...where, ...data })),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
});

function makeDb() {
  const db = {
    restaurantPromotion: delegate(),
    restaurantPromotionVersion: delegate(),
    restaurantPromotionRuleComponent: delegate(),
    restaurantPromotionAuditEvent: delegate(),
    restaurantBranch: delegate(),
    restaurantProduct: delegate(),
    restaurantProductVariant: delegate(),
    restaurantCategory: delegate(),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  return db;
}

let db: ReturnType<typeof makeDb>;
function caller() {
  return router({ restaurantPromotions: restaurantPromotionsRouter }).createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-menu'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'owner_1', role: 'OWNER', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).restaurantPromotions;
}

const rule = {
  effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  effectiveTo: null,
  timezone: 'Asia/Karachi',
  targetKind: 'ITEM' as const,
  targetProductIds: ['product_1'],
  targetVariantIds: [],
  targetCategoryIds: [],
  allowedBranchIds: ['branch_1'],
  allowedChannels: ['DINE_IN' as const],
  benefitKind: 'PERCENT_OFF' as const,
  benefitBasisPoints: 1000,
  applicationBasis: 'ORDER' as const,
  currency: 'pkr',
};

const draft = {
  id: 'version_1', versionNumber: 1, status: 'DRAFT', ruleHash: 'current-hash',
  updatedAt: new Date('2026-09-01T00:00:00Z'), activationMode: 'AUTOMATIC',
  requiresCoAuthorization: false, couponCodeHash: null, requiredPermission: null,
  approvedByStaffId: null, approvalReference: null, customerSegmentRef: null,
  globalCap: null, perCustomerCap: null, budgetAmount: null, publishedAt: null,
  supersededAt: null, benefitKind: 'PERCENT_OFF', components: [], targetKind: 'ITEM',
  targetProductIds: ['product_1'], targetVariantIds: [], targetCategoryIds: [],
};
const editInput = { promotionId: 'promotion_1', expectedVersionId: draft.id,
  expectedRuleHash: draft.ruleHash, expectedUpdatedAt: draft.updatedAt, name: 'Ten percent', rule };
function existing(changes: Record<string, unknown> = {}) {
  db.restaurantPromotion.findFirst.mockResolvedValue({ id: 'promotion_1', code: 'TENOFF', versions: [{ ...draft, ...changes }] });
}

beforeEach(() => {
  db = makeDb();
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  db.restaurantBranch.count.mockResolvedValue(1);
  db.restaurantProduct.count.mockResolvedValue(1);
});

describe('restaurant promotion administration', () => {
  it('creates a draft from picker-backed identifiers and canonicalizes its snapshot', async () => {
    db.restaurantPromotion.create.mockResolvedValue({
      id: 'promotion_1',
      code: 'TENOFF',
      name: 'Ten off',
    });
    db.restaurantPromotionVersion.create.mockImplementation(async ({ data }) => ({ ...data }));

    const result = await caller().createOffer({ code: 'TENOFF', name: 'Ten off', rule });

    expect(result.promotionId).toBe('promotion_1');
    expect(result.ruleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.restaurantPromotionVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: 'PKR' }),
      })
    );
    expect(db.restaurantPromotionAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'DRAFT_CREATED', actorUserId: 'owner_1' }),
      })
    );
  });

  it('rejects an inaccessible branch before starting a write transaction', async () => {
    db.restaurantBranch.count.mockResolvedValue(0);
    await expect(
      caller().createOffer({ code: 'TENOFF', name: 'Ten off', rule })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('returns a validation error for an item offer with no selected item', async () => {
    await expect(
      caller().createOffer({
        code: 'TENOFF',
        name: 'Ten off',
        rule: { ...rule, targetProductIds: [] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantPromotion.create).not.toHaveBeenCalled();
  });

  it('edits only an existing draft and records the new canonical hash', async () => {
    db.restaurantPromotion.findFirst.mockResolvedValue({
      id: 'promotion_1',
      code: 'TENOFF',
      versions: [draft],
    });
    db.restaurantPromotionVersion.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
    }));
    const result = await caller().editOffer({
      ...editInput,
    });
    expect(result.versionId).toBe('version_1');
    expect(db.restaurantPromotionVersion.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: draft.id, status: 'DRAFT', ruleHash: draft.ruleHash, updatedAt: draft.updatedAt, promotion: { status: 'ACTIVE' } },
      data: expect.objectContaining({ components: { deleteMany: {}, create: [] } }),
    }));
    expect(db.restaurantPromotionRuleComponent.deleteMany).not.toHaveBeenCalled();
    expect(db.restaurantPromotionAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'DRAFT_EDITED' }) })
    );
  });

  it('disables an active offer without deleting its evidence', async () => {
    db.restaurantPromotion.findFirst.mockResolvedValue({ id: 'promotion_1' });
    db.restaurantPromotion.update.mockResolvedValue({ id: 'promotion_1', status: 'ARCHIVED' });
    await expect(
      caller().disableOffer({ promotionId: 'promotion_1', reason: 'Pricing correction' })
    ).resolves.toEqual({ id: 'promotion_1', status: 'ARCHIVED' });
    expect(db.restaurantPromotionAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'EMERGENCY_DISABLED',
          reasonCode: 'Pricing correction',
        }),
      })
    );
  });
});


describe('preservative offer editor boundaries', () => {
  it.each(['capability', 'module'])('denies %s access before reading or writing', async (gate) => {
    if (gate === 'capability') mocks.can.mockResolvedValue(false);
    else mocks.hasModule.mockReturnValue(false);
    await expect(caller().createOffer({ code: 'TENOFF', name: 'Ten off', rule })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantBranch.count).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'PUBLISHED' }, { activationMode: 'COUPON' }, { couponCodeHash: 'hashed' },
    { requiresCoAuthorization: true }, { requiredPermission: '' }, { approvedByStaffId: 'staff' },
    { approvalReference: 'approval' }, { customerSegmentRef: 'segment' }, { globalCap: 0 },
    { perCustomerCap: 0 }, { budgetAmount: '0.00' }, { publishedAt: new Date() },
    { supersededAt: new Date() }, { targetCategoryIds: ['category'] },
    { targetKind: 'ORDER' }, { targetKind: 'CATEGORY' },
    { components: [{ ordinal: 0, productIds: ['p'], categoryIds: [], variantIds: [], quantity: 1 }] },
    { benefitKind: 'BUNDLE_PRICE', components: [] },
    { benefitKind: 'BUNDLE_PRICE', components: [{ ordinal: 0, productIds: ['p'], categoryIds: ['c'], variantIds: [], quantity: 1 }] },
    { benefitKind: 'BUNDLE_PRICE', components: [{ ordinal: 0, productIds: ['p'], categoryIds: [], variantIds: ['v'], quantity: 1 }] },
    { benefitKind: 'BUNDLE_PRICE', components: [{ ordinal: 1, productIds: ['p'], categoryIds: [], variantIds: [], quantity: 1 }] },
  ])('retains unsupported draft without writes: %j', async (changes) => {
    existing(changes);
    await expect(caller().editOffer(editInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.restaurantPromotionVersion.update).not.toHaveBeenCalled();
    expect(db.restaurantPromotionRuleComponent.deleteMany).not.toHaveBeenCalled();
    expect(db.restaurantPromotionAuditEvent.create).not.toHaveBeenCalled();
  });
  it.each([{ expectedVersionId: 'stale' }, { expectedRuleHash: 'stale' }, { expectedUpdatedAt: new Date(0) }])('rejects stale displayed identity %j', async (identity) => {
    existing();
    await expect(caller().editOffer({ ...editInput, ...identity })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('reports a concurrent version change without rename or audit', async () => {
    existing();
    db.restaurantPromotionVersion.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('changed', { code: 'P2025', clientVersion: 'test' }));
    await expect(caller().editOffer(editInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.restaurantPromotion.update).not.toHaveBeenCalled();
    expect(db.restaurantPromotionAuditEvent.create).not.toHaveBeenCalled();
  });
  it('uses the same read-only reason for an advanced listed draft', async () => {
    db.restaurantPromotion.findMany.mockResolvedValue([{ id: 'promotion_1', versions: [{ ...draft, globalCap: 0 }] }]);
    const offers = await caller().list();
    expect(offers[0].editRestriction).toContain('read-only');
  });
});


it('rejects variant-only item targets before writes', async () => {
  await expect(caller().createOffer({ code: 'TENOFF', name: 'Ten off', rule: { ...rule, targetProductIds: [], targetVariantIds: ['variant_1'] } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(db.$transaction).not.toHaveBeenCalled();
});


describe('rule validation before storage access', () => {
  it.each([
    { timezone: 'invalid/timezone' }, { startMinute: 10 }, { endMinute: 10 },
    { targetCategoryIds: ['category'] }, { targetKind: 'ORDER' as const },
    { targetKind: 'CATEGORY' as const, targetCategoryIds: ['category'] },
    { benefitAmount: '5.00' }, { buyQuantity: 1 }, { getQuantity: 1 },
    { components: [{ productIds: ['product_1'], quantity: 1 }] },
    { benefitKind: 'BUNDLE_PRICE' as const, benefitBasisPoints: null, benefitAmount: '5.00', components: [{ quantity: 1 }] },
  ])('rejects mismatched rule %j', async (changes) => {
    await expect(caller().createOffer({ code: 'TENOFF', name: 'Ten off', rule: { ...rule, ...changes } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantBranch.count).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
