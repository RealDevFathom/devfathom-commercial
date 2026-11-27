/**
 * DEV-1052: who owns a manual quarantine hold, and who may release it.
 *
 * Placing a hold by hand needs the safety permission, but releasing one used to need only
 * the inventory permission, and nothing recorded who had placed it. Every manually held unit
 * now belongs to one authority, in the append-only `pharmacy_quarantine_hold_entries`:
 *
 *   SAFETY     a person with the safety permission held it (`quarantinePart`), or nobody
 *              recorded who did. Only the safety permission releases it.
 *   INVENTORY  a stock workflow held it: expiry quarantine, a customer return, a failed
 *              delivery, goods refused at receiving. The inventory permission releases it.
 *
 * Units a DRAP recall holds are neither: `PharmacyRecallQuarantineAction` reserves them for
 * the recall reversal, exactly as before.
 *
 * FAIL CLOSED. A held unit is an inventory hold only while an entry proves it. Units in
 * quarantine that no entry accounts for are safety holds, and units that left quarantine
 * without a release (a write-off, a reversed receipt) are taken from the inventory holds
 * first, so a removal can never turn a safety hold into an inventory one.
 *
 * Every function here that writes expects the caller to hold the position's QUARANTINE
 * balance lock (`lockStockBalances`) or to have just written that balance in this transaction.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError } from './inventory';

export type QuarantineHoldAuthority = 'SAFETY' | 'INVENTORY';

/** The stock workflows that hold units for inventory, and the manual safety hold. */
export type QuarantineHoldOrigin =
  'MANUAL' | 'EXPIRY' | 'CUSTOMER_RETURN' | 'DELIVERY_RETURN' | 'GOODS_IN';

/** Which holds the person releasing may release, read from their live permissions. */
export type QuarantineReleaseRights = { safety: boolean; inventory: boolean };

export type QuarantineHoldSplit = { safetyUnits: number; inventoryUnits: number };

type HoldScope = { organizationId: string; branchId: string; actorId: string };
type HoldPosition = { inventoryLotId: string; stockLocationId: string };

export const QUARANTINE_SAFETY_RELEASE_REFUSED =
  'This stock is held by pharmacy safety. Only someone with the safety permission can release it.';
export const QUARANTINE_NO_RELEASE_PERMISSION = 'You do not have permission to release held stock.';

/**
 * Split the manually held units of one position between the two authorities. Inventory owns
 * only what its entries prove and what the safety entries leave room for; everything else is
 * a safety hold.
 */
export function splitQuarantineHold(input: {
  manualUnits: number;
  safetyRecorded: number;
  inventoryRecorded: number;
}): QuarantineHoldSplit {
  const manual = Math.max(0, input.manualUnits);
  const inventoryUnits = Math.max(
    0,
    Math.min(input.inventoryRecorded, manual - Math.max(0, input.safetyRecorded))
  );
  return { safetyUnits: manual - inventoryUnits, inventoryUnits };
}

/**
 * Decide which holds a release of `units` draws on, or refuse it. Each unit is checked
 * against its own hold: inventory holds first, then safety holds, and only the kinds the
 * person may release. An inventory-only person can never take more than the inventory units.
 */
export function planQuarantineRelease(
  hold: QuarantineHoldSplit,
  units: number,
  rights: QuarantineReleaseRights
): QuarantineHoldSplit {
  const fromInventory = rights.inventory ? Math.min(units, hold.inventoryUnits) : 0;
  const fromSafety = rights.safety ? Math.min(units - fromInventory, hold.safetyUnits) : 0;
  if (fromInventory + fromSafety === units) {
    return { safetyUnits: fromSafety, inventoryUnits: fromInventory };
  }
  if (!rights.safety && !rights.inventory) {
    throw new PharmacyInventoryError(
      'QUARANTINE_RELEASE_REFUSED',
      QUARANTINE_NO_RELEASE_PERMISSION
    );
  }
  if (!rights.safety) {
    throw new PharmacyInventoryError(
      'QUARANTINE_RELEASE_REFUSED',
      hold.inventoryUnits > 0
        ? `Only ${hold.inventoryUnits} of these units can be released with the inventory permission. The rest is held by pharmacy safety, and only someone with the safety permission can release it.`
        : QUARANTINE_SAFETY_RELEASE_REFUSED
    );
  }
  throw new PharmacyInventoryError(
    'QUARANTINE_RELEASE_REFUSED',
    `Only ${hold.safetyUnits} of these units are a safety hold. The rest was held by a stock workflow, and someone with the inventory permission releases it.`
  );
}

async function manualUnitsAt(db: ScopedDb, scope: HoldScope, position: HoldPosition) {
  const where = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: position.inventoryLotId,
    stockLocationId: position.stockLocationId,
  };
  const [balance, recall] = await Promise.all([
    db.pharmacyStockBalance.findFirst({
      where: { ...where, disposition: 'QUARANTINE' },
      select: { onHandUnits: true },
    }),
    db.pharmacyRecallQuarantineAction.aggregate({
      where: { ...where, reversedAt: null },
      _sum: { quantityUnits: true },
    }),
  ]);
  return Math.max(0, (balance?.onHandUnits ?? 0) - (recall._sum.quantityUnits ?? 0));
}

async function recordedUnitsAt(db: ScopedDb, scope: HoldScope, position: HoldPosition) {
  const rows = await db.pharmacyQuarantineHoldEntry.groupBy({
    by: ['authority'],
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: position.inventoryLotId,
      stockLocationId: position.stockLocationId,
    },
    _sum: { quantityUnits: true },
  });
  const of = (authority: QuarantineHoldAuthority) =>
    rows.find((row) => row.authority === authority)?._sum.quantityUnits ?? 0;
  return { safety: of('SAFETY'), inventory: of('INVENTORY') };
}

/**
 * Make the entries of one position agree with its manually held units, and return the split.
 * Unowned units become a safety hold; units that are gone are taken from inventory holds
 * first. `removal` names the movement and person that took units out, when the caller knows.
 */
export async function reconcileQuarantineHolds(
  db: ScopedDb,
  scope: HoldScope,
  position: HoldPosition,
  removal?: { movementId: string; reason: string }
): Promise<QuarantineHoldSplit> {
  const [manual, recorded] = await Promise.all([
    manualUnitsAt(db, scope, position),
    recordedUnitsAt(db, scope, position),
  ]);
  let safety = Math.max(0, recorded.safety);
  let inventory = Math.max(0, recorded.inventory);
  const common = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: position.inventoryLotId,
    stockLocationId: position.stockLocationId,
  };
  const drift = manual - (safety + inventory);
  if (drift > 0) {
    await db.pharmacyQuarantineHoldEntry.create({
      data: {
        ...common,
        authority: 'SAFETY',
        origin: 'UNATTRIBUTED',
        quantityUnits: drift,
        reason: 'Held with no recorded owner',
      },
    });
    safety += drift;
  } else if (drift < 0) {
    const fromInventory = Math.min(inventory, -drift);
    const fromSafety = -drift - fromInventory;
    for (const [authority, units] of [
      ['INVENTORY', fromInventory],
      ['SAFETY', fromSafety],
    ] as const) {
      if (!units) continue;
      await db.pharmacyQuarantineHoldEntry.create({
        data: {
          ...common,
          authority,
          origin: 'REMOVED',
          quantityUnits: -units,
          movementId: removal?.movementId ?? null,
          actorId: removal ? scope.actorId : null,
          reason: removal?.reason ?? 'Left quarantine without a release',
        },
      });
    }
    inventory -= fromInventory;
    safety -= fromSafety;
  }
  return { safetyUnits: safety, inventoryUnits: inventory };
}

/** Record who placed a hold and under which authority, for the movement that held the units. */
export async function recordQuarantineHold(
  db: ScopedDb,
  scope: HoldScope,
  input: HoldPosition & {
    units: number;
    authority: QuarantineHoldAuthority;
    origin: QuarantineHoldOrigin;
    movementId: string;
    reason?: string | null;
  }
) {
  await db.pharmacyQuarantineHoldEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      authority: input.authority,
      origin: input.origin,
      quantityUnits: input.units,
      movementId: input.movementId,
      actorId: scope.actorId,
      reason: input.reason ?? null,
    },
  });
  await reconcileQuarantineHolds(db, scope, input);
}

/** Record the release of each authority's units against the movement that released them. */
export async function recordQuarantineRelease(
  db: ScopedDb,
  scope: HoldScope,
  input: HoldPosition & { plan: QuarantineHoldSplit; movementId: string; reason: string }
) {
  for (const [authority, units] of [
    ['INVENTORY', input.plan.inventoryUnits],
    ['SAFETY', input.plan.safetyUnits],
  ] as const) {
    if (!units) continue;
    await db.pharmacyQuarantineHoldEntry.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: input.inventoryLotId,
        stockLocationId: input.stockLocationId,
        authority,
        origin: 'RELEASE',
        quantityUnits: -units,
        movementId: input.movementId,
        actorId: scope.actorId,
        reason: input.reason,
      },
    });
  }
}

export type QuarantineHoldView = QuarantineHoldSplit & {
  /** Units a DRAP recall reserves; released only by the recall reversal. */
  recallUnits: number;
  /** The most recent hold placed under each authority that still has units held. */
  placed: Array<{
    authority: QuarantineHoldAuthority;
    origin: string;
    actorName: string | null;
    at: Date;
  }>;
};

/** Read-only: every quarantined position of a branch with its owners, keyed `lot:location`. */
export async function listQuarantineHolds(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string }
): Promise<Map<string, QuarantineHoldView>> {
  const where = { organizationId: scope.organizationId, branchId: scope.branchId };
  const balances = await db.pharmacyStockBalance.findMany({
    where: { ...where, disposition: 'QUARANTINE', onHandUnits: { gt: 0 } },
    select: { inventoryLotId: true, stockLocationId: true, onHandUnits: true },
  });
  if (!balances.length) return new Map();
  const lotIds = [...new Set(balances.map((row) => row.inventoryLotId))];
  const [recalls, sums, placements] = await Promise.all([
    db.pharmacyRecallQuarantineAction.groupBy({
      by: ['inventoryLotId', 'stockLocationId'],
      where: { ...where, inventoryLotId: { in: lotIds }, reversedAt: null },
      _sum: { quantityUnits: true },
    }),
    db.pharmacyQuarantineHoldEntry.groupBy({
      by: ['inventoryLotId', 'stockLocationId', 'authority'],
      where: { ...where, inventoryLotId: { in: lotIds } },
      _sum: { quantityUnits: true },
    }),
    db.pharmacyQuarantineHoldEntry.findMany({
      where: { ...where, inventoryLotId: { in: lotIds }, quantityUnits: { gt: 0 } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        inventoryLotId: true,
        stockLocationId: true,
        authority: true,
        origin: true,
        actorId: true,
        createdAt: true,
      },
    }),
  ]);
  const actorIds = [...new Set(placements.flatMap((row) => (row.actorId ? [row.actorId] : [])))];
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { organizationId: scope.organizationId, id: { in: actorIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(actors.map((user) => [user.id, user.name]));
  const key = (row: HoldPosition) => `${row.inventoryLotId}:${row.stockLocationId}`;
  const view = new Map<string, QuarantineHoldView>();
  for (const balance of balances) {
    const at = key(balance);
    const recallUnits = recalls.find((row) => key(row) === at)?._sum.quantityUnits ?? 0;
    const recorded = (authority: QuarantineHoldAuthority) =>
      sums.find((row) => key(row) === at && row.authority === authority)?._sum.quantityUnits ?? 0;
    const split = splitQuarantineHold({
      manualUnits: balance.onHandUnits - recallUnits,
      safetyRecorded: recorded('SAFETY'),
      inventoryRecorded: recorded('INVENTORY'),
    });
    const placed: QuarantineHoldView['placed'] = [];
    for (const authority of ['SAFETY', 'INVENTORY'] as const) {
      if (!(authority === 'SAFETY' ? split.safetyUnits : split.inventoryUnits)) continue;
      const latest = placements.find((row) => key(row) === at && row.authority === authority);
      if (latest)
        placed.push({
          authority,
          origin: latest.origin,
          actorName: latest.actorId ? (nameOf.get(latest.actorId) ?? null) : null,
          at: latest.createdAt,
        });
    }
    view.set(at, { ...split, recallUnits, placed });
  }
  return view;
}
