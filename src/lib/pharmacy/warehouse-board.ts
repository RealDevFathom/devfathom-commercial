import { Prisma, type PharmacyTransferStatus } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { shelfLabelCode } from './shelf-label-code';
import type { LedgerScope } from './stock-ledger';

const HOUR = 3_600_000;
const WINDOW_DAYS = 30;
const OVERDUE_HOURS = 48;
const LIVE_TRANSIT = ['DISPATCHED', 'PARTIALLY_RECEIVED', 'EXCEPTION'] as const;

type DemandRow = {
  orderId: string | null;
  demandId: string;
  toBranchId: string;
  toBranchName: string;
  medicineName: string;
  requestedUnits: number;
  committedUnits: number;
  fulfilledUnits: number;
  requestedAt: Date;
  status: string;
};

export type WarehouseShortage = {
  orderId: string;
  demandId: string;
  toBranchId: string;
  toBranchName: string;
  medicineName: string;
  requestedUnits: number;
  shortfallUnits: number;
};

type TransferLineRow = {
  transferId: string;
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  status: PharmacyTransferStatus;
  dispatchedAt: Date | null;
  lineId: string;
  medicineId: string;
  medicineName: string;
  batchNumber: string | null;
  lotId: string;
  shelfLabelNumber: number;
  destinationBinCode: string;
  destinationStockLocationId: string;
  quantityUnits: number;
  receivedUnits: number;
  coldChain: boolean;
  controlled: boolean;
  adoptable: boolean;
};

function transferLine(row: TransferLineRow) {
  return {
    id: row.lineId,
    medicineId: row.medicineId,
    medicineName: row.medicineName,
    batchNumber: row.batchNumber,
    lotId: row.lotId,
    lotLabel: shelfLabelCode(row.shelfLabelNumber),
    destinationBinCode: row.destinationBinCode,
    destinationStockLocationId: row.destinationStockLocationId,
    quantityUnits: row.quantityUnits,
    receivedUnits: row.receivedUnits,
    coldChain: row.coldChain,
    controlled: row.controlled,
  };
}

type QueuedTransfer = Pick<
  TransferLineRow,
  'fromBranchId' | 'fromBranchName' | 'toBranchId' | 'toBranchName' | 'status' | 'dispatchedAt'
> & {
  id: string;
  lines: ReturnType<typeof transferLine>[];
};

function transferQueues(rows: TransferLineRow[], branchId: string, asOf: Date) {
  const grouped = new Map<string, QueuedTransfer>();
  const incoming: QueuedTransfer[] = [];
  const overdue: QueuedTransfer[] = [];
  const adoptable: QueuedTransfer[] = [];
  let openExceptions = 0;
  for (const row of rows) {
    let transfer = grouped.get(row.transferId);
    if (!transfer) {
      transfer = {
        id: row.transferId,
        fromBranchId: row.fromBranchId,
        fromBranchName: row.fromBranchName,
        toBranchId: row.toBranchId,
        toBranchName: row.toBranchName,
        status: row.status,
        dispatchedAt: row.dispatchedAt,
        lines: [],
      };
      grouped.set(row.transferId, transfer);
      if (row.adoptable) adoptable.push(transfer);
      else {
        if (row.toBranchId === branchId) incoming.push(transfer);
        if (row.dispatchedAt && asOf.getTime() - row.dispatchedAt.getTime() >= OVERDUE_HOURS * HOUR)
          overdue.push(transfer);
        if (row.status === 'EXCEPTION') openExceptions++;
      }
    }
    transfer.lines.push(transferLine(row));
  }
  return { incoming, overdue, adoptable, openExceptions };
}

// One row per transfer line. The warehouse marker survives later disabling the source site.
// Legacy pending transfers are actionable only at their own enabled source warehouse.
function readTransferLines(db: ScopedDb, scope: LedgerScope) {
  return db.$queryRaw<TransferLineRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT t.*, source.name AS "fromBranchName", dest.name AS "toBranchName",
        source."warehouseEnabled" AND t."fromBranchId" = ${scope.branchId}
        AND t.status IN ('DRAFT','ALLOCATED','APPROVED')
        AND NOT EXISTS (SELECT 1 FROM pharmacy_warehouse_orders o
          WHERE o."organizationId" = t."organizationId" AND o."transferId" = t.id)
        AND NOT EXISTS (SELECT 1 FROM pharmacy_warehouse_reservations r
          WHERE r."organizationId" = t."organizationId" AND r."transferId" = t.id) AS adoptable,
        dest."warehouseEnabled" OR EXISTS (SELECT 1 FROM pharmacy_warehouse_reservations r
          WHERE r."organizationId" = t."organizationId" AND r."transferId" = t.id) AS managed
      FROM pharmacy_interbranch_transfers t
      JOIN pharmacy_branches source ON source."organizationId" = t."organizationId" AND source.id = t."fromBranchId"
      JOIN pharmacy_branches dest ON dest."organizationId" = t."organizationId" AND dest.id = t."toBranchId"
      WHERE t."organizationId" = ${scope.organizationId}
        AND (t."fromBranchId" = ${scope.branchId} OR t."toBranchId" = ${scope.branchId})
        AND t.status <> 'RECEIVED'
    )
    SELECT t.id AS "transferId", t."fromBranchId", t."fromBranchName", t."toBranchId", t."toBranchName",
      t.status, t."dispatchedAt", t.adoptable, line.id AS "lineId", lot.id AS "lotId", lot."shelfLabelNumber",
      m.id AS "medicineId", COALESCE(m."brandName", m."productName") AS "medicineName", m."coldChain", m.controlled,
      b."batchNumber", loc.code AS "destinationBinCode", line."destinationStockLocationId", line."quantityUnits", line."receivedUnits"
    FROM scoped t
    JOIN pharmacy_interbranch_transfer_lines line ON line."organizationId" = t."organizationId" AND line."transferId" = t.id
    JOIN pharmacy_inventory_lots lot ON lot."organizationId" = t."organizationId" AND lot.id = line."sourceLotId"
    JOIN pharmacy_manufacturing_batches b ON b."organizationId" = lot."organizationId" AND b.id = lot."manufacturingBatchId"
    JOIN pharmacy_medicines m ON m."organizationId" = b."organizationId" AND m.id = b."medicineId"
    JOIN pharmacy_stock_locations loc ON loc."organizationId" = t."organizationId" AND loc."branchId" = t."toBranchId" AND loc.id = line."destinationStockLocationId"
    WHERE (t.adoptable OR (t.managed AND t.status::text IN (${Prisma.join(LIVE_TRANSIT)})))
      AND NOT EXISTS (SELECT 1 FROM pharmacy_warehouse_reservations r
        WHERE r."organizationId" = t."organizationId" AND r."transferLineId" = line.id AND r.state = 'CANCELLED')
    ORDER BY t."dispatchedAt" ASC NULLS LAST, t."createdAt", t.id, line.id`);
}

function readDemand(db: ScopedDb, scope: LedgerScope, windowStart: Date, asOf: Date) {
  return db.$queryRaw<DemandRow[]>(Prisma.sql`
    WITH orders AS (
      SELECT o.*, COALESCE((SELECT MIN(q."createdAt") FROM pharmacy_warehouse_requests q
        WHERE q."organizationId" = o."organizationId" AND q."orderId" = o.id), o."createdAt") AS "requestedAt"
      FROM pharmacy_warehouse_orders o
      WHERE o."organizationId" = ${scope.organizationId}
        AND (o."branchId" = ${scope.branchId} OR o."toBranchId" = ${scope.branchId})
        AND (o.status <> 'CANCELLED' OR EXISTS (
          SELECT 1 FROM pharmacy_warehouse_reservations dispatched
          WHERE dispatched."organizationId" = o."organizationId" AND dispatched."orderId" = o.id
            AND dispatched.state = 'DISPATCHED'))
    )
    SELECT o.id AS "orderId", d.id AS "demandId", o."toBranchId", dest.name AS "toBranchName",
      COALESCE(m."brandName", m."productName") AS "medicineName", d."requestedUnits", o."requestedAt", o.status,
      COALESCE(SUM(r."quantityUnits"), 0)::float8 AS "committedUnits", COALESCE(SUM(l."receivedUnits"), 0)::float8 AS "fulfilledUnits"
    FROM orders o
    JOIN pharmacy_warehouse_demands d ON d."organizationId" = o."organizationId" AND d."orderId" = o.id
    JOIN pharmacy_branches dest ON dest."organizationId" = o."organizationId" AND dest.id = o."toBranchId"
    JOIN pharmacy_medicines m ON m."organizationId" = d."organizationId" AND m.id = d."medicineId"
    LEFT JOIN pharmacy_warehouse_reservations r ON r."organizationId" = d."organizationId" AND r."demandId" = d.id
      AND r.state IN ('RESERVED','PICKED','PACKED','DISPATCHED')
    LEFT JOIN pharmacy_interbranch_transfer_lines l ON l."organizationId" = r."organizationId" AND l.id = r."transferLineId"
    WHERE o.status = 'OPEN' OR o."requestedAt" BETWEEN ${windowStart} AND ${asOf}
    GROUP BY o.id, o."toBranchId", dest.name, d.id, m."brandName", m."productName", d."requestedUnits", o."requestedAt", o.status
    UNION ALL
    SELECT NULL, q.id, q."branchId", dest.name, COALESCE(m."brandName", m."productName"), q."requestedUnits",
      q."createdAt", q.status::text, 0::float8, 0::float8
    FROM pharmacy_warehouse_requests q
    JOIN pharmacy_branches dest ON dest."organizationId" = q."organizationId" AND dest.id = q."branchId"
    JOIN pharmacy_medicines m ON m."organizationId" = q."organizationId" AND m.id = q."medicineId"
    WHERE q."organizationId" = ${scope.organizationId} AND q.status = 'REQUESTED' AND q."orderId" IS NULL
      AND (q."warehouseBranchId" = ${scope.branchId} OR q."branchId" = ${scope.branchId})
      AND q."createdAt" BETWEEN ${windowStart} AND ${asOf}
    ORDER BY "requestedAt", "demandId"`);
}

function demandSummary(rows: DemandRow[], windowStart: Date, asOf: Date) {
  const shortages: WarehouseShortage[] = [];
  let requestedUnits = 0;
  let fulfilledUnits = 0;
  for (const row of rows) {
    if (row.requestedAt >= windowStart && row.requestedAt <= asOf) {
      requestedUnits += row.requestedUnits;
      fulfilledUnits += row.fulfilledUnits;
    }
    const shortfallUnits = row.requestedUnits - row.committedUnits;
    if (row.status === 'OPEN' && row.orderId && shortfallUnits > 0) {
      shortages.push({
        demandId: row.demandId,
        orderId: row.orderId,
        medicineName: row.medicineName,
        toBranchId: row.toBranchId,
        toBranchName: row.toBranchName,
        requestedUnits: row.requestedUnits,
        shortfallUnits,
      });
    }
  }
  return {
    shortages,
    fillRate: { requestedUnits, fulfilledUnits, percent: percent(fulfilledUnits, requestedUnits) },
  };
}

function percent(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

type MetricRow = {
  completedShipments: number;
  averageHours: number | null;
  countedLines: number;
  matchingLines: number;
  expiryWriteOffUnits: number;
};

function readMetrics(db: ScopedDb, scope: LedgerScope, windowStart: Date, asOf: Date) {
  return db.$queryRaw<MetricRow[]>(Prisma.sql`
    WITH completed AS (
      SELECT DISTINCT t.id, t."receivedAt",
        COALESCE((SELECT MIN(q."createdAt") FROM pharmacy_warehouse_requests q
          WHERE q."organizationId" = o."organizationId" AND q."orderId" = o.id), o."createdAt") AS "requestedAt"
      FROM pharmacy_interbranch_transfers t
      JOIN pharmacy_warehouse_reservations r ON r."organizationId" = t."organizationId" AND r."transferId" = t.id AND r.state = 'DISPATCHED'
      JOIN pharmacy_warehouse_orders o ON o."organizationId" = r."organizationId" AND o.id = r."orderId"
      WHERE t."organizationId" = ${scope.organizationId} AND (t."fromBranchId" = ${scope.branchId} OR t."toBranchId" = ${scope.branchId})
        AND t.status = 'RECEIVED' AND t."receivedAt" BETWEEN ${windowStart} AND ${asOf}
    ), accuracy AS (
      SELECT COUNT(*)::float8 AS "countedLines", COUNT(*) FILTER (WHERE l."varianceUnits" = 0)::float8 AS "matchingLines"
      FROM pharmacy_inventory_count_lines l JOIN pharmacy_inventory_counts c
        ON c."organizationId" = l."organizationId" AND c."branchId" = l."branchId" AND c.id = l."countId"
      WHERE l."organizationId" = ${scope.organizationId} AND l."branchId" = ${scope.branchId} AND c.status = 'APPROVED'
        AND l."varianceUnits" IS NOT NULL AND c."approvedAt" BETWEEN ${windowStart} AND ${asOf}
    ), expiry AS (
      SELECT COALESCE(SUM(-m."quantityUnits"), 0)::float8 AS "expiryWriteOffUnits"
      FROM pharmacy_stock_movements m
      JOIN pharmacy_inventory_lots l ON l."organizationId" = m."organizationId" AND l.id = m."inventoryLotId"
      JOIN pharmacy_manufacturing_batches b ON b."organizationId" = l."organizationId" AND b.id = l."manufacturingBatchId"
      WHERE m."organizationId" = ${scope.organizationId} AND m."branchId" = ${scope.branchId}
        AND m.kind = 'WRITE_OFF' AND m.disposition <> 'IN_TRANSIT' AND m."quantityUnits" < 0
        AND m."occurredAt" BETWEEN ${windowStart} AND ${asOf} AND b."expiresAt" <= m."occurredAt"
        AND NOT EXISTS (SELECT 1 FROM pharmacy_stock_movements rev
          WHERE rev."organizationId" = m."organizationId" AND rev."reversesMovementId" = m.id AND rev."occurredAt" <= ${asOf})
    )
    SELECT (SELECT COUNT(*)::float8 FROM completed) AS "completedShipments",
      (SELECT AVG(EXTRACT(EPOCH FROM ("receivedAt" - "requestedAt")) / 3600)::float8 FROM completed) AS "averageHours",
      accuracy.*, expiry.* FROM accuracy CROSS JOIN expiry`);
}

type RecallRow = {
  id: string;
  reference: string;
  reason: string;
  createdAt: Date;
  acknowledged: boolean;
};

function readRecalls(db: ScopedDb, scope: LedgerScope) {
  return db.$queryRaw<RecallRow[]>(Prisma.sql`
    SELECT n.id, n.reference, n.reason, n."createdAt", EXISTS (
      SELECT 1 FROM pharmacy_recall_acknowledgements a WHERE a."organizationId" = n."organizationId"
        AND a."recallNoticeId" = n.id AND a."branchId" = ${scope.branchId}) AS acknowledged
    FROM pharmacy_recall_notices n
    WHERE n."organizationId" = ${scope.organizationId} AND n.status = 'OPEN'
      AND EXISTS (SELECT 1 FROM pharmacy_manufacturing_batches b JOIN pharmacy_inventory_lots l
        ON l."organizationId" = b."organizationId" AND l."manufacturingBatchId" = b.id
        WHERE b."organizationId" = n."organizationId" AND (n."batchId" IS NULL OR n."batchId" = b.id)
          AND (n."medicineId" IS NULL OR n."medicineId" = b."medicineId")
          AND (l."branchId" = ${scope.branchId} OR EXISTS (
            SELECT 1 FROM pharmacy_interbranch_transfer_lines tl JOIN pharmacy_interbranch_transfers t
              ON t."organizationId" = tl."organizationId" AND t.id = tl."transferId"
            WHERE tl."organizationId" = l."organizationId" AND tl."sourceLotId" = l.id AND t."toBranchId" = ${scope.branchId}
              AND t.status::text IN (${Prisma.join(LIVE_TRANSIT)}))))
    ORDER BY n."createdAt", n.id`);
}

type QualityHoldRow = {
  inventoryLotId: string;
  stockLocationId: string;
  binCode: string;
  medicineName: string;
  batchNumber: string | null;
  disposition: string;
  units: number;
  reason: string;
};

function readQualityHolds(db: ScopedDb, scope: LedgerScope) {
  // A balance may have several incident reports. Read its units once and combine the
  // outstanding reasons. A pre-dispatch incident still matters while its stock is staged.
  return db.$queryRaw<QualityHoldRow[]>(Prisma.sql`
    WITH incidents AS (
      SELECT "inventoryLotId", "stockLocationId", STRING_AGG(DISTINCT reason, ' · ' ORDER BY reason) AS reason
      FROM pharmacy_warehouse_quality_incidents
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} AND status = 'OPEN'
      GROUP BY "inventoryLotId", "stockLocationId"
    )
    SELECT bal."inventoryLotId", bal."stockLocationId", loc.code AS "binCode", batch."batchNumber",
      COALESCE(m."brandName", m."productName") AS "medicineName", bal.disposition,
      bal."onHandUnits" AS units, COALESCE(i.reason, CASE WHEN batch.state <> 'ACTIVE'
        THEN COALESCE(batch."stateReason", batch.state::text) ELSE bal.disposition::text END) AS reason
    FROM pharmacy_stock_balances bal
    JOIN pharmacy_stock_locations loc ON loc."organizationId" = bal."organizationId" AND loc.id = bal."stockLocationId"
    JOIN pharmacy_inventory_lots lot ON lot."organizationId" = bal."organizationId" AND lot.id = bal."inventoryLotId"
    JOIN pharmacy_manufacturing_batches batch ON batch."organizationId" = lot."organizationId" AND batch.id = lot."manufacturingBatchId"
    JOIN pharmacy_medicines m ON m."organizationId" = batch."organizationId" AND m.id = batch."medicineId"
    LEFT JOIN incidents i ON i."inventoryLotId" = bal."inventoryLotId" AND i."stockLocationId" = bal."stockLocationId"
    WHERE bal."organizationId" = ${scope.organizationId} AND bal."branchId" = ${scope.branchId} AND bal."onHandUnits" > 0
      AND (bal.disposition IN ('DAMAGED','QUARANTINE') OR
        (bal.disposition IN ('AVAILABLE','WAREHOUSE_RECEIVING','WAREHOUSE_RESERVED') AND (batch.state <> 'ACTIVE' OR i.reason IS NOT NULL)))
    ORDER BY loc.code, bal."inventoryLotId", bal.disposition`);
}

/** The caller admits the user's branch. Every query constrains both tenant and branch. */
export async function warehouseBoard(db: ScopedDb, scope: LedgerScope, asOf = new Date()) {
  const windowStart = new Date(asOf.getTime() - WINDOW_DAYS * 24 * HOUR);
  const [transferRows, demandRows, [metric], qualityHolds, recalls] = await Promise.all([
    readTransferLines(db, scope),
    readDemand(db, scope, windowStart, asOf),
    readMetrics(db, scope, windowStart, asOf),
    readQualityHolds(db, scope),
    readRecalls(db, scope),
  ]);
  const { incoming, overdue, adoptable, openExceptions } = transferQueues(
    transferRows,
    scope.branchId,
    asOf
  );
  const { shortages, fillRate } = demandSummary(demandRows, windowStart, asOf);
  return {
    asOf,
    windowStart,
    overdueAfterHours: OVERDUE_HOURS,
    incoming,
    overdue,
    adoptable,
    shortages,
    qualityHolds,
    recalls,
    metrics: {
      fillRate,
      receiptTime: {
        completedShipments: metric.completedShipments,
        averageHours: metric.averageHours,
      },
      binAccuracy: {
        countedLines: metric.countedLines,
        matchingLines: metric.matchingLines,
        percent: percent(metric.matchingLines, metric.countedLines),
      },
      expiryWriteOffUnits: metric.expiryWriteOffUnits,
      openExceptions,
    },
  };
}
