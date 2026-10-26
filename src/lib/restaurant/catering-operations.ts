import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { computeRecipeCostInDb } from './recipe-costing';
import { resolveActiveVersion } from './effective-dating';
import { summarizeCateringMoney, type CateringEvidence } from './catering-money';
import { postStockMovements } from './inventory-ledger';

export function fail(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message });
}
export type BookingState = {
  bookingStartsAt: Date | null;
  bookingEndsAt: Date | null;
  fulfillmentMode: 'PICKUP' | 'DELIVERY' | null;
  stockLocationId: string | null;
  revision: number;
  approvedQuoteRevisionId: string | null;
  confirmedQuoteRevisionId: string | null;
};
export type FrozenRequirement = {
  ingredientId: string;
  ingredientName: string;
  baseUnitId: string;
  stockItemId: string | null;
  quantityInBaseUnit: string;
  unitCost: string | null;
  costSource: 'WEIGHTED_AVERAGE' | 'REFERENCE' | 'MISSING';
};
export type QuoteSnapshot = {
  schemaVersion: 1;
  currency: string;
  quotedTotal: string;
  headcount: number;
  bookingStartsAt: string | null;
  bookingEndsAt: string | null;
  fulfillmentMode: BookingState['fulfillmentMode'];
  stockLocationId: string | null;
  lines: Array<{
    id: string;
    productId: string | null;
    recipeId: string | null;
    recipeVersionId: string | null;
    description: string;
    portions: string;
    unitPrice: string;
    requirements: FrozenRequirement[];
  }>;
  extraCosts: Array<{ kind: string; label: string; amount: string }>;
  requirements: FrozenRequirement[];
  missing: string[];
};
export type Quote = { id: string; revision: number; snapshot: QuoteSnapshot; contentHash: string };
export function payloadHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export async function lockOrder(tx: ScopedDb, orderId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${orderId},0))`);
}
export async function lockBranch(tx: ScopedDb, org: string, branch: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`catering:branch:${org}:${branch}`},0))`
  );
}
export async function bookingState(
  tx: ScopedDb,
  org: string,
  orderId: string
): Promise<BookingState> {
  const rows = await tx.$queryRaw<BookingState[]>(
    Prisma.sql`SELECT "bookingStartsAt", "bookingEndsAt", "fulfillmentMode", "stockLocationId", revision, "approvedQuoteRevisionId", "confirmedQuoteRevisionId" FROM restaurant_catering_orders WHERE "organizationId"=${org} AND id=${orderId}`
  );
  if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Catering order not found.' });
  return rows[0];
}
export async function invalidateQuote(tx: ScopedDb, org: string, orderId: string) {
  await lockOrder(tx, orderId);
  const order = await tx.restaurantCateringOrder.findFirst({
    where: { organizationId: org, id: orderId },
  });
  if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
  if (!['DRAFT', 'QUOTED'].includes(order.status))
    fail('Confirmed or terminal catering orders cannot be edited.');
  await tx.$executeRaw(
    Prisma.sql`UPDATE restaurant_catering_orders SET revision=revision+1,"approvedQuoteRevisionId"=NULL WHERE "organizationId"=${org} AND id=${orderId}`
  );
}
export function peakHeadcount(
  rows: Array<{ bookingStartsAt: Date; bookingEndsAt: Date; headcount: number }>
) {
  const points = rows.flatMap((r) => [
    { at: r.bookingStartsAt.getTime(), delta: r.headcount },
    { at: r.bookingEndsAt.getTime(), delta: -r.headcount },
  ]);
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0,
    peak = 0;
  for (const p of points) {
    current += p.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}
const reservations = Prisma.sql`('CONFIRMED','IN_PRODUCTION','READY','DELIVERED','CLOSED')`;
export async function availability(tx: ScopedDb, org: string, branch: string, orderId?: string) {
  const capacity = await tx.$queryRaw<Array<{ maxConcurrentHeadcount: number | null }>>(
    Prisma.sql`SELECT "maxConcurrentHeadcount" FROM restaurant_catering_branch_capacity WHERE "organizationId"=${org} AND "branchId"=${branch}`
  );
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      bookingStartsAt: Date | null;
      bookingEndsAt: Date | null;
      headcount: number;
    }>
  >(
    Prisma.sql`SELECT id,"bookingStartsAt","bookingEndsAt",headcount FROM restaurant_catering_orders WHERE "organizationId"=${org} AND "branchId"=${branch} AND (status::text IN ${reservations} OR id=${orderId ?? ''})`
  );
  const limit = capacity[0]?.maxConcurrentHeadcount ?? null;
  if (limit === null || rows.some((r) => !r.bookingStartsAt || !r.bookingEndsAt))
    return {
      capacityStatus: 'UNKNOWN' as const,
      maxConcurrentHeadcount: limit,
      peakHeadcount: null,
    };
  const peak = peakHeadcount(
    rows as Array<{ bookingStartsAt: Date; bookingEndsAt: Date; headcount: number }>
  );
  return {
    capacityStatus: peak > limit ? ('EXCEEDED' as const) : ('AVAILABLE' as const),
    maxConcurrentHeadcount: limit,
    peakHeadcount: peak,
  };
}
export async function setCapacity(tx: ScopedDb, org: string, branch: string, limit: number | null) {
  await lockBranch(tx, org, branch);
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO restaurant_catering_branch_capacity ("organizationId","branchId","maxConcurrentHeadcount") VALUES (${org},${branch},${limit}) ON CONFLICT ("organizationId","branchId") DO UPDATE SET "maxConcurrentHeadcount"=EXCLUDED."maxConcurrentHeadcount"`
  );
  const result = await availability(tx, org, branch);
  if (
    result.capacityStatus === 'EXCEEDED' ||
    (limit !== null && result.capacityStatus === 'UNKNOWN')
  )
    fail('Capacity is below existing reservations.');
  return result;
}
export async function setBooking(
  tx: ScopedDb,
  org: string,
  orderId: string,
  input: {
    bookingStartsAt: Date;
    bookingEndsAt: Date;
    fulfillmentMode: 'PICKUP' | 'DELIVERY';
    stockLocationId: string;
  }
) {
  if (input.bookingEndsAt <= input.bookingStartsAt) fail('Booking end must follow start.');
  await invalidateQuote(tx, org, orderId);
  await tx.$executeRaw(
    Prisma.sql`UPDATE restaurant_catering_orders SET "bookingStartsAt"=${input.bookingStartsAt},"bookingEndsAt"=${input.bookingEndsAt},"fulfillmentMode"=${input.fulfillmentMode},"stockLocationId"=${input.stockLocationId} WHERE "organizationId"=${org} AND id=${orderId}`
  );
  return bookingState(tx, org, orderId);
}
export async function quoteById(tx: ScopedDb, org: string, orderId: string, quoteId: string) {
  const rows = await tx.$queryRaw<Quote[]>(
    Prisma.sql`SELECT id,revision,snapshot,"contentHash" FROM restaurant_catering_quote_revisions WHERE "organizationId"=${org} AND "orderId"=${orderId} AND id=${quoteId}`
  );
  if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Quote revision not found.' });
  return rows[0];
}
export async function frozenQuote(tx: ScopedDb, org: string, orderId: string) {
  const state = await bookingState(tx, org, orderId);
  return state.confirmedQuoteRevisionId
    ? quoteById(tx, org, orderId, state.confirmedQuoteRevisionId)
    : null;
}
export async function publishQuote(
  tx: ScopedDb,
  org: string,
  orderId: string,
  currency: string,
  staff: string
) {
  await lockOrder(tx, orderId);
  const order = await tx.restaurantCateringOrder.findFirst({
    where: { organizationId: org, id: orderId },
    include: { lines: { orderBy: { id: 'asc' } }, extraCosts: { orderBy: { id: 'asc' } } },
  });
  if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
  if (!['DRAFT', 'QUOTED'].includes(order.status)) fail('Only editable orders can publish quotes.');
  if (!order.quotedTotal || order.lines.length === 0) fail('Quote total and menu are required.');
  if (order.lines.some((line) => !line.recipeId))
    fail('A recipe is required for every quoted line.');
  const state = await bookingState(tx, org, orderId);
  const existing = await tx.$queryRaw<Quote[]>(
    Prisma.sql`SELECT id,revision,snapshot,"contentHash" FROM restaurant_catering_quote_revisions WHERE "organizationId"=${org} AND "orderId"=${orderId} AND revision=${state.revision}`
  );
  if (existing[0]) {
    if (existing[0].snapshot.currency !== currency)
      fail('Edit the order before publishing a different currency.');
    return existing[0];
  }
  const snapshot: QuoteSnapshot = {
    schemaVersion: 1,
    currency,
    quotedTotal: order.quotedTotal.toString(),
    headcount: order.headcount,
    bookingStartsAt: state.bookingStartsAt?.toISOString() ?? null,
    bookingEndsAt: state.bookingEndsAt?.toISOString() ?? null,
    fulfillmentMode: state.fulfillmentMode,
    stockLocationId: state.stockLocationId,
    lines: [],
    extraCosts: order.extraCosts.map((c) => ({
      kind: c.kind,
      label: c.label,
      amount: c.amount.toString(),
    })),
    requirements: [],
    missing: [],
  };
  const grouped = new Map<string, FrozenRequirement>();
  for (const line of order.lines) {
    // Keep this local guard in addition to the preflight check above so
    // recipeId is narrowed before it is passed to Prisma.
    if (!line.recipeId) fail('A recipe is required for every quoted line.');
    // Pin the root before costing: the helper's quantities and denominators must
    // describe that same version even if another transaction activates a recipe.
    const version = resolveActiveVersion(
      await tx.restaurantRecipeVersion.findMany({
        where: { organizationId: org, recipeId: line.recipeId },
        select: { id: true, status: true },
      })
    );
    if (!version) fail('Recipe has no active version.');
    const cost = await computeRecipeCostInDb(tx, {
      organizationId: org,
      recipeVersionId: version.id,
    });
    if (!cost.portionCount || cost.portionCount <= 0)
      fail('Portion scaling requires a positive portion count.');
    const scale = line.portions.dividedBy(cost.portionCount);
    const requirements: FrozenRequirement[] = [];
    if (!cost.lines.length || !line.portions.isPositive())
      snapshot.missing.push(`line:${line.id}`);
    for (const leaf of cost.lines) {
      const unitCost = leaf.source === 'MISSING' ? null : leaf.unitCost.toString();
      const row: FrozenRequirement = {
        ingredientId: leaf.ingredientId,
        ingredientName: leaf.ingredientName,
        baseUnitId: leaf.baseUnitId,
        stockItemId: leaf.stockItemId,
        quantityInBaseUnit: leaf.quantityInBaseUnit.times(scale).toString(),
        unitCost,
        costSource: leaf.source,
      };
      if (!leaf.stockItemId || unitCost === null || !leaf.quantityInBaseUnit.isPositive())
        snapshot.missing.push(leaf.ingredientId);
      requirements.push(row);
      const prior = grouped.get(row.ingredientId);
      if (
        prior &&
        (prior.baseUnitId !== row.baseUnitId ||
          prior.stockItemId !== row.stockItemId ||
          prior.unitCost !== row.unitCost ||
          prior.costSource !== row.costSource)
      )
        fail('Ingredient changed while quoting; retry.');
      grouped.set(
        row.ingredientId,
        prior
          ? {
              ...row,
              quantityInBaseUnit: new Prisma.Decimal(prior.quantityInBaseUnit)
                .plus(row.quantityInBaseUnit)
                .toString(),
            }
          : row
      );
    }
    snapshot.lines.push({
      id: line.id,
      productId: line.productId,
      recipeId: line.recipeId,
      recipeVersionId: cost?.recipeVersionId ?? null,
      description: line.description,
      portions: line.portions.toString(),
      unitPrice: line.unitPrice.toString(),
      requirements,
    });
  }
  snapshot.requirements = [...grouped.values()];
  const quote: Quote = {
    id: randomUUID(),
    revision: state.revision,
    snapshot,
    contentHash: payloadHash(snapshot),
  };
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO restaurant_catering_quote_revisions (id,"organizationId","orderId",revision,snapshot,"contentHash","createdByStaffId") VALUES (${quote.id},${org},${orderId},${quote.revision},${JSON.stringify(snapshot)}::jsonb,${quote.contentHash},${staff})`
  );
  return quote;
}
export async function approveQuote(
  tx: ScopedDb,
  org: string,
  orderId: string,
  quoteId: string,
  staff: string
) {
  await lockOrder(tx, orderId);
  const order = await tx.restaurantCateringOrder.findFirst({
    where: { organizationId: org, id: orderId },
  });
  if (!order || !['DRAFT', 'QUOTED'].includes(order.status)) fail('Order is not editable.');
  const state = await bookingState(tx, org, orderId),
    quote = await quoteById(tx, org, orderId, quoteId);
  if (quote.revision !== state.revision) fail('Quote approval is stale.');
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO restaurant_catering_quote_approvals (id,"organizationId","orderId","quoteRevisionId","orderRevision","actorStaffProfileId") VALUES (${randomUUID()},${org},${orderId},${quoteId},${state.revision},${staff}) ON CONFLICT ("organizationId","orderId","quoteRevisionId") DO NOTHING`
  );
  await tx.$executeRaw(
    Prisma.sql`UPDATE restaurant_catering_orders SET "approvedQuoteRevisionId"=${quoteId} WHERE "organizationId"=${org} AND id=${orderId}`
  );
  return { quoteRevisionId: quoteId, orderRevision: state.revision };
}
export async function confirmQuote(tx: ScopedDb, org: string, orderId: string, branch: string) {
  const state = await bookingState(tx, org, orderId);
  if (!state.approvedQuoteRevisionId) fail('Explicit quote approval required.');
  const quote = await quoteById(tx, org, orderId, state.approvedQuoteRevisionId!);
  const approval = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM restaurant_catering_quote_approvals WHERE "organizationId"=${org} AND "orderId"=${orderId} AND "quoteRevisionId"=${quote.id} AND "orderRevision"=${state.revision}`
  );
  if (quote.revision !== state.revision || !approval.length) fail('Quote approval is stale.');
  if (
    !state.bookingStartsAt ||
    !state.bookingEndsAt ||
    !state.fulfillmentMode ||
    !state.stockLocationId ||
    quote.snapshot.missing.length ||
    !quote.snapshot.requirements.length
  )
    fail('Booking, recipe, stock links or cost information is incomplete.');
  const location = await tx.restaurantStockLocation.findFirst({
    where: { organizationId: org, id: state.stockLocationId, branchId: branch, isActive: true },
  });
  if (!location) fail('An active stock location in this branch is required.');
  if ((await availability(tx, org, branch, orderId)).capacityStatus !== 'AVAILABLE')
    fail('Branch capacity is unknown or exceeded.');
  await tx.$executeRaw(
    Prisma.sql`UPDATE restaurant_catering_orders SET "confirmedQuoteRevisionId"=${quote.id} WHERE "organizationId"=${org} AND id=${orderId}`
  );
  for (const line of quote.snapshot.lines) {
    const cost = line.requirements.reduce(
      (sum, r) => sum.plus(new Prisma.Decimal(r.quantityInBaseUnit).times(r.unitCost!)),
      new Prisma.Decimal(0)
    );
    await tx.restaurantCateringOrderLine.updateMany({
      where: { organizationId: org, orderId, id: line.id },
      data: { costPerPortionSnapshot: cost.dividedBy(line.portions) },
    });
  }
  return quote;
}
export async function consumeFrozen(
  tx: ScopedDb,
  org: string,
  orderId: string,
  branch: string,
  staff: string
) {
  const quote = await frozenQuote(tx, org, orderId);
  if (!quote) fail('Legacy production requirements are unknown; a frozen quote is required.');
  const snapshot = quote!.snapshot;
  const location = await tx.restaurantStockLocation.findFirst({
    where: {
      organizationId: org,
      id: snapshot.stockLocationId ?? '',
      branchId: branch,
      isActive: true,
    },
  });
  if (!location || !snapshot.requirements.length || snapshot.missing.length)
    fail('Production stock prerequisites are incomplete.');
  const movements = [];
  for (const r of snapshot.requirements) {
    if (!r.stockItemId) fail('Ingredient stock link is missing.');
    const item = await tx.restaurantStockItem.findFirst({
      where: { organizationId: org, id: r.stockItemId!, ingredientId: r.ingredientId },
      select: { id: true },
    });
    if (!item) fail('Frozen ingredient stock link is unavailable.');
    movements.push({
      stockItemId: r.stockItemId!,
      locationId: location!.id,
      unitId: r.baseUnitId,
      reason: 'RECIPE_CONSUMPTION' as const,
      quantity: new Prisma.Decimal(r.quantityInBaseUnit).negated(),
    });
  }
  return postStockMovements(tx, {
    commandType: 'catering.ready',
    actor: { staffProfileId: staff, idempotencyKey: `catering:${orderId}:consumption` },
    movements,
  });
}
export function snapshotCosts(snapshot: QuoteSnapshot) {
  const missing = snapshot.missing;
  const ingredientCost = missing.length
    ? null
    : snapshot.requirements.reduce(
        (sum, r) => sum.plus(new Prisma.Decimal(r.quantityInBaseUnit).times(r.unitCost!)),
        new Prisma.Decimal(0)
      );
  const extraCost = snapshot.extraCosts.reduce(
    (sum, c) => sum.plus(c.amount),
    new Prisma.Decimal(0)
  );
  const total = ingredientCost?.plus(extraCost) ?? null;
  const quotedTotal = new Prisma.Decimal(snapshot.quotedTotal);
  const grossMargin = total ? quotedTotal.minus(total) : null;
  const marginPercent =
    grossMargin && !quotedTotal.isZero() ? grossMargin.dividedBy(quotedTotal).times(100) : null;
  return {
    costBasis: missing.length ? 'MISSING' : 'ESTIMATED',
    missing,
    ingredientCost: ingredientCost?.toString() ?? null,
    recipeCost: ingredientCost?.toString() ?? null,
    extraCost: extraCost.toString(),
    totalCost: total?.toString() ?? null,
    quotedTotal: snapshot.quotedTotal,
    grossMargin: grossMargin?.toString() ?? null,
    marginPercent: marginPercent?.toString() ?? null,
    actualCost: null,
  };
}
export async function recordDisposition(
  tx: ScopedDb,
  org: string,
  orderId: string,
  staff: string,
  input: {
    originalMovementId: string;
    kind: 'UNUSED_RETURN' | 'WASTE' | 'NO_RETURN';
    quantity: string;
    reason: string;
    idempotencyKey: string;
  }
) {
  await lockOrder(tx, orderId);
  const hash = payloadHash({
    ...input,
    quantity: new Prisma.Decimal(input.quantity).toString(),
    staff,
  });
  const prior = await tx.$queryRaw<Array<{ id: string; payloadHash: string }>>(
    Prisma.sql`SELECT id,"payloadHash" FROM restaurant_catering_dispositions WHERE "organizationId"=${org} AND "orderId"=${orderId} AND "idempotencyKey"=${input.idempotencyKey}`
  );
  if (prior[0]) {
    if (prior[0].payloadHash !== hash) fail('Disposition replay payload changed.');
    return { id: prior[0].id, replayed: true };
  }
  const order = await tx.restaurantCateringOrder.findFirst({
    where: { organizationId: org, id: orderId },
  });
  if (!order || order.status !== 'CANCELLED')
    fail('Physical cancellation disposition requires a cancelled order.');
  const originalKey = await tx.restaurantInventoryIdempotencyKey.findFirst({
    where: { organizationId: org, key: `catering:${orderId}:consumption` },
  });
  if (!originalKey?.resultRef?.split(',').includes(input.originalMovementId))
    fail('Movement does not belong to this catering consumption.');
  const historical = await tx.restaurantInventoryIdempotencyKey.findFirst({
    where: { organizationId: org, key: `catering:${orderId}:reversal` },
  });
  if (historical) fail('Historical automatic reversal requires reconciliation before disposition.');
  const original = await tx.restaurantStockMovement.findFirst({
    where: { organizationId: org, id: input.originalMovementId, reason: 'RECIPE_CONSUMPTION' },
    include: {
      stockItem: { select: { canonicalUnitId: true } },
      location: { select: { branchId: true, isActive: true } },
    },
  });
  if (!original || !original.quantity.isNegative() || original.location.branchId !== order.branchId)
    fail('Original consumption is unavailable in this branch.');
  const sums = await tx.$queryRaw<Array<{ allocated: Prisma.Decimal }>>(
    Prisma.sql`SELECT COALESCE(sum(quantity),0) AS allocated FROM restaurant_catering_dispositions WHERE "organizationId"=${org} AND "orderId"=${orderId} AND "originalMovementId"=${input.originalMovementId}`
  );
  const quantity = new Prisma.Decimal(input.quantity);
  if (
    !quantity.isPositive() ||
    quantity.plus(sums[0]?.allocated ?? 0).greaterThan(original!.quantity.negated())
  )
    fail('Disposition exceeds unallocated original consumption.');
  let resultMovementId: string | null = null;
  if (input.kind === 'UNUSED_RETURN') {
    if (!original!.location.isActive) fail('Return location is inactive.');
    const posted = await postStockMovements(tx, {
      commandType: 'catering.unused-return',
      actor: {
        staffProfileId: staff,
        idempotencyKey: `catering:${orderId}:disposition:${input.idempotencyKey}`,
      },
      movements: [
        {
          stockItemId: original!.stockItemId,
          locationId: original!.locationId,
          batchId: original!.batchId,
          unitId: original!.stockItem.canonicalUnitId,
          quantity,
          reason: 'SALE_REVERSAL',
        },
      ],
    });
    resultMovementId = posted.movements[0]!.id;
  }
  const dispositionId = randomUUID();
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO restaurant_catering_dispositions (id,"organizationId","orderId","originalMovementId",kind,quantity,"resultMovementId",reason,"actorStaffProfileId","idempotencyKey","payloadHash") VALUES (${dispositionId},${org},${orderId},${input.originalMovementId},${input.kind},${quantity.toString()}::numeric,${resultMovementId},${input.reason},${staff},${input.idempotencyKey},${hash})`
  );
  return { id: dispositionId, replayed: false };
}

/** Current approved quote and evidence are read under the same lock as money commands. */
export async function paymentSummary(tx: ScopedDb, org: string, orderId: string, branch: string) {
  await lockOrder(tx, orderId);
  const order = await tx.restaurantCateringOrder.findFirst({
    where: { organizationId: org, id: orderId, branchId: branch },
  });
  if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
  const quotes = await tx.$queryRaw<Array<{ quotedTotal: string; currency: string }>>(
    Prisma.sql`SELECT q.snapshot->>'quotedTotal' AS "quotedTotal",q.snapshot->>'currency' AS currency
      FROM restaurant_catering_orders o JOIN restaurant_catering_quote_revisions q
      ON q.id=o."approvedQuoteRevisionId" AND q."organizationId"=o."organizationId" AND q."orderId"=o.id AND q.revision=o.revision
      JOIN restaurant_catering_quote_approvals a ON a."organizationId"=o."organizationId" AND a."orderId"=o.id AND a."quoteRevisionId"=q.id AND a."orderRevision"=o.revision
      WHERE o."organizationId"=${org} AND o.id=${orderId} AND o."branchId"=${branch}`
  );
  const evidence = await tx.$queryRaw<CateringEvidence[]>(
    Prisma.sql`SELECT id,"quoteRevisionId",kind,amount::text,currency,source,"originalEvidenceId","drawerMovementId" FROM restaurant_catering_money_evidence WHERE "organizationId"=${org} AND "branchId"=${branch} AND "cateringOrderId"=${orderId}`
  );
  const currency = quotes[0]?.currency ?? evidence[0]?.currency ?? null;
  return {
    ...summarizeCateringMoney(
      quotes[0]?.quotedTotal ?? null,
      order.depositAmount?.toString() ?? null,
      evidence,
      currency ?? ''
    ),
    currency,
    evidence,
    moneyBasis: 'UNEARNED_EVIDENCE' as const,
  };
}

/** Canonical movement quantities, serialized with disposition commands on the order lock. */
export async function consumptionHistory(
  tx: ScopedDb,
  org: string,
  orderId: string,
  branch: string
) {
  await lockOrder(tx, orderId);
  const key = await tx.restaurantInventoryIdempotencyKey.findFirst({
    where: { organizationId: org, key: `catering:${orderId}:consumption` },
  });
  const historical = await tx.restaurantInventoryIdempotencyKey.findFirst({
    where: { organizationId: org, key: `catering:${orderId}:reversal` },
  });
  const ids = key?.resultRef?.split(',').filter(Boolean) ?? [];
  const movements = await tx.restaurantStockMovement.findMany({
    where: {
      organizationId: org,
      id: { in: ids },
      reason: 'RECIPE_CONSUMPTION',
      quantity: { lt: 0 },
      location: { branchId: branch },
    },
    select: {
      id: true,
      stockItemId: true,
      locationId: true,
      quantity: true,
      stockItem: {
        select: { canonicalUnit: { select: { id: true, name: true, abbreviation: true } } },
      },
    },
    orderBy: { id: 'asc' },
  });
  if (movements.length !== new Set(ids).size)
    fail('Original consumption is unavailable in this branch.');
  const dispositions = await tx.$queryRaw<
    Array<{
      id: string;
      originalMovementId: string;
      kind: 'UNUSED_RETURN' | 'WASTE' | 'NO_RETURN';
      quantity: string;
      resultMovementId: string | null;
      reason: string;
      actorStaffProfileId: string;
      createdAt: Date;
    }>
  >(Prisma.sql`SELECT id,"originalMovementId",kind,quantity::text,"resultMovementId",reason,"actorStaffProfileId","createdAt"
    FROM restaurant_catering_dispositions WHERE "organizationId"=${org} AND "orderId"=${orderId} ORDER BY "createdAt",id`);
  return {
    reconciliationRequired: Boolean(historical),
    movements: movements.map((m) => {
      const history = dispositions.filter((d) => d.originalMovementId === m.id);
      const allocated = history.reduce((sum, d) => sum.plus(d.quantity), new Prisma.Decimal(0));
      const consumed = m.quantity.negated();
      if (allocated.greaterThan(consumed))
        fail('Disposition history exceeds original consumption.');
      return {
        originalMovementId: m.id,
        stockItemId: m.stockItemId,
        locationId: m.locationId,
        canonicalUnit: m.stockItem.canonicalUnit,
        consumed: consumed.toString(),
        allocated: allocated.toString(),
        remaining: historical ? null : consumed.minus(allocated).toString(),
        dispositions: history,
      };
    }),
  };
}
