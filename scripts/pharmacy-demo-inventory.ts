/** Source-only demo lane. No entrypoint, connection, grants, sends or stock writes.
 * Root must validate live facts and reconcile its durable receipt/tombstone BEFORE
 * calling this helper, in one serialized caller-owned transaction. A draft is
 * never delivered inventory and cannot satisfy finance's stock prerequisite.
 */
import { createHash } from 'node:crypto';
import { isPharmacyDemoNamespace } from './pharmacy-demo-contract';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import { assertSupplierEligible, costPurchaseOrderLine } from '../src/lib/pharmacy/purchasing';
import { planAllocation, type AllocationCandidate } from '../src/lib/pharmacy/inventory';

export type InventoryDemoFacts = {
  organizationId: string;
  branchId: string;
  ownerUserId: string;
  actorId: string;
  namespace: string;
  businessDate: string;
  scenarioAt: string;
  timezone: string;
  currency: 'PKR';
  /** Observed by root, never manufactured by this helper. */
  purchasingEntitled: boolean;
  organizationPurchaser: boolean;
  approvedCatalog: {
    medicineId: string;
    presentationId: string;
    packLevelId: string;
    stockLocationId: string;
    canonicalUnitsPerPack: number;
  };
  supplier: {
    id: string;
    authorized: boolean;
    licences: readonly { id: string; verified: boolean; expiresAt: string }[];
  };
  orderedPacks: number;
  listPricePerPackMinor: number;
};

export const INVENTORY_DEMO_GAPS = [
  'REQUISITION: UNSEEDED/OWNER-INPUT — existing signal and authorized draft workflow required',
  'RECEIVING/EXCEPTIONS: UNSEEDED/OWNER-INPUT — approved receipt, invoice and warranty evidence required',
  'BATCH-STOCK/EXPIRY: UNSEEDED/OWNER-INPUT — no stock creation without genuine receiving workflow',
  'REGULATORY/RX/CONTROLLED/FISCAL: UNSEEDED/OWNER-INPUT',
] as const;

export function planInventoryDemo(facts: InventoryDemoFacts) {
  const unmet: string[] = [];
  const catalog = facts.approvedCatalog;
  const refs = [
    facts.organizationId,
    facts.branchId,
    facts.ownerUserId,
    facts.actorId,
    catalog.medicineId,
    catalog.presentationId,
    catalog.packLevelId,
    catalog.stockLocationId,
    facts.supplier.id,
  ];
  if (refs.some((ref) => !ref.trim())) unmet.push('EXISTING_TARGET_REFERENCES_REQUIRED');
  if (!isPharmacyDemoNamespace(facts.namespace)) unmet.push('INVALID_NAMESPACE');
  if (facts.currency !== 'PKR') unmet.push('PKR_REQUIRED');
  if (!facts.purchasingEntitled || !facts.organizationPurchaser)
    unmet.push('PURCHASING_CAPABILITY_REQUIRED');
  const at = new Date(facts.scenarioAt);
  if (!Number.isFinite(at.getTime())) unmet.push('INVALID_SCENARIO_AT');
  try {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: facts.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
    if (date !== facts.businessDate) unmet.push('BUSINESS_DATE_MISMATCH');
  } catch {
    unmet.push('INVALID_TIME_CONTEXT');
  }
  if (facts.supplier.licences.some((licence) => !licence.id.trim()))
    unmet.push('LICENCE_REFERENCE_REQUIRED');
  try {
    assertSupplierEligible({
      authorized: facts.supplier.authorized,
      at,
      licences: facts.supplier.licences.map((licence) => ({
        verified: licence.verified,
        expiresAt: new Date(licence.expiresAt),
      })),
    });
  } catch {
    unmet.push('APPROVED_SUPPLIER_LICENCE_REQUIRED');
  }
  let canonicalUnits = 0;
  let grossMinor = 0;
  try {
    const cost = costPurchaseOrderLine({
      orderedPacks: facts.orderedPacks,
      bonusPacks: 0,
      canonicalUnitsPerPack: catalog.canonicalUnitsPerPack,
      listPricePerPackMinor: facts.listPricePerPackMinor,
    });
    canonicalUnits = cost.canonicalUnits;
    grossMinor = cost.grossMinor;
  } catch {
    unmet.push('INVALID_PACK_OR_PRICE_ARITHMETIC');
  }
  // Construct fields explicitly so property insertion order cannot change replay identity.
  const dependencies = {
    organizationId: facts.organizationId,
    branchId: facts.branchId,
    ownerUserId: facts.ownerUserId,
    actorId: facts.actorId,
    namespace: facts.namespace,
    businessDate: facts.businessDate,
    scenarioAt: facts.scenarioAt,
    timezone: facts.timezone,
    currency: facts.currency,
    medicineId: catalog.medicineId,
    presentationId: catalog.presentationId,
    packLevelId: catalog.packLevelId,
    stockLocationId: catalog.stockLocationId,
    supplierId: facts.supplier.id,
    licences: facts.supplier.licences
      .map((l) => ({ id: l.id, verified: l.verified, expiresAt: l.expiresAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const input = {
    reference: `${facts.namespace}:inventory:po:v1`,
    supplierId: facts.supplier.id,
    receivingBranchId: facts.branchId,
    lines: [
      {
        medicineId: catalog.medicineId,
        packLevelId: catalog.packLevelId,
        orderedPacks: facts.orderedPacks,
        canonicalUnitsPerPack: catalog.canonicalUnitsPerPack,
        listPricePerPackMinor: facts.listPricePerPackMinor,
      },
    ],
  };
  const expected = {
    status: 'DRAFT' as const,
    canonicalUnits,
    grossMinor,
    deliveredStock: [] as never[],
  };
  const hash = createHash('sha256')
    .update(JSON.stringify({ version: 1, dependencies, input, expected }))
    .digest('hex');
  return { hash, dependencies, input, expected, unmet, gaps: INVENTORY_DEMO_GAPS };
}

export type InventoryDemoReconciliation =
  | { state: 'new'; hash: string }
  | { state: 'preserve'; hash: string; purchaseOrderId: string }
  | { state: 'refuse'; reason: string };

/** Root owns locking, live identity/reference validation and durable receipts.
 * Service uses this genuine caller transaction; never a synthetic service port.
 * A collision fails closed, including an orphan left without a retained receipt.
 */
export async function executeInventoryDemo(
  tx: ScopedDb,
  facts: InventoryDemoFacts,
  reconciled: InventoryDemoReconciliation
) {
  const plan = planInventoryDemo(facts);
  if (plan.unmet.length) return { status: 'refused' as const, reasons: plan.unmet };
  if (reconciled.state === 'refuse')
    return { status: 'refused' as const, reasons: [reconciled.reason] };
  if (reconciled.hash !== plan.hash)
    return { status: 'refused' as const, reasons: ['REPLAY_HASH_MISMATCH'] };
  if (reconciled.state === 'preserve') {
    if (!reconciled.purchaseOrderId.trim())
      return { status: 'refused' as const, reasons: ['MISSING_RECEIPT_REFERENCE'] };
    return {
      status: 'preserved' as const,
      purchaseOrderId: reconciled.purchaseOrderId,
      hash: plan.hash,
      deliveredStock: [] as never[],
      gaps: plan.gaps,
    };
  }
  const existing = await tx.pharmacyPurchaseOrder.findFirst({
    where: { organizationId: facts.organizationId, reference: plan.input.reference },
    select: { id: true },
  });
  if (existing)
    return { status: 'refused' as const, reasons: ['UNRECONCILED_REFERENCE_COLLISION'] };
  const { createCentralPurchaseOrder } = await import('../src/lib/pharmacy/central-purchasing');
  const order = await createCentralPurchaseOrder(
    tx,
    { organizationId: facts.organizationId, actorId: facts.actorId },
    plan.input
  );
  return {
    status: 'created-draft' as const,
    purchaseOrderId: order.id,
    hash: plan.hash,
    deliveredStock: [] as never[],
    gaps: plan.gaps,
  };
}

/** Read-only preview of observed lots. Does not reserve, mutate or claim stock. */
export function previewInventoryDemoFefo(input: {
  organizationId: string;
  branchId: string;
  scenarioAt: string;
  requiredUnits: number;
  candidates: readonly AllocationCandidate[];
}) {
  const at = new Date(input.scenarioAt);
  if (
    !Number.isFinite(at.getTime()) ||
    input.candidates.length > 32 ||
    input.candidates.some(
      (lot) =>
        !Number.isFinite(lot.expiresAt.getTime()) ||
        (lot.receivedAt !== null && !Number.isFinite(lot.receivedAt.getTime()))
    )
  ) {
    throw new Error('INVALID_OR_UNBOUNDED_LOT_FACTS');
  }
  return planAllocation({
    candidates: input.candidates,
    requiredUnits: input.requiredUnits,
    scope: { organizationId: input.organizationId, branchId: input.branchId, at },
  });
}
