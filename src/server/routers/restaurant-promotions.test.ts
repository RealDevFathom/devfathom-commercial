import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(async () => true) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
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

import type { TRPCContext } from '../trpc';
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
  return restaurantPromotionsRouter.createCaller({
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
  } as unknown as TRPCContext);
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

beforeEach(() => {
  db = makeDb();
  mocks.can.mockResolvedValue(true);
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
      versions: [{ id: 'version_1', versionNumber: 1 }],
    });
    db.restaurantPromotionVersion.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
    }));
    const result = await caller().editOffer({
      promotionId: 'promotion_1',
      name: 'Ten percent',
      rule,
    });
    expect(result.versionId).toBe('version_1');
    expect(db.restaurantPromotionRuleComponent.deleteMany).toHaveBeenCalledWith({
      where: { promotionVersionId: 'version_1' },
    });
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
