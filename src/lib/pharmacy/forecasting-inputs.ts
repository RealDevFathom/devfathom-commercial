import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { safeDemandTotal, type DemandScope } from './demand-evidence';
import type {
  DecisionInbound,
  DecisionOrderTerms,
  ReplenishmentDecisionInput,
} from './forecasting';
import { blockReasonFor, type BlockReason } from './inventory';
import { loadStockCandidatesForRead } from './stock-ledger';

export type ForecastingInbound = DecisionInbound & {
  evidence:
    | {
        kind: 'PURCHASE_ORDER';
        purchaseOrderId: string;
        purchaseOrderLineId: string;
        orderedUnits: number;
        postedAcceptedUnits: number;
      }
    | {
        kind: 'TRANSFER';
        transferId: string;
        transferLineId: string;
        sourceBranchId: string;
        sourceLotId: string;
        sourceStockLocationId: string;
        destinationStockLocationId: string;
        dispatchedAt: string | null;
        quantityUnits: number;
        receivedUnits: number;
      };
};

export type ForecastingInputs = Pick<ReplenishmentDecisionInput, 'inventorySource' | 'stock'> & {
  scope: DemandScope;
  inbound: readonly ForecastingInbound[];
  excludedStock: readonly {
    lot: ReplenishmentDecisionInput['stock'][number];
    reason: BlockReason | 'UNKNOWN_EXPIRY';
  }[];
  /** Neither a supplier quote nor gross capacity establishes these constraints. */
  constraints: Pick<DecisionOrderTerms, 'budgetMinor' | 'storageLimitUnits'>;
  limitations: readonly string[];
};

/**
 * Current read-only supply evidence for one authorized branch and medicine.
 * The caller supplies its tenant-scoped client and authorizes branch/report access.
 * Use a consistent caller-owned snapshot when reconciling concurrent receipts:
 * this helper neither opens a transaction nor locks or mutates business records.
 * This is not a historical stock reconstruction or a reservation guarantee.
 *
 * Inbound lot/location identifiers prefixed with `forecast-` identify document
 * evidence only, never actual receivable lots. Transfer source identity remains
 * explicit in evidence; receiving creates a new destination lot for each receipt.
 * Order terms, demand, currency and policy selection belong to the caller.
 *
 * An empty candidate query filters out zero/fully reserved balances; it cannot
 * distinguish those from missing inventory evidence. Require a matching ledger
 * balance before returning observed zero. Otherwise throw RangeError rather than
 * label an unobserved scope OBSERVED_TRANSACTIONS. This proves recorded ledger
 * evidence only, not completeness of physical stock or historical coverage.
 */
export async function loadForecastingInputs(
  db: ScopedDb,
  scope: DemandScope
): Promise<ForecastingInputs> {
  if (![scope.organizationId, scope.branchId, scope.medicineId].every((id) => id.trim())) {
    throw new RangeError('Forecasting supply scope is required');
  }
  const candidates = await loadStockCandidatesForRead(db, scope, scope.medicineId);
  if (candidates.length === 0) {
    const balance = await db.pharmacyStockBalance.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        lot: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          batch: { organizationId: scope.organizationId, medicineId: scope.medicineId },
        },
      },
      select: {
        organizationId: true,
        branchId: true,
        onHandUnits: true,
        lot: {
          select: {
            organizationId: true,
            branchId: true,
            batch: { select: { organizationId: true, medicineId: true } },
          },
        },
      },
    });
    if (!balance) {
      throw new RangeError('Stock evidence is unavailable for forecasting supply scope');
    }
    if (
      balance.organizationId !== scope.organizationId ||
      balance.branchId !== scope.branchId ||
      balance.lot.organizationId !== scope.organizationId ||
      balance.lot.branchId !== scope.branchId ||
      balance.lot.batch.organizationId !== scope.organizationId ||
      balance.lot.batch.medicineId !== scope.medicineId
    ) {
      throw new RangeError('Stock balance scope does not match forecasting supply scope');
    }
    safeDemandTotal([balance.onHandUnits]);
  }
  const purchaseLines = await db.pharmacyPurchaseOrderLine.findMany({
    where: {
      organizationId: scope.organizationId,
      medicineId: scope.medicineId,
      purchaseOrder: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: { in: ['APPROVED', 'SENT', 'RECEIVING'] },
      },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      organizationId: true,
      medicineId: true,
      orderedCanonicalUnits: true,
      bonusCanonicalUnits: true,
      purchaseOrder: {
        select: {
          id: true,
          organizationId: true,
          branchId: true,
          expectedDeliveryAt: true,
        },
      },
      goodsReceiptLines: {
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          medicineId: scope.medicineId,
          goodsReceipt: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            status: 'POSTED',
          },
        },
        select: { acceptedCanonicalUnits: true },
      },
    },
  });
  const transferLines = await db.pharmacyInterbranchTransferLine.findMany({
    where: {
      organizationId: scope.organizationId,
      transfer: {
        organizationId: scope.organizationId,
        toBranchId: scope.branchId,
        status: { in: ['APPROVED', 'DISPATCHED', 'PARTIALLY_RECEIVED'] },
      },
      sourceLot: {
        organizationId: scope.organizationId,
        batch: { organizationId: scope.organizationId, medicineId: scope.medicineId },
      },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      organizationId: true,
      sourceBranchId: true,
      sourceLotId: true,
      sourceStockLocationId: true,
      destinationStockLocationId: true,
      quantityUnits: true,
      receivedUnits: true,
      transfer: {
        select: {
          id: true,
          organizationId: true,
          fromBranchId: true,
          toBranchId: true,
          dispatchedAt: true,
        },
      },
      sourceLot: {
        select: {
          id: true,
          organizationId: true,
          branchId: true,
          batch: {
            select: { organizationId: true, medicineId: true, state: true, expiresAt: true },
          },
        },
      },
    },
  });

  // These current versions were observed now; approval/creation dates are not
  // evidence that their present quantities/ETAs were known at a historical origin.
  const at = new Date();
  const asOf = at.toISOString();
  const stock: ReplenishmentDecisionInput['stock'][number][] = [];
  const excludedStock: ForecastingInputs['excludedStock'][number][] = [];
  for (const candidate of candidates) {
    if (
      candidate.organizationId !== scope.organizationId ||
      candidate.branchId !== scope.branchId
    ) {
      throw new RangeError('Stock scope does not match forecasting supply scope');
    }
    const lot = { ...candidate, medicineId: scope.medicineId };
    // DEV-853: an expiry that was never recorded (legacy opening stock) is
    // sellable on-hand stock, never "expired" and never excluded. Only an
    // unreadable date is unknown; a known expiry that has passed stays excluded.
    const reason =
      lot.expiresAt !== null && !Number.isFinite(lot.expiresAt.getTime())
        ? 'UNKNOWN_EXPIRY'
        : blockReasonFor(lot, { ...scope, at });
    if (reason) excludedStock.push({ lot, reason });
    else stock.push(lot);
  }

  const inbound: ForecastingInbound[] = [];
  for (const line of purchaseLines) {
    const po = line.purchaseOrder;
    if (
      line.organizationId !== scope.organizationId ||
      line.medicineId !== scope.medicineId ||
      po.organizationId !== scope.organizationId ||
      po.branchId !== scope.branchId
    ) {
      throw new RangeError('Purchase scope does not match forecasting supply scope');
    }
    const orderedUnits = safeDemandTotal([line.orderedCanonicalUnits, line.bonusCanonicalUnits]);
    // Match purchasing's accepted-unit reconciliation. Rejected/quarantined goods
    // do not fulfil safe supply; draft, reversed and cancelled receipts do not count.
    const postedAcceptedUnits = safeDemandTotal(
      line.goodsReceiptLines.map((receipt) => receipt.acceptedCanonicalUnits)
    );
    const availableUnits = Math.max(0, orderedUnits - postedAcceptedUnits);
    if (!availableUnits) continue;
    const id = `forecast-po:${line.id}`;
    inbound.push({
      id,
      confirmed: true,
      knownAt: asOf,
      arrivalAt: po.expectedDeliveryAt?.toISOString() ?? null,
      lot: {
        ...scope,
        inventoryLotId: id,
        stockLocationId: id,
        batchState: 'ACTIVE',
        disposition: 'AVAILABLE',
        availableUnits,
        expiresAt: null,
      },
      evidence: {
        kind: 'PURCHASE_ORDER',
        purchaseOrderId: po.id,
        purchaseOrderLineId: line.id,
        orderedUnits,
        postedAcceptedUnits,
      },
    });
  }
  for (const line of transferLines) {
    const { transfer, sourceLot } = line;
    if (
      line.organizationId !== scope.organizationId ||
      transfer.organizationId !== scope.organizationId ||
      transfer.toBranchId !== scope.branchId ||
      line.sourceBranchId !== transfer.fromBranchId ||
      sourceLot.organizationId !== scope.organizationId ||
      sourceLot.branchId !== line.sourceBranchId ||
      sourceLot.id !== line.sourceLotId ||
      sourceLot.batch.organizationId !== scope.organizationId ||
      sourceLot.batch.medicineId !== scope.medicineId
    ) {
      throw new RangeError('Transfer scope does not match forecasting supply scope');
    }
    safeDemandTotal([line.quantityUnits, line.receivedUnits]);
    const availableUnits = Math.max(0, line.quantityUnits - line.receivedUnits);
    if (!availableUnits) continue;
    const id = `forecast-transfer:${line.id}`;
    inbound.push({
      id,
      confirmed: true,
      knownAt: asOf,
      // Transfer schema records dispatch/receipt, but has no promised arrival.
      arrivalAt: null,
      lot: {
        ...scope,
        inventoryLotId: id,
        stockLocationId: line.destinationStockLocationId,
        batchState: sourceLot.batch.state,
        disposition: 'AVAILABLE',
        expiresAt: sourceLot.batch.expiresAt,
        availableUnits,
      },
      evidence: {
        kind: 'TRANSFER',
        transferId: transfer.id,
        transferLineId: line.id,
        sourceBranchId: line.sourceBranchId,
        sourceLotId: line.sourceLotId,
        sourceStockLocationId: line.sourceStockLocationId,
        destinationStockLocationId: line.destinationStockLocationId,
        dispatchedAt: transfer.dispatchedAt?.toISOString() ?? null,
        quantityUnits: line.quantityUnits,
        receivedUnits: line.receivedUnits,
      },
    });
  }
  return {
    scope: { ...scope },
    inventorySource: {
      kind: 'OBSERVED_TRANSACTIONS',
      reference: `pharmacy-supply:${JSON.stringify([scope.organizationId, scope.branchId, scope.medicineId])}`,
      asOf,
    },
    stock,
    excludedStock,
    inbound,
    constraints: { budgetMinor: null, storageLimitUnits: null },
    limitations: [
      'Current ledger/document reads; not a historical stock reconstruction or a reservation guarantee. Concurrent reconciliation requires a consistent caller-owned snapshot.',
      'Outstanding purchase units include bonuses and subtract only POSTED accepted receipt units. Purchase expiry and receiving location remain unknown.',
      'Transfer dispatch is not an ETA. Source batch expiry/state are evidence, not destination receipt approval.',
      'Budget and net incremental storage are unknown. Quote lead time is not an actual arrival date.',
    ],
  };
}
