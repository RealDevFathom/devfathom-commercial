import type { Prisma } from '../src/generated/prisma/client';
import { businessDateToUtcDate } from '../src/lib/restaurant/business-date';
import { activateVersion } from '../src/lib/restaurant/effective-dating';

export interface ChaichowkCateringFixtureContext {
  organizationId: string;
  branchId: string;
  ownerUserId: string;
  /** Pinned YYYY-MM-DD for this namespace; do not advance it on reruns. */
  businessDate: string;
  timezone: string;
  id(key: string): string;
}

const DEMO = 'DEMO ONLY — synthetic Chai Chowk catering scenario';
const DAY = 86_400_000;

export const CHAICHOWK_CATERING_GAPS = [
  'CONFIRMED / IN_PRODUCTION: computeRecipeCost opens withTenantDb, outside the supplied transaction. Confirm through the authorized catering service after apply to obtain genuine cost snapshots.',
  'READY: recipe explosion opens withTenantDb and consumption is router-private. No stock items, opening balances or consumption are invented. Configure stock and use the authorized production transition.',
  'DELIVERED / CLOSED: no dispatch, physical delivery, payment or completion is asserted. Planned delivery remains unsent; complete through normal operational gates.',
  'Production history: only pre-production demo history is provided. Post-production cancellation/reversal requires actual consumption and the domain reversal path.',
] as const;

type Step = {
  key: string;
  id: string;
  table: string;
  expected: Record<string, unknown>;
  read(): Promise<unknown>;
  create(): Promise<unknown>;
};

// Compare only explicit fixture fields, including timestamps. Decimal objects
// serialize as strings in Prisma; JSON key order is not identity.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function assertUnchanged(step: Step, observed: unknown) {
  if (!observed || typeof observed !== 'object') throw new Error(`Missing ${step.key}`);
  const record = observed as Record<string, unknown>;
  for (const [field, expected] of Object.entries(step.expected)) {
    if (canonical(record[field]) !== canonical(expected)) {
      // Deliberately omit field contents: failures must not print tenant data.
      throw new Error(`Catering fixture conflict: ${step.key}.${field}; refusing overwrite`);
    }
  }
}

/**
 * Call ONLY inside WHA-1382's guarded seed transaction:
 *   await seedChaichowkCateringFixtures(tx, context)
 * The caller owns target/owner/module/capability guards, rollback on ANY error,
 * namespace/version manifest and protection against whole-namespace deletion.
 * This helper creates no connection, transaction, role, permission or external
 * effect. Nullable staff actors stay null: ownerUserId is not a staff identity.
 * No router is invoked: it would open nested transactions/connections.
 */
export async function seedChaichowkCateringFixtures(
  tx: Prisma.TransactionClient,
  context: ChaichowkCateringFixtureContext
) {
  if (Reflect.has(tx, '$transaction'))
    throw new Error('Catering fixtures require an existing transaction');
  const { organizationId, branchId, ownerUserId, timezone } = context;
  if (![organizationId, branchId, ownerUserId].every((value) => value.trim())) {
    throw new Error('Catering fixture context requires tenant, branch and owner');
  }
  // This Pakistan-only fixture refuses timezone guessing. @db.Date values are
  // UTC midnight; delivery timestamps are explicitly Karachi local noon.
  if (timezone !== 'Asia/Karachi') throw new Error('Catering fixtures require Asia/Karachi');
  const businessDay = businessDateToUtcDate(context.businessDate);
  const atDay = (offset: number) => new Date(businessDay.getTime() + offset * DAY);
  const createdAt = atDay(-60);
  const stamp = { organizationId, createdAt, updatedAt: createdAt };
  const branch = await tx.restaurantBranch.findFirst({
    where: { id: branchId, organizationId, active: true, timezone },
    select: { id: true },
  });
  if (!branch) throw new Error('Catering fixture branch missing, inactive or mismatched');

  const keys = new Map<string, string>();
  const used = new Set<string>();
  function id(key: string) {
    const fullKey = `catering.${key}`;
    const cached = keys.get(fullKey);
    if (cached) return cached;
    const value = context.id(fullKey);
    if (!value || used.has(value)) throw new Error(`Catering fixture ID collision: ${fullKey}`);
    keys.set(fullKey, value);
    used.add(value);
    return value;
  }

  const steps: Step[] = [];
  function add(
    key: string,
    table: string,
    expected: Record<string, unknown> & { id: string },
    read: Step['read'],
    create: Step['create']
  ) {
    steps.push({ key: `catering.${key}`, id: expected.id, table, expected, read, create });
  }

  const unit = { ...stamp, id: id('unit.kg'), name: 'DEMO Catering kilogram', abbreviation: 'kg' };
  add(
    'unit.kg',
    'restaurantUnit',
    unit,
    () => tx.restaurantUnit.findUnique({ where: { id: unit.id } }),
    () => tx.restaurantUnit.create({ data: unit })
  );
  const ingredient = {
    ...stamp,
    id: id('ingredient.rice'),
    name: 'DEMO Catering basmati rice',
    baseUnitId: unit.id,
    referenceCost: '320',
  };
  add(
    'ingredient.rice',
    'restaurantIngredient',
    ingredient,
    () => tx.restaurantIngredient.findUnique({ where: { id: ingredient.id } }),
    () => tx.restaurantIngredient.create({ data: ingredient })
  );
  const product = {
    ...stamp,
    id: id('product.rice-tray'),
    name: 'DEMO Catering steamed rice tray',
    description: `${DEMO}. Dedicated catering catalog; no menu publication or stock implied.`,
    type: 'ITEM' as const,
    status: 'ACTIVE' as const,
    categoryId: null,
    sortOrder: 0,
  };
  add(
    'product.rice-tray',
    'restaurantProduct',
    product,
    () => tx.restaurantProduct.findUnique({ where: { id: product.id } }),
    () => tx.restaurantProduct.create({ data: product })
  );
  const recipe = {
    ...stamp,
    id: id('recipe.rice-tray'),
    productId: product.id,
    name: 'DEMO Catering rice tray — 20 portions',
    variantId: null,
  };
  add(
    'recipe.rice-tray',
    'restaurantRecipe',
    recipe,
    () => tx.restaurantRecipe.findUnique({ where: { id: recipe.id } }),
    () => tx.restaurantRecipe.create({ data: recipe })
  );
  const versionId = id('recipe.rice-tray.v1');
  const version = {
    ...stamp,
    id: versionId,
    recipeId: recipe.id,
    versionNumber: 1,
    portionCount: 20,
    yieldQuantity: null,
    yieldUnitId: null,
    supersededAt: null,
    notes: `${DEMO}. Theoretical 3 kg rice per 20 portions; reference costs are estimates.`,
    ...activateVersion({ id: versionId, status: 'DRAFT' }, createdAt),
  };
  add(
    'recipe.rice-tray.v1',
    'restaurantRecipeVersion',
    version,
    () => tx.restaurantRecipeVersion.findUnique({ where: { id: version.id } }),
    () => tx.restaurantRecipeVersion.create({ data: version })
  );
  const recipeLine = {
    ...stamp,
    id: id('recipe.rice-tray.v1.rice'),
    recipeVersionId: version.id,
    ingredientId: ingredient.id,
    subRecipeId: null,
    quantity: '3',
    unitId: unit.id,
    sortOrder: 0,
  };
  add(
    'recipe.rice-tray.v1.rice',
    'restaurantRecipeLine',
    recipeLine,
    () => tx.restaurantRecipeLine.findUnique({ where: { id: recipeLine.id } }),
    () => tx.restaurantRecipeLine.create({ data: recipeLine })
  );

  const customer = {
    ...stamp,
    id: id('customer.community'),
    displayName: 'DEMO Community Catering Customer',
    givenName: null,
    familyName: null,
    birthDate: null,
    anonymizedAt: null,
    notes: `${DEMO}. No real contact identifiers, marketing consent or approvals.`,
  };
  add(
    'customer.community',
    'restaurantCustomer',
    customer,
    () => tx.restaurantCustomer.findUnique({ where: { id: customer.id } }),
    () => tx.restaurantCustomer.create({ data: customer })
  );

  const scenarios = [
    { key: 'today-draft', title: 'Today menu planning', day: 0, guests: 40, status: 'DRAFT' },
    { key: 'future-quote', title: 'Community lunch quote', day: 14, guests: 100, status: 'QUOTED' },
    {
      key: 'production-prep',
      title: 'Production planning — awaiting confirmation',
      day: 1,
      guests: 60,
      status: 'QUOTED',
    },
    {
      key: 'historical-cancel',
      title: 'Historical quote cancelled before production',
      day: -21,
      guests: 80,
      status: 'CANCELLED',
    },
  ] as const;
  for (const scenario of scenarios) {
    const key = `order.${scenario.key}`;
    const orderStamp = {
      organizationId,
      createdAt: atDay(Math.min(scenario.day - 7, 0)),
      updatedAt: atDay(Math.min(scenario.day - 7, 0)),
    };
    const order = {
      ...orderStamp,
      id: id(key),
      branchId,
      customerId: customer.id,
      eventName: `DEMO — ${scenario.title}`,
      eventDate: atDay(scenario.day),
      serviceTime: new Date('1970-01-01T12:00:00.000Z'),
      headcount: scenario.guests,
      venueAddress: 'DEMO venue — synthetic Karachi catering location',
      deliveryAddressId: null,
      status: scenario.status,
      quotedTotal: scenario.status === 'DRAFT' ? null : String(scenario.guests * 180),
      depositAmount: null,
      createdByStaffId: null,
      notes: `${DEMO}. ${scenario.key === 'production-prep' ? 'Production has NOT started; confirm with cost snapshots first. ' : ''}No real approval, payment, dispatch or physical success.`,
    };
    add(
      key,
      'restaurantCateringOrder',
      order,
      () => tx.restaurantCateringOrder.findUnique({ where: { id: order.id } }),
      () => tx.restaurantCateringOrder.create({ data: order })
    );
    const line = {
      ...orderStamp,
      id: id(`${key}.line`),
      orderId: order.id,
      productId: product.id,
      recipeId: recipe.id,
      description: 'DEMO steamed rice portions',
      portions: String(scenario.guests),
      unitPrice: '180',
      costPerPortionSnapshot: null,
      sortOrder: 0,
    };
    add(
      `${key}.line`,
      'restaurantCateringOrderLine',
      line,
      () => tx.restaurantCateringOrderLine.findUnique({ where: { id: line.id } }),
      () => tx.restaurantCateringOrderLine.create({ data: line })
    );

    const history: Array<{ eventType: string; payload: Prisma.InputJsonObject }> = [
      { eventType: 'CREATED', payload: { status: 'DRAFT' } },
      { eventType: 'LINE_ADDED', payload: { lineId: line.id } },
    ];
    for (const [kind, amount] of [
      ['LABOUR', '1200'],
      ['TRANSPORT', '800'],
      ['RENTAL', '600'],
      ['OTHER', '200'],
    ] as const) {
      const costKey = `${key}.cost.${kind.toLowerCase()}`;
      const cost = {
        ...orderStamp,
        id: id(costKey),
        orderId: order.id,
        kind,
        amount,
        label: `DEMO estimated ${kind.toLowerCase()}`,
      };
      add(
        costKey,
        'restaurantCateringExtraCost',
        cost,
        () => tx.restaurantCateringExtraCost.findUnique({ where: { id: cost.id } }),
        () => tx.restaurantCateringExtraCost.create({ data: cost })
      );
      history.push({ eventType: 'EXTRA_COST_ADDED', payload: { extraCostId: cost.id } });
    }
    if (scenario.status !== 'CANCELLED') {
      const delivery = {
        ...orderStamp,
        id: id(`${key}.delivery`),
        orderId: order.id,
        scheduledAt: new Date(`${order.eventDate.toISOString().slice(0, 10)}T12:00:00+05:00`),
        dispatchedAt: null,
        deliveredAt: null,
        driverStaffId: null,
        vehicle: null,
        notes: `${DEMO}. Planned only; assign legitimate driver before dispatch.`,
      };
      add(
        `${key}.delivery`,
        'restaurantCateringDelivery',
        delivery,
        () => tx.restaurantCateringDelivery.findUnique({ where: { id: delivery.id } }),
        () => tx.restaurantCateringDelivery.create({ data: delivery })
      );
      history.push({
        eventType: 'DELIVERY_SET',
        payload: { scheduledAt: delivery.scheduledAt.toISOString() },
      });
    }
    if (scenario.status !== 'DRAFT')
      history.push({ eventType: 'STATUS_TRANSITIONED', payload: { from: 'DRAFT', to: 'QUOTED' } });
    if (scenario.status === 'CANCELLED')
      history.push({
        eventType: 'STATUS_TRANSITIONED',
        payload: { from: 'QUOTED', to: 'CANCELLED' },
      });
    for (const [index, entry] of history.entries()) {
      const eventKey = `${key}.event.${index + 1}`;
      const event = {
        id: id(eventKey),
        organizationId,
        orderId: order.id,
        sequence: index + 1,
        eventType: entry.eventType,
        actorStaffProfileId: null,
        createdAt: orderStamp.createdAt,
        payload: { ...entry.payload, demo: true, source: 'WHA-1386', syntheticHistory: true },
      };
      add(
        eventKey,
        'restaurantCateringEvent',
        event,
        () => tx.restaurantCateringEvent.findUnique({ where: { id: event.id } }),
        () => tx.restaurantCateringEvent.create({ data: event })
      );
    }
  }

  // Preflight the entire batch before the first mutation. A partial namespace
  // may be user deletion, not interrupted seeding (caller transaction is atomic).
  const observations: unknown[] = [];
  for (const step of steps) observations.push(await step.read());
  const existing = observations.filter((row) => row != null).length;
  if (existing && existing !== steps.length) {
    throw new Error('Catering fixture namespace is partial; refusing to resurrect deleted data');
  }
  if (existing) steps.forEach((step, index) => assertUnchanged(step, observations[index]));
  const counts: Record<string, { inserted: number; existing: number }> = {};
  for (const step of steps) {
    const count = (counts[step.table] ??= { inserted: 0, existing: 0 });
    if (existing) count.existing++;
    else {
      assertUnchanged(step, await step.create());
      count.inserted++;
    }
  }
  return {
    inserted: existing ? 0 : steps.length,
    existing,
    counts,
    orderIds: scenarios.map((scenario) => id(`order.${scenario.key}`)),
    coveredStatuses: ['DRAFT', 'QUOTED', 'CANCELLED'] as const,
    gaps: [...CHAICHOWK_CATERING_GAPS],
  };
}
