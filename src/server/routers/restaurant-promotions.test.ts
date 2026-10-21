import type { inferRouterInputs } from '@trpc/server';
import type {
  PromotionEvaluationContext,
  PromotionInputLine,
  PromotionRule,
} from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions } from '@/lib/restaurant/promotion-evaluator';
import {
  buildEvaluationSnapshot,
  computeOutputHash,
  computeRuleHash,
  reconstructEvaluation,
  ruleFromSnapshot,
  type CanonicalJson,
} from '@/lib/restaurant/promotion-snapshot';
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
  id: 'version_1',
  versionNumber: 1,
  status: 'DRAFT',
  ruleHash: 'current-hash',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  activationMode: 'AUTOMATIC',
  requiresCoAuthorization: false,
  couponCodeHash: null,
  requiredPermission: null,
  approvedByStaffId: null,
  approvalReference: null,
  customerSegmentRef: null,
  globalCap: null,
  perCustomerCap: null,
  budgetAmount: null,
  publishedAt: null,
  supersededAt: null,
  benefitKind: 'PERCENT_OFF',
  components: [],
  targetKind: 'ITEM',
  targetProductIds: ['product_1'],
  targetVariantIds: [],
  targetCategoryIds: [],
  benefitBasisPoints: 1000,
  benefitAmount: null,
  buyQuantity: null,
  getQuantity: null,
  currency: 'PKR',
};
const editInput = {
  promotionId: 'promotion_1',
  expectedVersionId: draft.id,
  expectedRuleHash: draft.ruleHash,
  expectedUpdatedAt: draft.updatedAt,
  name: 'Ten percent',
  rule,
};
function existing(changes: Record<string, unknown> = {}) {
  db.restaurantPromotion.findFirst.mockResolvedValue({
    id: 'promotion_1',
    code: 'TENOFF',
    name: 'Ten percent',
    versions: [{ ...draft, ...changes }],
  });
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
      name: 'Ten percent',
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
    expect(db.restaurantPromotionVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: draft.id,
          status: 'DRAFT',
          ruleHash: draft.ruleHash,
          updatedAt: draft.updatedAt,
          promotion: { status: 'ACTIVE' },
        },
        data: expect.objectContaining({ components: { deleteMany: {}, create: [] } }),
      })
    );
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
    await expect(
      caller().createOffer({ code: 'TENOFF', name: 'Ten off', rule })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantBranch.count).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'PUBLISHED' },
    { activationMode: 'COUPON' },
    { couponCodeHash: 'hashed' },
    { requiresCoAuthorization: true },
    { requiredPermission: '' },
    { approvedByStaffId: 'staff' },
    { approvalReference: 'approval' },
    { customerSegmentRef: 'segment' },
    { globalCap: 0 },
    { perCustomerCap: 0 },
    { budgetAmount: '0.00' },
    { publishedAt: new Date() },
    { supersededAt: new Date() },
    { targetCategoryIds: ['category'] },
    { targetKind: 'ORDER' },
    { targetKind: 'CATEGORY' },
    {
      components: [{ ordinal: 0, productIds: ['p'], categoryIds: [], variantIds: [], quantity: 1 }],
    },
    { benefitKind: 'BUNDLE_PRICE', components: [] },
    {
      benefitKind: 'BUNDLE_PRICE',
      components: [
        { ordinal: 0, productIds: ['p'], categoryIds: [], variantIds: ['v'], quantity: 1 },
      ],
    },
    {
      benefitKind: 'BUNDLE_PRICE',
      components: [{ ordinal: 1, productIds: ['p'], categoryIds: [], variantIds: [], quantity: 1 }],
    },
  ])('retains unsupported draft without writes: %j', async (changes) => {
    existing(changes);
    await expect(caller().editOffer(editInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.restaurantPromotionVersion.update).not.toHaveBeenCalled();
    expect(db.restaurantPromotionRuleComponent.deleteMany).not.toHaveBeenCalled();
    expect(db.restaurantPromotionAuditEvent.create).not.toHaveBeenCalled();
  });
  it.each([
    { expectedVersionId: 'stale' },
    { expectedRuleHash: 'stale' },
    { expectedUpdatedAt: new Date(0) },
  ])('rejects stale displayed identity %j', async (identity) => {
    existing();
    await expect(caller().editOffer({ ...editInput, ...identity })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('reports a concurrent version change without rename or audit', async () => {
    existing();
    db.restaurantPromotionVersion.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('changed', { code: 'P2025', clientVersion: 'test' })
    );
    await expect(caller().editOffer(editInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.restaurantPromotion.update).not.toHaveBeenCalled();
    expect(db.restaurantPromotionAuditEvent.create).not.toHaveBeenCalled();
  });
  it('uses the same read-only reason for an advanced listed draft', async () => {
    db.restaurantPromotion.findMany.mockResolvedValue([
      { id: 'promotion_1', name: 'Ten percent', versions: [{ ...draft, globalCap: 0 }] },
    ]);
    const offers = await caller().list();
    expect(offers[0].editRestriction).toContain('read-only');
  });
});

it('rejects variant-only item targets before writes', async () => {
  await expect(
    caller().createOffer({
      code: 'TENOFF',
      name: 'Ten off',
      rule: { ...rule, targetProductIds: [], targetVariantIds: ['variant_1'] },
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(db.$transaction).not.toHaveBeenCalled();
});

describe('rule validation before storage access', () => {
  it.each([
    { timezone: 'invalid/timezone' },
    { startMinute: 10 },
    { endMinute: 10 },
    { targetCategoryIds: ['category'] },
    { targetKind: 'ORDER' as const },
    { targetKind: 'CATEGORY' as const, targetCategoryIds: ['category'] },
    { benefitAmount: '5.00' },
    { buyQuantity: 1 },
    { getQuantity: 1 },
    { components: [{ productIds: ['product_1'], quantity: 1 }] },
    {
      benefitKind: 'BUNDLE_PRICE' as const,
      benefitBasisPoints: null,
      benefitAmount: '5.00',
      components: [{ quantity: 1 }],
    },
  ])('rejects mismatched rule %j', async (changes) => {
    await expect(
      caller().createOffer({ code: 'TENOFF', name: 'Ten off', rule: { ...rule, ...changes } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantBranch.count).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

type ComponentInput = { productIds: string[]; categoryIds: string[]; quantity: number };
type BundleRuleInput = inferRouterInputs<typeof restaurantPromotionsRouter>['createOffer']['rule'];
type CapturedBundle = { ruleSnapshot: unknown; ruleHash: string };
const mixedComponents: ComponentInput[] = [
  {
    productIds: ['product_2', 'product_1', 'product_2'],
    categoryIds: ['category_2', 'category_1', 'category_2'],
    quantity: 2,
  },
  { productIds: [], categoryIds: ['category_1'], quantity: 3 },
];
function allowReferences(input: BundleRuleInput) {
  db.restaurantProduct.count.mockResolvedValue(
    new Set([
      ...(input.targetProductIds ?? []),
      ...(input.components ?? []).flatMap((c) => c.productIds ?? []),
    ]).size
  );
  db.restaurantCategory.count.mockResolvedValue(
    new Set([
      ...(input.targetCategoryIds ?? []),
      ...(input.components ?? []).flatMap((c) => c.categoryIds ?? []),
    ]).size
  );
  db.restaurantProductVariant.count.mockResolvedValue(new Set(input.targetVariantIds ?? []).size);
  db.restaurantBranch.count.mockResolvedValue(new Set(input.allowedBranchIds ?? []).size);
}
function prepareBundle(components = mixedComponents) {
  const input = {
    ...rule,
    benefitKind: 'BUNDLE_PRICE' as const,
    benefitBasisPoints: null,
    benefitAmount: '25.00',
    components,
  };
  const stored = {
    ...draft,
    benefitKind: 'BUNDLE_PRICE',
    benefitBasisPoints: null,
    benefitAmount: new Prisma.Decimal(25),
    components: components.map((component, ordinal) => ({ ...component, ordinal, variantIds: [] })),
  };
  allowReferences(input);
  existing(stored);
  db.restaurantPromotion.findMany.mockResolvedValue([
    { id: 'promotion_1', name: 'Ten percent', versions: [stored] },
  ]);
  return { input, stored };
}
function expectNoWrites() {
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.restaurantPromotionVersion.update).not.toHaveBeenCalled();
  expect(db.restaurantPromotion.update).not.toHaveBeenCalled();
  expect(db.restaurantPromotionAuditEvent.create).not.toHaveBeenCalled();
}

describe('ordered bundle server boundaries', () => {
  it.each([
    { targetKind: 'ITEM', targetProductIds: [], targetVariantIds: ['variant_1'] },
    { targetKind: 'CATEGORY', targetProductIds: [], targetCategoryIds: [] },
  ])('keeps unsupported empty primary targeting read-only: %j', async (target) => {
    const { input, stored } = prepareBundle();
    const invalid = { ...stored, ...target };
    existing(invalid);
    db.restaurantPromotion.findMany.mockResolvedValue([
      { name: 'Ten percent', versions: [invalid] },
    ]);
    expect((await caller().list())[0]!.editRestriction).toMatch(/read-only/);
    await expect(caller().editOffer({ ...editInput, rule: input })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expectNoWrites();
  });

  it.each([
    ['mixed product and category alternatives', mixedComponents],
    ['category-only alternatives', [{ productIds: [], categoryIds: ['category_1'], quantity: 2 }]],
    [
      'twenty ordered components',
      Array.from({ length: 20 }, (_, index) => ({
        productIds: ['product_1'],
        categoryIds: [],
        quantity: index + 1,
      })),
    ],
  ] as const)('round-trips %s through guarded draft persistence', async (_name, components) => {
    const values = structuredClone(components) as ComponentInput[];
    const { input } = prepareBundle(values);
    expect((await caller().list())[0]!.editRestriction).toBeNull();
    const result = await caller().editOffer({ ...editInput, rule: input });
    const data = db.restaurantPromotionVersion.update.mock.calls[0]![0].data;
    expect(db.restaurantPromotionVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: draft.id,
          status: 'DRAFT',
          ruleHash: draft.ruleHash,
          updatedAt: draft.updatedAt,
          promotion: { status: 'ACTIVE' },
        },
      })
    );
    expect(data.components).toEqual({
      deleteMany: {},
      create: values.map((component, ordinal) => ({ ...component, ordinal, variantIds: [] })),
    });
    expect(data.ruleSnapshot.components).toEqual(
      values.map((component, ordinal) => ({ ...component, ordinal }))
    );
    expect(result.ruleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ruleFromSnapshot(data.ruleSnapshot, result.ruleHash).components).toEqual(
      values.map((component, ordinal) => ({ ...component, ordinal }))
    );
    expect(db.restaurantPromotionRuleComponent.deleteMany).not.toHaveBeenCalled();
    expect(db.restaurantPromotionAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'DRAFT_EDITED', payloadHash: result.ruleHash }),
      })
    );
  });

  it.each([
    ['empty list', []],
    [
      'twenty-one rows',
      Array.from({ length: 21 }, (_, ordinal) => ({
        ordinal,
        productIds: ['product_1'],
        categoryIds: [],
        variantIds: [],
        quantity: 1,
      })),
    ],
    ...[-1, 0.5, 1].map<[string, unknown[]]>((ordinal) => [
      `noncontiguous ordinal ${ordinal}`,
      [{ ordinal, productIds: ['product_1'], categoryIds: [], variantIds: [], quantity: 1 }],
    ]),
    [
      'duplicate ordinals',
      [0, 0].map((ordinal) => ({
        ordinal,
        productIds: ['product_1'],
        categoryIds: [],
        variantIds: [],
        quantity: 1,
      })),
    ],
    ...[0, -1, 1.5].map<[string, unknown[]]>((quantity) => [
      `invalid quantity ${quantity}`,
      [{ ordinal: 0, productIds: ['product_1'], categoryIds: [], variantIds: [], quantity }],
    ]),
    [
      'empty alternatives',
      [{ ordinal: 0, productIds: [], categoryIds: [], variantIds: [], quantity: 1 }],
    ],
    [
      'variant in second row',
      [0, 1].map((ordinal) => ({
        ordinal,
        productIds: ['product_1'],
        categoryIds: [],
        variantIds: ordinal === 1 ? ['variant_1'] : [],
        quantity: 1,
      })),
    ],
    [
      'too many products',
      [
        {
          ordinal: 0,
          productIds: Array(101).fill('product_1'),
          categoryIds: [],
          variantIds: [],
          quantity: 1,
        },
      ],
    ],
    [
      'too many categories',
      [
        {
          ordinal: 0,
          productIds: [],
          categoryIds: Array(101).fill('category_1'),
          variantIds: [],
          quantity: 1,
        },
      ],
    ],
  ])('keeps stored bundle %s read-only without normalizing it', async (_name, components) => {
    const { input, stored } = prepareBundle();
    const invalid = { ...stored, components };
    existing(invalid);
    db.restaurantPromotion.findMany.mockResolvedValue([
      { name: 'Ten percent', versions: [invalid] },
    ]);
    expect((await caller().list())[0]!.editRestriction).toMatch(/read-only/);
    await expect(caller().editOffer({ ...editInput, rule: input })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expectNoWrites();
  });

  it.each([
    ['zero rows', []],
    ['twenty-one rows', Array.from({ length: 21 }, () => mixedComponents[0]!)],
    ...[0, -1, 1.5, '2'].map<[string, unknown[]]>((quantity) => [
      `quantity ${quantity}`,
      [{ ...mixedComponents[0], quantity }],
    ]),
    ['empty alternatives', [{ productIds: [], categoryIds: [], quantity: 1 }]],
    ['forged ordinal', [{ ...mixedComponents[0], ordinal: 0 }]],
    ['forged variant', [{ ...mixedComponents[0], variantIds: ['variant_1'] }]],
  ])('rejects direct input %s before persistence', async (_name, components) => {
    const { input } = prepareBundle();
    await expect(
      caller().editOffer({
        ...editInput,
        rule: { ...input, components: components as ComponentInput[] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expectNoWrites();
  });

  it.each(['product', 'category'])(
    'rejects missing component %s references before writes',
    async (kind) => {
      const { input } = prepareBundle();
      if (kind === 'product') db.restaurantProduct.count.mockResolvedValue(0);
      else db.restaurantCategory.count.mockResolvedValue(0);
      await expect(caller().editOffer({ ...editInput, rule: input })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expectNoWrites();
    }
  );
  it.each([
    { expectedVersionId: 'stale' },
    { expectedRuleHash: 'stale' },
    { expectedUpdatedAt: new Date(0) },
  ])('keeps stale bundle identity %j guarded', async (identity) => {
    const { input } = prepareBundle();
    await expect(
      caller().editOffer({ ...editInput, ...identity, rule: input })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNoWrites();
  });
  it('keeps bundle CAS failure ahead of rename and audit', async () => {
    const { input } = prepareBundle();
    db.restaurantPromotionVersion.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('changed', { code: 'P2025', clientVersion: 'test' })
    );
    await expect(caller().editOffer({ ...editInput, rule: input })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.restaurantPromotion.update).not.toHaveBeenCalled();
    expect(db.restaurantPromotionAuditEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ...[null, 0, 10001, 1.5].map((benefitBasisPoints) => ({ benefitBasisPoints })),
    { benefitAmount: new Prisma.Decimal(0) },
    { buyQuantity: 1 },
    { getQuantity: 1 },
    { benefitKind: 'AMOUNT_OFF', benefitBasisPoints: null, benefitAmount: null },
    { benefitKind: 'AMOUNT_OFF', benefitBasisPoints: null, benefitAmount: new Prisma.Decimal(-1) },
    {
      benefitKind: 'AMOUNT_OFF',
      benefitBasisPoints: null,
      benefitAmount: new Prisma.Decimal('1.001'),
    },
    { benefitKind: 'BUY_X_GET_Y_PERCENT', buyQuantity: 1, getQuantity: null },
    { benefitKind: 'BUY_X_GET_Y_PERCENT', buyQuantity: null, getQuantity: 1 },
    { benefitKind: 'BUY_X_GET_Y_FREE', benefitBasisPoints: 1, buyQuantity: 1, getQuantity: 1 },
    {
      benefitKind: 'BUY_X_GET_Y_FREE',
      benefitBasisPoints: null,
      benefitAmount: new Prisma.Decimal(0),
      buyQuantity: 1,
      getQuantity: 1,
    },
    ...['pkr', ' PKR ', 'PKRR'].map((currency) => ({ currency })),
  ])('rejects unrepresentable stored operands without silent repair: %j', async (changes) => {
    existing(changes);
    db.restaurantPromotion.findMany.mockResolvedValue([
      { name: 'Ten percent', versions: [{ ...draft, ...changes }] },
    ]);
    expect((await caller().list())[0]!.editRestriction).toMatch(/cannot preserve/);
    await expect(caller().editOffer(editInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNoWrites();
  });
  it.each(['', ' ', ' Leading', 'Trailing ', 'Lunch\nspecial', 'Lunch\rspecial', 'x'.repeat(161)])(
    'rejects unrepresentable stored name %j',
    async (name) => {
      const promotion = { id: 'promotion_1', code: 'TENOFF', name, versions: [draft] };
      db.restaurantPromotion.findFirst.mockResolvedValue(promotion);
      db.restaurantPromotion.findMany.mockResolvedValue([promotion]);
      expect((await caller().list())[0]!.editRestriction).toMatch(/cannot preserve/);
      await expect(caller().editOffer(editInput)).rejects.toMatchObject({ code: 'CONFLICT' });
      expectNoWrites();
    }
  );
  it.each([
    { benefitKind: 'PERCENT_OFF', benefitBasisPoints: 1 },
    { benefitKind: 'PERCENT_OFF', benefitBasisPoints: 10000 },
    { benefitKind: 'AMOUNT_OFF', benefitBasisPoints: null, benefitAmount: new Prisma.Decimal(0) },
    { benefitKind: 'FIXED_PRICE', benefitBasisPoints: null, benefitAmount: new Prisma.Decimal(25) },
    {
      benefitKind: 'BUY_X_GET_Y_PERCENT',
      benefitBasisPoints: 5000,
      buyQuantity: 2,
      getQuantity: 1,
    },
    {
      benefitKind: 'BUY_X_GET_Y_AMOUNT',
      benefitBasisPoints: null,
      benefitAmount: new Prisma.Decimal(0),
      buyQuantity: 2,
      getQuantity: 1,
    },
    { benefitKind: 'BUY_X_GET_Y_FREE', benefitBasisPoints: null, buyQuantity: 2, getQuantity: 1 },
  ])('keeps supported stored operands editable: %j', async (changes) => {
    db.restaurantPromotion.findMany.mockResolvedValue([
      {
        name: 'Lunch  offer',
        versions: [
          {
            ...draft,
            ...changes,
            maxBenefitAmount: new Prisma.Decimal(0),
            maxApplicationsPerOrder: 2,
            perOrderCap: 1,
          },
        ],
      },
    ]);
    expect((await caller().list())[0]!.editRestriction).toBeNull();
  });
});

const overlapBundleInput = {
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: null,
  timezone: 'UTC',
  targetKind: 'ORDER',
  includeDescendants: false,
  componentTargeting: false,
  benefitKind: 'BUNDLE_PRICE',
  benefitAmount: '20.00',
  applicationBasis: 'ORDER',
  currency: 'PKR',
  offlinePolicy: 'ALLOW',
  components: [
    { productIds: [], categoryIds: ['parent-x'], quantity: 1 },
    { productIds: ['x', 'y'], categoryIds: ['parent-x'], quantity: 1 },
  ],
} satisfies BundleRuleInput;
const quantityBundleInput = {
  ...overlapBundleInput,
  benefitAmount: '25.00',
  maxApplicationsPerOrder: 2,
  perOrderCap: 1,
  components: [
    { productIds: [], categoryIds: ['parent-x'], quantity: 2 },
    { productIds: ['y'], categoryIds: ['parent-y'], quantity: 1 },
  ],
} satisfies BundleRuleInput;
const bundleProbeContext: PromotionEvaluationContext = {
  evaluatedAt: new Date('2026-01-02T12:00:00.000Z'),
  branchId: 'probe-branch',
  channel: 'DINE_IN',
  currency: 'PKR',
  customerId: null,
  customerSegments: [],
  couponFingerprints: [],
  authorityActorId: null,
  online: true,
};
function bundleProbeLines(xQuantity = 1, yQuantity = 1): PromotionInputLine[] {
  return [
    ['x', 10, xQuantity],
    ['y', 20, yQuantity],
  ].map(([id, price, quantity]) => ({
    orderItemId: `probe-${id}`,
    productId: String(id),
    variantId: null,
    categoryAncestry: [`leaf-${id}`, `parent-${id}`],
    quantity: Number(quantity),
    unitPrice: new Prisma.Decimal(price!),
    modifierDeltas: [],
    compAllocation: new Prisma.Decimal(0),
  }));
}
function capturedBundleDraft(data: CapturedBundle): PromotionRule {
  const value = ruleFromSnapshot(data.ruleSnapshot as CanonicalJson, data.ruleHash);
  expect(value.status).toBe('DRAFT');
  expect(computeRuleHash(value)).toBe(data.ruleHash);
  return value;
}
// Synthetic evaluator input only: never writes or publishes a database version.
function publishedBundleProbe(value: PromotionRule): PromotionRule {
  const copy: PromotionRule = { ...value, status: 'PUBLISHED', ruleHash: '' };
  return { ...copy, ruleHash: computeRuleHash(copy) };
}
function evaluateAndReplayBundle(value: PromotionRule, lines: PromotionInputLine[]) {
  const result = evaluatePromotions({ context: bundleProbeContext, lines, rules: [value] });
  const snapshot = buildEvaluationSnapshot({
    identity: {
      organizationId: 'probe-organization',
      orderId: 'probe-order',
      branchId: bundleProbeContext.branchId,
      idempotencyKey: 'probe-evaluation',
      timezone: 'UTC',
      setRevisionId: 'probe-revision',
      setRevisionHash: 'probe-revision-hash',
      source: 'ONLINE',
      terminalDeviceId: null,
      priceListVersionId: null,
    },
    context: bundleProbeContext,
    lines,
    rules: [value],
    result,
  });
  const replay = reconstructEvaluation({
    inputLines: snapshot.evaluation.inputLines,
    evaluationContext: snapshot.evaluation.evaluationContext,
    candidates: snapshot.candidates,
  });
  expect(computeOutputHash(replay)).toBe(snapshot.evaluation.outputHash);
  const allocated = result.applications
    .flatMap((application) => application.allocations)
    .reduce((total, row) => total.plus(row.allocatedAmount), new Prisma.Decimal(0));
  expect(allocated.toFixed(2)).toBe(result.discountTotal.toFixed(2));
  return result;
}
async function createCapturedBundle(input: BundleRuleInput) {
  allowReferences(input);
  db.restaurantPromotion.create.mockResolvedValue({
    id: 'promotion_1',
    code: 'TENOFF',
    name: 'Probe bundle',
  });
  await caller().createOffer({ code: 'TENOFF', name: 'Probe bundle', rule: input });
  return db.restaurantPromotionVersion.create.mock.calls[0]![0].data;
}
async function editCapturedBundle(
  previous: ReturnType<typeof createCapturedBundle> extends Promise<infer T> ? T : never,
  input: BundleRuleInput
) {
  allowReferences(input);
  existing({ ...previous, components: previous.components.create, updatedAt: draft.updatedAt });
  await caller().editOffer({
    ...editInput,
    expectedVersionId: previous.id,
    expectedRuleHash: previous.ruleHash,
    rule: input,
  });
  return { ...previous, ...db.restaurantPromotionVersion.update.mock.calls.at(-1)![0].data };
}

describe('synthetic bundle authoring to evaluation compatibility', () => {
  it('keeps an unchanged rule hash and changes only ordered components on explicit movement', async () => {
    const created = await createCapturedBundle(overlapBundleInput);
    const unchanged = await editCapturedBundle(created, overlapBundleInput);
    const moved = await editCapturedBundle(unchanged, {
      ...overlapBundleInput,
      components: [...overlapBundleInput.components].reverse(),
    });
    const before = capturedBundleDraft(created),
      same = capturedBundleDraft(unchanged),
      after = capturedBundleDraft(moved);
    expect(same).toEqual(before);
    expect(unchanged.ruleHash).toBe(created.ruleHash);
    expect(after.components).toEqual(
      [...before.components].reverse().map((component, ordinal) => ({ ...component, ordinal }))
    );
    expect({ ...after, components: before.components, ruleHash: before.ruleHash }).toEqual(before);
    expect(moved.ruleHash).not.toBe(created.ruleHash);
  });
  it('preserves draft rejection and ordered mixed-alternative greedy matching with snapshot replay', async () => {
    const created = await createCapturedBundle(overlapBundleInput);
    const moved = await editCapturedBundle(created, {
      ...overlapBundleInput,
      components: [...overlapBundleInput.components].reverse(),
    });
    const value = capturedBundleDraft(created),
      lines = bundleProbeLines();
    const rejected = evaluatePromotions({ context: bundleProbeContext, lines, rules: [value] });
    expect(rejected.applications).toHaveLength(0);
    expect(rejected.candidates[0]?.reasonCode).toBe('NOT_PUBLISHED');
    const accepted = evaluateAndReplayBundle(publishedBundleProbe(value), lines);
    expect(accepted.applications).toHaveLength(1);
    expect(accepted.discountTotal.toFixed(2)).toBe('10.00');
    expect(accepted.applications[0]!.selectedUnits).toEqual([
      { orderItemId: 'probe-x', unitOrdinal: 0 },
      { orderItemId: 'probe-y', unitOrdinal: 0 },
    ]);
    const reversed = evaluateAndReplayBundle(
      publishedBundleProbe(capturedBundleDraft(moved)),
      lines
    );
    expect(reversed.applications).toHaveLength(0);
    expect(reversed.discountTotal.toFixed(2)).toBe('0.00');
  });
  it('preserves component quantities and per-order caps across replay without reusing units', async () => {
    const captured = await createCapturedBundle(quantityBundleInput);
    const value = capturedBundleDraft(captured);
    expect(value.components.map((c) => c.quantity)).toEqual([2, 1]);
    expect(value.maxApplicationsPerOrder).toBe(2);
    expect(value.perOrderCap).toBe(1);
    const lines = bundleProbeLines(4, 2);
    const capped = evaluateAndReplayBundle(publishedBundleProbe(value), lines);
    expect(capped.applications).toHaveLength(1);
    expect(capped.applications[0]!.selectedUnits).toHaveLength(3);
    expect(capped.discountTotal.toFixed(2)).toBe('15.00');
    const uncapped = evaluateAndReplayBundle(
      publishedBundleProbe({ ...value, perOrderCap: null }),
      lines
    );
    expect(uncapped.applications).toHaveLength(2);
    expect(uncapped.discountTotal.toFixed(2)).toBe('30.00');
    const keys = uncapped.applications.flatMap((a) =>
      a.selectedUnits.map((unit) => `${unit.orderItemId}:${unit.unitOrdinal}`)
    );
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    expect(computeRuleHash(value)).toBe(captured.ruleHash);
  });
});
