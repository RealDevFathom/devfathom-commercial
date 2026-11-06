import 'server-only';

import { createHash } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { blockReasonFor } from './inventory';
import { loadStockCandidatesForRead } from './stock-ledger';
import { loadTemperatureZoneStatuses } from './temperature-log';
import { packConversions } from './pack-conversion';
import { assertSupplierEligible, landedCost } from './purchasing';
import {
  actOnLostDemandAdvice,
  loadLostDemandScopeAlerts,
  lostDemandTriggerConfigSchema,
  suggestedProcurementQuantity,
  type LostDemandAdvice,
  type LostDemandAction,
  type LostDemandTriggerConfig,
  type TrustedProcurementActor,
} from './lost-demand-procurement';

type Scope = { organizationId: string; branchId: string };
const DAY = 86_400_000;

export async function saveLostDemandConfig(
  db: ScopedDb,
  scope: Scope & { actorId: string },
  input: LostDemandTriggerConfig
) {
  const config = lostDemandTriggerConfigSchema.parse(input);
  const changed = await db.$executeRaw(Prisma.sql`UPDATE "pharmacy_branches"
    SET "lostDemandConfig"=${JSON.stringify(config)}::jsonb, "updatedAt"=CURRENT_TIMESTAMP
    WHERE "organizationId"=${scope.organizationId} AND "id"=${scope.branchId} AND "active"=true`);
  if (changed !== 1) throw new Error('BRANCH_NOT_AVAILABLE');
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY_LOST_DEMAND',
      action: 'lostDemand.configure',
      targetType: 'PharmacyBranch',
      targetId: scope.branchId,
      result: config,
    },
  });
  return config;
}

/** One explicit visit, optionally attributed to its primary requested SKU; UUID retries are inert. */
export async function captureLostDemandVisit(
  db: ScopedDb,
  scope: Scope & { actorId: string },
  input: { id: string; medicineId?: string; walkedOut: boolean }
) {
  if (input.walkedOut && !input.medicineId) throw new Error('WALK_OUT_ITEM_REQUIRED');
  if (
    input.medicineId &&
    !(await db.medicine.findFirst({
      where: {
        organizationId: scope.organizationId,
        id: input.medicineId,
      },
      select: { id: true },
    }))
  )
    throw new Error('MEDICINE_NOT_AVAILABLE');
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "pharmacy_demand_visits"
      ("id", "organizationId", "branchId", "requestedMedicineId", "walkedOut", "capturedByUserId")
    VALUES (${input.id}, ${scope.organizationId}, ${scope.branchId}, ${input.medicineId ?? null},
      ${input.walkedOut}, ${scope.actorId}) ON CONFLICT ("id") DO NOTHING RETURNING "id"`);
  if (!rows.length) {
    const [previous] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "pharmacy_demand_visits" WHERE "id"=${input.id}
        AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
        AND "capturedByUserId"=${scope.actorId} AND "walkedOut"=${input.walkedOut}
        AND "requestedMedicineId" IS NOT DISTINCT FROM ${input.medicineId ?? null}`);
    if (!previous) throw new Error('VISIT_IDEMPOTENCY_CONFLICT');
  }
  return { id: input.id };
}

/** Reuse ledger reservations, recall checks and temperature evidence; never reserve advice stock. */
async function availableStock(db: ScopedDb, scope: Scope, medicineId: string, at: Date) {
  const candidates = await loadStockCandidatesForRead(db, scope, medicineId);
  const locations = await db.pharmacyStockLocation.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
    },
    select: { id: true, coldChain: true },
  });
  const medicine = await db.medicine.findFirst({
    where: {
      organizationId: scope.organizationId,
      id: medicineId,
      saleable: true,
    },
    select: { coldChain: true },
  });
  if (!medicine) return [];
  const temperatures = medicine.coldChain
    ? await loadTemperatureZoneStatuses(
        db,
        scope,
        at,
        locations.map((row) => row.id)
      )
    : [];
  const batches = await db.pharmacyManufacturingBatch.findMany({
    where: {
      organizationId: scope.organizationId,
      medicineId,
    },
    select: { id: true },
  });
  const recalls = await db.pharmacyRecallNotice.findMany({
    where: {
      organizationId: scope.organizationId,
      status: 'OPEN',
      OR: [{ medicineId }, { batchId: { in: batches.map((row) => row.id) } }],
    },
    select: { medicineId: true, batchId: true },
  });
  const recalledLots = recalls.length
    ? await db.pharmacyInventoryLot.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          OR: recalls.map((row) =>
            row.medicineId
              ? { batch: { medicineId: row.medicineId } }
              : { manufacturingBatchId: row.batchId! }
          ),
        },
        select: { id: true },
      })
    : [];
  return candidates.filter(
    (row) =>
      !blockReasonFor(row, { ...scope, at }) &&
      !recalledLots.some((lot) => lot.id === row.inventoryLotId) &&
      locations.some(
        (location) =>
          location.id === row.stockLocationId &&
          (!medicine.coldChain ||
            (location.coldChain &&
              !temperatures.some(
                (status) => status.stockLocationId === location.id && status.status === 'EXCURSION'
              )))
      )
  );
}

async function inboundUnits(db: ScopedDb, scope: Scope, medicineId: string, at: Date) {
  const lines = await db.pharmacyPurchaseOrderLine.findMany({
    where: {
      organizationId: scope.organizationId,
      medicineId,
      purchaseOrder: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: { in: ['APPROVED', 'SENT', 'RECEIVING'] },
      },
    },
    select: {
      orderedCanonicalUnits: true,
      bonusCanonicalUnits: true,
      goodsReceiptLines: {
        where: {
          organizationId: scope.organizationId,
          goodsReceipt: { status: 'POSTED', branchId: scope.branchId },
        },
        select: { acceptedCanonicalUnits: true },
      },
    },
  });
  const transfers = await db.pharmacyInterbranchTransferLine.findMany({
    where: {
      organizationId: scope.organizationId,
      sourceLot: { batch: { medicineId, state: 'ACTIVE', expiresAt: { gt: at } } },
      transfer: {
        organizationId: scope.organizationId,
        toBranchId: scope.branchId,
        status: { in: ['APPROVED', 'DISPATCHED', 'PARTIALLY_RECEIVED'] },
      },
    },
    select: { quantityUnits: true, receivedUnits: true },
  });
  return (
    lines.reduce(
      (n, row) =>
        n +
        Math.max(
          0,
          row.orderedCanonicalUnits +
            row.bonusCanonicalUnits -
            row.goodsReceiptLines.reduce((sum, receipt) => sum + receipt.acceptedCanonicalUnits, 0)
        ),
      0
    ) + transfers.reduce((n, row) => n + Math.max(0, row.quantityUnits - row.receivedUnits), 0)
  );
}

const saltKey = (rows: { ingredientId: string; value: { toString(): string }; unit: string }[]) =>
  rows
    .map((row) => `${row.ingredientId}@${row.value.toString()}${row.unit.trim().toLowerCase()}`)
    .sort()
    .join('+');

/** Financial advice is returned only through the reports + financial capability boundary. */
export async function loadLostDemandAdvice(db: ScopedDb, scope: Scope, at = new Date()) {
  const summary = await loadLostDemandScopeAlerts(db, scope, { financial: true, at });
  const medicineIds = [...new Set(summary.alerts.flatMap((row) => row.medicineIds))];
  const result: LostDemandAdvice[] = [];
  for (const medicineId of medicineIds) {
    if (result.length >= 10) break;
    const medicine = await db.medicine.findFirst({
      where: {
        organizationId: scope.organizationId,
        id: medicineId,
        saleable: true,
      },
      include: { strengths: true, presentations: { include: { packLevels: true } } },
    });
    if (!medicine) continue;
    const windowFrom = new Date(at.getTime() - summary.config.requestWindowDays * DAY);
    const demand = await db.unfulfilledDemandEvent.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        requestedMedicineId: medicineId,
        createdAt: { gte: windowFrom, lt: at },
      },
      select: {
        id: true,
        quantity: true,
        saleUnit: true,
        presentation: true,
        status: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const [latestVisit] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "pharmacy_demand_visits" WHERE "organizationId"=${scope.organizationId}
        AND "branchId"=${scope.branchId} AND "createdAt">=${windowFrom} AND "createdAt"<${at}
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`);
    const alert =
      summary.alerts.find((row) => row.scope === 'SKU' && row.key === medicineId) ??
      summary.alerts.find((row) => row.medicineIds.includes(medicineId))!;
    const evidenceKey = createHash('sha256')
      .update(
        JSON.stringify([
          scope.organizationId,
          scope.branchId,
          medicineId,
          demand.map((row) => row.id),
          latestVisit?.id,
          summary.config,
          alert,
        ])
      )
      .digest('hex');
    const stocks = await availableStock(db, scope, medicineId, at);
    const onHandUnits = stocks.reduce((n, row) => n + row.availableUnits, 0);
    const onOrderUnits = await inboundUnits(db, scope, medicineId, at);
    const safety = await db.pharmacySafetyStock.findFirst({ where: { ...scope, medicineId } });
    // Conversion uses the medicine's effective pack hierarchy. Ambiguous presentations/units
    // are excluded from the velocity estimate rather than guessed to be canonical units.
    const sold = await db.pharmacySaleLine.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        medicineId,
        sale: { status: 'COMPLETED', completedAt: { gte: windowFrom, lt: at } },
      },
      _sum: { canonicalUnits: true },
    });
    const units = demand.reduce((n, row) => {
      if (row.status === 'RECOVERED') return n;
      if (row.saleUnit === 'UNIT') return n + row.quantity;
      const matches = medicine.presentations.filter(
        (p) => p.id === row.presentation || p.presentation === row.presentation
      );
      const presentation = matches.length === 1 ? matches[0] : undefined;
      const pack =
        presentation &&
        packConversions(presentation.packLevels, at).find((p) => p.level === row.saleUnit);
      return n + (pack ? row.quantity * pack.canonicalUnitsPerPack : 0);
    }, sold._sum.canonicalUnits ?? 0);
    const quotes = await db.pharmacyQuoteLine.findMany({
      where: {
        organizationId: scope.organizationId,
        requisitionLine: {
          medicineId,
          requisition: { organizationId: scope.organizationId, branchId: scope.branchId },
        },
        quote: {
          organizationId: scope.organizationId,
          quotedAt: { lte: at },
          validUntil: { gt: at },
          supplier: { active: true, authorized: true },
        },
      },
      include: {
        requisitionLine: true,
        quote: {
          include: {
            supplier: {
              include: {
                licences: {
                  include: { supersededBy: { select: { id: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: [{ quote: { quotedAt: 'desc' } }, { id: 'asc' }],
    });
    const distributors: LostDemandAdvice['distributors'] = [];
    for (const quote of quotes) {
      const supplier = quote.quote.supplier;
      if (distributors.some((row) => row.supplierId === supplier.id)) continue;
      try {
        assertSupplierEligible({
          authorized: supplier.active && supplier.authorized,
          at,
          licences: supplier.licences.map((row) => ({
            expiresAt: row.expiresAt,
            verified: !!row.verifiedAt && row.supersededBy.length === 0,
          })),
        });
      } catch {
        continue;
      }
      const presentation = medicine.presentations.find((p) =>
        p.packLevels.some((pack) => pack.id === quote.requisitionLine.packLevelId)
      );
      const pack =
        presentation &&
        packConversions(presentation.packLevels, at).find(
          (p) => p.packLevelId === quote.requisitionLine.packLevelId
        );
      if (!pack || pack.canonicalUnitsPerPack !== quote.canonicalUnitsPerPack) continue;
      const terms = {
        packUnits: pack.canonicalUnitsPerPack,
        schemeBuyPacks: quote.schemeBuyPacks,
        schemeFreePacks: quote.schemeFreePacks,
      };
      let quantity = suggestedProcurementQuantity({
        forecastUnitsOverLeadTime: Math.ceil(
          (units * Math.max(1, quote.leadTimeDays)) / summary.config.requestWindowDays
        ),
        safetyStockUnits: safety?.safetyStockUnits ?? 0,
        onHandUnits,
        onOrderUnits,
        terms,
      });
      if (quantity.orderedPacks > 0 && quantity.orderedPacks < quote.moqPacks) {
        const orderedPacks = quote.moqPacks;
        const bonusPacks = quote.schemeBuyPacks
          ? Math.floor(orderedPacks / quote.schemeBuyPacks) * quote.schemeFreePacks
          : 0;
        quantity = {
          ...quantity,
          orderedPacks,
          bonusPacks,
          suppliedUnits: (orderedPacks + bonusPacks) * terms.packUnits,
        };
      }
      const previous = await db.pharmacyPurchaseOrderLine.findFirst({
        where: {
          organizationId: scope.organizationId,
          medicineId,
          packLevelId: pack.packLevelId,
          purchaseOrder: {
            branchId: scope.branchId,
            supplierId: supplier.id,
            status: { in: ['APPROVED', 'SENT', 'RECEIVING'] },
          },
        },
        orderBy: { createdAt: 'desc' },
        select: { listPricePerPackMinor: true },
      });
      distributors.push({
        supplierId: supplier.id,
        name: supplier.name,
        lastPricePerPackMinor: previous?.listPricePerPackMinor ?? null,
        quotePricePerPackMinor: quote.pricePerPackMinor,
        scheme: quote.schemeBuyPacks
          ? { buyPacks: quote.schemeBuyPacks, freePacks: quote.schemeFreePacks }
          : null,
        leadTimeDays: quote.leadTimeDays,
        packLevelId: pack.packLevelId,
        packUnits: pack.canonicalUnitsPerPack,
        quoteId: quote.quoteId,
        discountBps: quote.discountBps,
        quantity,
      });
    }
    const fallback = suggestedProcurementQuantity({
      forecastUnitsOverLeadTime: Math.ceil(units),
      safetyStockUnits: safety?.safetyStockUnits ?? 0,
      onHandUnits,
      onOrderUnits,
      terms: { packUnits: 1 },
    });
    const quantity = distributors[0]?.quantity ?? fallback;
    const transfers: LostDemandAdvice['transfers'] = [];
    const destination = await db.pharmacyBranch.findFirst({
      where: {
        organizationId: scope.organizationId,
        id: scope.branchId,
        active: true,
      },
      select: { defaultStockLocationId: true },
    });
    const destinationLocation = destination?.defaultStockLocationId
      ? await db.pharmacyStockLocation.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            id: destination.defaultStockLocationId,
            active: true,
          },
          select: { id: true, coldChain: true },
        })
      : null;
    if (destinationLocation && (!medicine.coldChain || destinationLocation.coldChain)) {
      for (const branch of await db.pharmacyBranch.findMany({
        where: {
          organizationId: scope.organizationId,
          id: { not: scope.branchId },
          active: true,
        },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      })) {
        // Surplus requires an approved source policy. No policy means no transfer suggestion.
        const sourceSafety = await db.pharmacySafetyStock.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: branch.id,
            medicineId,
          },
        });
        if (!sourceSafety) continue;
        const available = await availableStock(
          db,
          { ...scope, branchId: branch.id },
          medicineId,
          at
        );
        const surplusUnits = Math.max(
          0,
          available.reduce((n, row) => n + row.availableUnits, 0) - sourceSafety.safetyStockUnits
        );
        if (!surplusUnits) continue;
        let remaining = Math.min(surplusUnits, quantity.requiredUnits);
        const lines = available.flatMap((lot) => {
          const quantityUnits = Math.min(remaining, lot.availableUnits);
          remaining -= quantityUnits;
          return quantityUnits
            ? [
                {
                  sourceLotId: lot.inventoryLotId,
                  sourceStockLocationId: lot.stockLocationId,
                  destinationStockLocationId: destinationLocation.id,
                  quantityUnits,
                },
              ]
            : [];
        });
        transfers.push({ fromBranchId: branch.id, name: branch.name, surplusUnits, lines });
      }
    }
    const alternates: LostDemandAdvice['alternates'] = [];
    const key = saltKey(medicine.strengths);
    if (key)
      for (const alternate of await db.medicine.findMany({
        where: {
          organizationId: scope.organizationId,
          id: { not: medicineId },
          saleable: true,
          strengths: {
            some: { ingredientId: { in: medicine.strengths.map((row) => row.ingredientId) } },
          },
        },
        include: { strengths: true, presentations: true },
      })) {
        if (
          saltKey(alternate.strengths) !== key ||
          !alternate.presentations.some((p) =>
            medicine.presentations.some(
              (original) => original.dosageForm === p.dosageForm && original.route === p.route
            )
          )
        )
          continue;
        const stock = await availableStock(db, scope, alternate.id, at);
        if (!stock.length) continue;
        const lot = await db.pharmacyInventoryLot.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            id: stock[0].inventoryLotId,
          },
          select: { unitCostMinor: true, printedMrpMinor: true, unitsPerPack: true },
        });
        const price = lot ? lot.printedMrpMinor / lot.unitsPerPack : 0;
        alternates.push({
          medicineId: alternate.id,
          name: alternate.productName,
          sameSaltAndStrength: true,
          marginBps:
            lot && price > 0 ? Math.floor(((price - lot.unitCostMinor) / price) * 10_000) : null,
        });
      }
    const candidate = {
      ...scope,
      medicineId,
      name: medicine.productName,
      fired: alert.fired,
      metrics: {
        requests: demand.length,
        estimatedLossMinor: alert.estimatedLossMinor ?? 0,
        walkOuts: alert.walkOuts ?? 0,
        visits: alert.visits ?? 0,
      },
      quantity,
      distributors,
      alternates: alternates.sort(
        (a, b) =>
          (b.marginBps ?? -Number.MAX_SAFE_INTEGER) - (a.marginBps ?? -Number.MAX_SAFE_INTEGER) ||
          a.medicineId.localeCompare(b.medicineId)
      ),
      transfers,
      method: `Estimate: (completed sale units + convertible unrecovered demand units) / ${summary.config.requestWindowDays} days × ${distributors.length ? 'quote lead time (minimum 1 day)' : 'request-window days (no quote lead time available)'},  plus approved safety stock, less available ledger stock and approved inbound. Unknown pack conversions excluded. Transfers retain the source's approved safety stock. Clinical review required for alternates.`,
    };
    // A changed quantity, quote, policy, alternate or surplus requires a fresh human review.
    const id = createHash('sha256')
      .update(JSON.stringify([evidenceKey, candidate]))
      .digest('hex');
    if (
      !(await db.auditLog.findFirst({
        where: {
          organizationId: scope.organizationId,
          category: 'PHARMACY_LOST_DEMAND',
          targetType: 'LostDemandAdvice',
          targetId: id,
          outcome: 'SUCCESS',
        },
        select: { id: true },
      }))
    )
      result.push({ id, ...candidate });
  }
  return result;
}

/** Own-actor PIN; returns a refusal so failed-attempt counters can COMMIT before the API throws. */
export async function verifyLostDemandPin(
  db: ScopedDb,
  actor: TrustedProcurementActor,
  pin: string
) {
  const ids = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT credential."id" FROM "restaurant_operator_credentials" credential
    JOIN "restaurant_staff_profiles" staff ON staff."id"=credential."staffProfileId"
      AND staff."organizationId"=credential."organizationId"
    WHERE credential."organizationId"=${actor.organizationId} AND staff."userId"=${actor.userId}
      AND staff."status"='ACTIVE' AND credential."type"='PIN'
      AND credential."revokedAt" IS NULL AND credential."deviceId" IS NULL
    ORDER BY credential."createdAt" DESC LIMIT 1 FOR UPDATE OF credential`);
  if (!ids[0]) return false;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: actor.organizationId,
      id: ids[0].id,
    },
  });
  const at = new Date();
  if (!credential || isLockedOut(credential, at)) return false;
  const valid = await verifyOperatorCredential('PIN', pin, credential.credentialHash);
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: valid ? clearLockout() : registerFailedAttempt(credential, at),
  });
  return valid;
}

export async function requireLostDemandActor(
  db: ScopedDb,
  actor: TrustedProcurementActor,
  action: LostDemandAction
) {
  const user = await db.user.findFirst({
    where: { id: actor.userId, organizationId: actor.organizationId },
  });
  if (!user || !ACTIVE_STATUSES.has(user.status)) throw new Error('PROCUREMENT_FORBIDDEN');
  for (const capability of [
    'reports:operational',
    'reports:financial',
    action === 'DRAFT_TRANSFER' ? 'pharmacy:inventory' : 'pharmacy:procurement',
  ] as const) {
    if (!(await can(user, capability, undefined, { db, source: 'TRPC' })))
      throw new Error('PROCUREMENT_FORBIDDEN');
  }
}

/** Production session/PIN/tenant/transaction implementation for the pure draft-only boundary. */
export async function executeLostDemandAction(
  actor: TrustedProcurementActor,
  input: {
    branchId: string;
    adviceId: string;
    action: LostDemandAction;
    pin: string;
    supplierId?: string;
    fromBranchId?: string;
  }
) {
  return actOnLostDemandAdvice({
    ...input,
    boundary: {
      authenticate: async ({ pin, action }) => {
        const valid = await withTenantDb(
          actor.organizationId,
          async (db) => {
            await requireLostDemandActor(db, actor, action);
            return verifyLostDemandPin(db, actor, pin);
          },
          { userId: actor.userId }
        );
        if (!valid) throw new Error('PIN_INVALID_OR_LOCKED');
        return actor;
      },
      transaction: (work) =>
        withTenantDb(
          actor.organizationId,
          async (db) => {
            await requireLostDemandActor(db, actor, input.action);
            await db.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${JSON.stringify(['lost-demand', actor.organizationId, input.branchId])}, 0))`);
            const branch = await db.pharmacyBranch.findFirst({
              where: {
                organizationId: actor.organizationId,
                id: input.branchId,
                active: true,
              },
            });
            if (!branch) throw new Error('BRANCH_NOT_AVAILABLE');
            let advice: LostDemandAdvice | undefined;
            return work({
              loadCurrentAdvice: async ({ adviceId }) => {
                advice = (
                  await loadLostDemandAdvice(db, {
                    organizationId: actor.organizationId,
                    branchId: branch.id,
                  })
                ).find((row) => row.id === adviceId);
                return advice ?? null;
              },
              createPurchaseOrderDraft: async (draft) => {
                const supplier = advice?.distributors.find(
                  (row) => row.supplierId === draft.supplierId
                );
                if (
                  !supplier?.packLevelId ||
                  !supplier.packUnits ||
                  supplier.quotePricePerPackMinor == null
                )
                  throw new Error('SUPPLIER_TERMS_UNAVAILABLE');
                const line = {
                  medicineId: draft.medicineId,
                  packLevelId: supplier.packLevelId,
                  orderedPacks: draft.orderedPacks,
                  bonusPacks: draft.bonusPacks,
                  canonicalUnitsPerPack: supplier.packUnits,
                  listPricePerPackMinor: supplier.quotePricePerPackMinor,
                  discountBps: supplier.discountBps ?? 0,
                  rebateBps: 0,
                  taxBps: 0,
                  taxCreditable: false,
                };
                landedCost({ lines: [line], freightMinor: 0, otherChargesMinor: 0 });
                const order = await db.pharmacyPurchaseOrder.create({
                  data: {
                    organizationId: actor.organizationId,
                    branchId: branch.id,
                    supplierId: supplier.supplierId,
                    quoteId: supplier.quoteId,
                    reference: `LD-${input.adviceId}`,
                    status: 'DRAFT',
                    createdByUserId: actor.userId,
                    note: `Lost-demand review ${input.adviceId}. Human approval required.`,
                    lines: {
                      create: [
                        {
                          // organizationId is derived from the composite parent relation.
                          ...line,
                          lineNumber: 1,
                          orderedCanonicalUnits: line.orderedPacks * supplier.packUnits,
                          bonusCanonicalUnits: line.bonusPacks * supplier.packUnits,
                        },
                      ],
                    },
                  },
                  select: { id: true },
                });
                return { id: order.id, status: 'DRAFT' as const };
              },
              createTransferDraft: async (draft) => {
                const source = advice?.transfers.find(
                  (row) => row.fromBranchId === draft.fromBranchId
                );
                if (
                  !source?.lines?.length ||
                  source.lines.reduce((n, row) => n + row.quantityUnits, 0) !== draft.quantityUnits
                )
                  throw new Error('TRANSFER_STOCK_CHANGED');
                const transfer = await db.pharmacyInterbranchTransfer.create({
                  data: {
                    organizationId: actor.organizationId,
                    fromBranchId: draft.fromBranchId,
                    toBranchId: branch.id,
                    status: 'DRAFT',
                    allocatedById: actor.userId,
                    lines: {
                      create: source.lines.map((line) => ({
                        // organizationId is derived from the composite parent relation.
                        sourceBranchId: draft.fromBranchId,
                        ...line,
                      })),
                    },
                  },
                  select: { id: true },
                });
                return { id: transfer.id, status: 'DRAFT' as const };
              },
              appendAudit: async (event) => {
                await db.auditLog.create({
                  data: {
                    organizationId: actor.organizationId,
                    actorId: actor.userId,
                    source: 'TRPC',
                    category: 'PHARMACY_LOST_DEMAND',
                    action: `lostDemand.${event.action}`,
                    targetType: 'LostDemandAdvice',
                    targetId: event.adviceId,
                    result: {
                      branchId: branch.id,
                      action: event.action,
                      draftId: event.draftId ?? null,
                      status: event.action === 'IGNORE' ? 'IGNORED' : 'DRAFT',
                    },
                  },
                });
              },
            });
          },
          { userId: actor.userId, isolationLevel: 'Serializable' }
        ),
    },
  });
}

/** Explicit source-branch review moves an inert proposal into the existing approval workflow.
 * Approve still refuses DRAFT and self-approval; this step never reserves or moves stock.
 * Must run inside the caller's transaction.
 */
export async function submitTransferDraft(
  db: ScopedDb,
  scope: Scope & { actorId: string },
  transferId: string
) {
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "pharmacy_interbranch_transfers"
    WHERE "organizationId"=${scope.organizationId} AND "fromBranchId"=${scope.branchId}
      AND "id"=${transferId} FOR UPDATE`);
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: {
      organizationId: scope.organizationId,
      fromBranchId: scope.branchId,
      id: transferId,
      status: 'DRAFT',
    },
    include: {
      lines: { include: { sourceLot: { select: { batch: { select: { medicineId: true } } } } } },
    },
  });
  if (!transfer?.lines.length || transfer.toBranchId === scope.branchId)
    throw new Error('INVALID_STATE');
  if (
    transfer.lines.some(
      (line) => !Number.isSafeInteger(line.quantityUnits) || line.quantityUnits <= 0
    )
  )
    throw new Error('INVALID_UNITS');
  const actor = await db.user.findFirst({
    where: { organizationId: scope.organizationId, id: scope.actorId },
  });
  if (
    !actor ||
    !ACTIVE_STATUSES.has(actor.status) ||
    !(await can(actor, 'pharmacy:inventory', undefined, { db }))
  )
    throw new Error('TRANSFER_FORBIDDEN');
  const branches = await db.pharmacyBranch.count({
    where: {
      organizationId: scope.organizationId,
      active: true,
      id: { in: [scope.branchId, transfer.toBranchId] },
    },
  });
  if (branches !== 2) throw new Error('BRANCH_NOT_AVAILABLE');
  for (const medicineId of new Set(transfer.lines.map((row) => row.sourceLot.batch.medicineId))) {
    const at = new Date();
    const available = await availableStock(db, scope, medicineId, at);
    const lines = transfer.lines.filter((row) => row.sourceLot.batch.medicineId === medicineId);
    const safety = await db.pharmacySafetyStock.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        medicineId,
      },
    });
    const requested = lines.reduce((n, row) => n + row.quantityUnits, 0);
    if (
      !safety ||
      available.reduce((n, row) => n + row.availableUnits, 0) - requested < safety.safetyStockUnits
    )
      throw new Error('TRANSFER_SURPLUS_CHANGED');
    const medicine = await db.medicine.findFirstOrThrow({
      where: { organizationId: scope.organizationId, id: medicineId },
    });
    for (const line of lines) {
      const candidate = available.find(
        (row) =>
          row.inventoryLotId === line.sourceLotId &&
          row.stockLocationId === line.sourceStockLocationId
      );
      const destination = await db.pharmacyStockLocation.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: transfer.toBranchId,
          id: line.destinationStockLocationId,
          active: true,
        },
      });
      if (
        !candidate ||
        candidate.availableUnits < line.quantityUnits ||
        !destination ||
        (medicine.coldChain && !destination.coldChain)
      )
        throw new Error('TRANSFER_STOCK_CHANGED');
    }
  }
  const updated = await db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'ALLOCATED', allocatedById: scope.actorId },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY_LOST_DEMAND',
      action: 'lostDemand.submitTransferDraft',
      targetType: 'PharmacyInterbranchTransfer',
      targetId: transfer.id,
      result: { status: 'ALLOCATED' },
    },
  });
  return updated;
}
