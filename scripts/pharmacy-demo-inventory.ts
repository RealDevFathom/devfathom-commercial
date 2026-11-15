/** Source-only demo lane. No entrypoint, connection, grants or external effects.
 * Root must validate live facts and reconcile its durable receipt/tombstone BEFORE
 * calling this helper, in one serialized caller-owned transaction. A draft is
 * never delivered inventory and cannot satisfy finance's stock prerequisite.
 */
import { createHash } from 'node:crypto';
import {
  isPharmacyDemoNamespace,
  type PharmacyDemoContext,
  type PharmacyDemoPlan,
  type PharmacyDemoResult,
  type DemoGap,
  type DemoObservedRecord,
} from './pharmacy-demo-contract';
import type { Prisma } from '../src/generated/prisma/client';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import {
  assertSupplierEligible,
  ENFORCED_SUPPLIER_COMPLIANCE,
  costPurchaseOrderLine,
  assertApprovalAllowed,
  SEGREGATION_OF_DUTIES_POLICY,
} from '../src/lib/pharmacy/purchasing';
import { planAllocation, type AllocationCandidate } from '../src/lib/pharmacy/inventory';
import { receiptLineQuantities, receiptLineUnitCostMinor } from '../src/lib/pharmacy/receiving';
import { expiryInstant } from '../src/lib/pharmacy/stock-ledger';
import { ACTIVE_STATUSES } from '../src/lib/auth/session-state';

export type InventoryDemoFacts = PharmacyDemoContext & {
  actorId: string;
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

export const INVENTORY_DEMO_GAPS: DemoGap[] = [
  {
    function: 'REQUISITION',
    status: 'OWNER-INPUT',
    reason: 'Existing signal and authorized draft workflow required.',
  },
  {
    function: 'RECEIVING/EXCEPTIONS',
    status: 'OWNER-INPUT',
    reason: 'Use the separate prepared-receipt step with operator evidence.',
  },
  { function: 'BATCH-STOCK/EXPIRY', status: 'UNSEEDED', reason: 'Draft PO creates no stock.' },
  {
    function: 'REGULATORY/RX/CONTROLLED/FISCAL',
    status: 'OWNER-INPUT',
    reason: 'Never manufactured by demo tooling.',
  },
];

function contextUnmet(facts: InventoryDemoFacts, action: string) {
  const actor = facts.actors.find((a) => a.actorId === facts.actorId && a.userId === facts.actorId);
  const unmet: string[] = [];
  if (
    !actor ||
    !actor.active ||
    !actor.synthetic ||
    actor.organizationId !== facts.organizationId ||
    actor.branchId !== facts.branchId ||
    !actor.capabilities.includes(action)
  )
    unmet.push('OBSERVED_SERVICE_ACTOR_REQUIRED');
  if (!facts.modules.some((m) => m.key === 'pharmacy-procurement' && m.enabled))
    unmet.push('OBSERVED_PROCUREMENT_ENTITLEMENT_REQUIRED');
  const refs = [
    ['medicine', facts.approvedCatalog.medicineId],
    ['presentation', facts.approvedCatalog.presentationId],
    ['pack', facts.approvedCatalog.packLevelId],
    ['location', facts.approvedCatalog.stockLocationId],
    ['supplier', facts.supplier.id],
  ];
  if (
    refs.some(
      ([kind, id]) =>
        !facts.references.some(
          (r) =>
            r.kind === kind &&
            r.id === id &&
            r.organizationId === facts.organizationId &&
            r.branchId === facts.branchId &&
            r.approved &&
            /^[a-f0-9]{64}$/.test(r.observedHash)
        )
    )
  )
    unmet.push('OBSERVED_APPROVED_REFERENCES_REQUIRED');
  return unmet;
}

export function planInventoryDemo(facts: InventoryDemoFacts) {
  const unmet = contextUnmet(facts, 'pharmacyPurchasing.createCentralPurchaseOrder');
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
    // A demo seed always needs a genuinely licensed supplier, whatever the tenant's
    // owner policy (DEV-753). This is a preflight; the central order write that follows
    // re-checks the same supplier with supersession read across the register (DEV-466).
    assertSupplierEligible({
      authorized: facts.supplier.authorized,
      at,
      licences: facts.supplier.licences.map((licence) => ({
        verified: licence.verified,
        expiresAt: new Date(licence.expiresAt),
        superseded: false,
      })),
      policy: ENFORCED_SUPPLIER_COMPLIANCE,
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
    referenceObservations: facts.references
      .map((r) => ({
        kind: r.kind,
        id: r.id,
        organizationId: r.organizationId,
        branchId: r.branchId,
        approved: r.approved,
        observedHash: r.observedHash,
      }))
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
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
  const shared: PharmacyDemoPlan = {
    lane: 'inventory',
    namespace: facts.namespace,
    digest: hash,
    records: [
      {
        key: input.reference,
        model: 'PharmacyPurchaseOrder',
        reference: input.reference,
        expectedHash: hash,
        expectedFacts: { status: expected.status, canonicalUnits, grossMinor },
      },
    ],
    gaps: INVENTORY_DEMO_GAPS,
  };
  return { ...shared, hash, dependencies, input, expected, unmet };
}

export type InventoryDemoReconciliation =
  | { state: 'new'; hash: string }
  | { state: 'preserve'; hash: string; records: DemoObservedRecord[] }
  | { state: 'refuse'; reason: string };

/** Root owns locking, live identity/reference validation and durable receipts.
 * Service uses this genuine caller transaction; never a synthetic service port.
 * A collision fails closed, including an orphan left without a retained receipt.
 */
export async function executeInventoryDemo(
  tx: ScopedDb,
  facts: InventoryDemoFacts,
  reconciled: InventoryDemoReconciliation
): Promise<PharmacyDemoResult> {
  const plan = planInventoryDemo(facts);
  if (plan.unmet.length) return { status: 'refused', unmetPrerequisites: plan.unmet };
  if (reconciled.state === 'refuse')
    return { status: 'refused', unmetPrerequisites: [reconciled.reason] };
  if (reconciled.hash !== plan.hash)
    return { status: 'refused', unmetPrerequisites: ['REPLAY_HASH_MISMATCH'] };
  if (reconciled.state === 'preserve') {
    return preservedResult(plan, reconciled.records);
  }
  const actor = await tx.user.findFirst({
    where: { id: facts.actorId, organizationId: facts.organizationId },
    select: { id: true, status: true },
  });
  if (!actor || !ACTIVE_STATUSES.has(actor.status))
    return { status: 'refused', unmetPrerequisites: ['ACTIVE_SERVICE_ACTOR_REQUIRED'] };
  const existing = await tx.pharmacyPurchaseOrder.findFirst({
    where: { organizationId: facts.organizationId, reference: plan.input.reference },
    select: { id: true },
  });
  if (existing)
    return { status: 'refused', unmetPrerequisites: ['UNRECONCILED_REFERENCE_COLLISION'] };
  const { createCentralPurchaseOrder } = await import('../src/lib/pharmacy/central-purchasing');
  const order = await createCentralPurchaseOrder(
    tx,
    { organizationId: facts.organizationId, actorId: facts.actorId },
    plan.input
  );
  if (!order.id || order.reference !== plan.input.reference || order.status !== 'DRAFT')
    throw new Error('PURCHASE_ORDER_SERVICE_OUTPUT_MISMATCH_ROLLBACK_REQUIRED');
  return {
    status: 'applied',
    records: [
      {
        planKey: plan.records[0]!.key,
        model: 'PharmacyPurchaseOrder',
        persistedId: order.id,
        receiptReference: order.reference,
        observedHash: fingerprint({ id: order.id, status: order.status }),
        observedFacts: { status: order.status },
      },
    ],
    gaps: plan.gaps,
  };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function preservedResult(
  plan: PharmacyDemoPlan,
  records: DemoObservedRecord[]
): PharmacyDemoResult {
  if (
    records.length !== plan.records.length ||
    records.some(
      (record, i) =>
        record.planKey !== plan.records[i]!.key ||
        record.model !== plan.records[i]!.model ||
        record.receiptReference !== plan.records[i]!.reference ||
        !record.persistedId.trim() ||
        !/^[a-f0-9]{64}$/.test(record.observedHash)
    )
  )
    return { status: 'refused', unmetPrerequisites: ['MISSING_OR_MISMATCHED_RETAINED_RECORDS'] };
  // These are retained observations, not fresh assertions about operator-modified rows.
  return { status: 'replayed', records, gaps: plan.gaps };
}

const receiptInclude = {
  supplier: { include: { licences: { orderBy: { id: 'asc' } } } },
  purchaseOrder: { include: { requisition: true, approvals: { orderBy: { createdAt: 'desc' } } } },
  lines: { orderBy: { lineNumber: 'asc' }, include: { purchaseOrderLine: true } },
} satisfies Prisma.PharmacyGoodsReceiptInclude;
export type InventoryPreparedReceipt = Prisma.PharmacyGoodsReceiptGetPayload<{
  include: typeof receiptInclude;
}>;

/** Root observes through its genuine transaction and separately obtains operator confirmation
 * of this exact snapshot. No row here is evidence of synthetic ownership by itself.
 */
export function observeInventoryDemoReceipt(
  tx: ScopedDb,
  context: PharmacyDemoContext,
  id: string
) {
  return tx.pharmacyGoodsReceipt.findFirst({
    where: { id, organizationId: context.organizationId, branchId: context.branchId },
    include: receiptInclude,
  });
}

export function inventoryDemoReceiptHash(receipt: InventoryPreparedReceipt): string {
  return fingerprint(receipt);
}

export type InventoryPreparedReceiptInput = {
  goodsReceiptId: string;
  reference: string;
  /** Hash from observeInventoryDemoReceipt, confirmed separately by the operator via root. */
  snapshotHash: string;
  operatorConfirmationReference: string;
  acceptedUnits: number;
  rejectedUnits: number;
  unitCostMinor: number;
};

export function planPreparedInventoryReceipt(
  facts: InventoryDemoFacts,
  input: InventoryPreparedReceiptInput
) {
  const base = planInventoryDemo(facts);
  const unmet = [...base.unmet, ...contextUnmet(facts, 'pharmacyPurchasing.postGoodsReceipt')];
  if (
    !input.goodsReceiptId.trim() ||
    !input.operatorConfirmationReference.trim() ||
    !input.reference.startsWith(facts.namespace) ||
    input.reference.length > 100 ||
    !/^[a-f0-9]{64}$/.test(input.snapshotHash)
  )
    unmet.push('CONFIRMED_SYNTHETIC_RECEIPT_REQUIRED');
  const inventoryValueMinor = (input.acceptedUnits + input.rejectedUnits) * input.unitCostMinor;
  if (
    ![input.acceptedUnits, input.rejectedUnits, input.unitCostMinor, inventoryValueMinor].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) ||
    input.acceptedUnits + input.rejectedUnits <= 0
  )
    unmet.push('INVALID_RECEIPT_EXPECTATIONS');
  const digest = fingerprint({ base: base.digest, input });
  const plan: PharmacyDemoPlan = {
    lane: 'inventory',
    namespace: facts.namespace,
    digest,
    records: [
      {
        key: `${facts.namespace}:inventory:receipt:v1`,
        model: 'PharmacyGoodsReceipt',
        reference: input.reference,
        expectedHash: digest,
        expectedFacts: {
          status: 'POSTED',
          acceptedUnits: input.acceptedUnits,
          rejectedUnits: input.rejectedUnits,
          unitCostMinor: input.unitCostMinor,
          inventoryValueMinor,
        },
      },
    ],
    gaps: [
      {
        function: 'RECEIPT-DRAFT/APPROVAL',
        status: 'OWNER-INPUT',
        reason:
          'Existing router-created synthetic draft and genuine PO approval required; neither created here.',
      },
      {
        function: 'FINANCIAL-JOURNAL',
        status: 'UNSEEDED',
        reason:
          'Finance may consume observed receipt/lot IDs through postGoodsReceiptEntry in the root transaction; this step posts only the stock ledger.',
      },
      {
        function: 'EXCEPTION-RESOLUTION/REGULATORY/RX/CONTROLLED/FISCAL',
        status: 'OWNER-INPUT',
        reason: 'Exceptions remain OPEN; no human approval or regulated fact fabricated.',
      },
    ],
  };
  return { ...plan, unmet: [...new Set(unmet)] };
}

/** Supported composition: operator-created single-line draft -> postGoodsReceipt ->
 * receiveLot/stock ledger. The router's createGoodsReceipt is NOT an exported
 * transaction-safe draft service, so we never duplicate its writes here.
 *
 * Root MUST validate operator confirmation/synthetic ownership and real entitlements,
 * lock/reconcile receipt+tombstone first, and retain the observed result atomically
 * in the SAME transaction. A caller must roll back on any thrown error, never commit
 * a partially successful step. Stock posting is not idempotent; replay returns only
 * the root's retained observations, without invoking the service again.
 */
export async function executePreparedInventoryReceipt(
  tx: ScopedDb,
  facts: InventoryDemoFacts,
  input: InventoryPreparedReceiptInput,
  reconciled: InventoryDemoReconciliation
): Promise<PharmacyDemoResult> {
  const plan = planPreparedInventoryReceipt(facts, input);
  const refuse = (reason: string): PharmacyDemoResult => ({
    status: 'refused',
    unmetPrerequisites: [reason],
  });
  if (plan.unmet.length) return { status: 'refused', unmetPrerequisites: plan.unmet };
  if (reconciled.state === 'refuse') return refuse(reconciled.reason);
  if (reconciled.hash !== plan.digest) return refuse('REPLAY_HASH_MISMATCH');
  if (reconciled.state === 'preserve') return preservedResult(plan, reconciled.records);

  // The normal purchasing router requires an active actor and observed module.
  // This bounded demo additionally requires a real organization purchasing grant.
  const actor = await tx.user.findFirst({
    where: { id: facts.actorId, organizationId: facts.organizationId },
    select: { id: true, status: true },
  });
  if (!actor || !ACTIVE_STATUSES.has(actor.status)) return refuse('ACTIVE_SERVICE_ACTOR_REQUIRED');
  const { purchasingAccess } = await import('../src/lib/pharmacy/central-purchasing');
  if (
    !(await purchasingAccess(tx, { organizationId: facts.organizationId, actorId: actor.id }))
      .organizationWide
  )
    return refuse('ORGANIZATION_PURCHASER_REQUIRED');

  const receipt = await observeInventoryDemoReceipt(tx, facts, input.goodsReceiptId);
  if (
    !receipt ||
    receipt.reference !== input.reference ||
    receipt.status !== 'DRAFT' ||
    receipt.directPurchase ||
    receipt.lines.length !== 1 ||
    receipt.supplierId !== facts.supplier.id ||
    receipt.organizationId !== facts.organizationId ||
    receipt.branchId !== facts.branchId ||
    inventoryDemoReceiptHash(receipt) !== input.snapshotHash
  )
    return refuse('PREPARED_RECEIPT_CHANGED_OR_MISSING');
  const order = receipt.purchaseOrder;
  const approval = order?.approvals[0];
  if (
    !order ||
    !order.reference.startsWith(facts.namespace) ||
    order.organizationId !== facts.organizationId ||
    order.branchId !== facts.branchId ||
    order.supplierId !== receipt.supplierId ||
    !['APPROVED', 'SENT', 'RECEIVING'].includes(order.status) ||
    !order.approvedAt ||
    !order.approvedByUserId ||
    !approval ||
    approval.decision !== 'APPROVED' ||
    approval.actorUserId !== order.approvedByUserId ||
    approval.policy !== SEGREGATION_OF_DUTIES_POLICY ||
    approval.toStatus !== 'APPROVED'
  )
    return refuse('EXISTING_PURCHASE_APPROVAL_REQUIRED');
  assertApprovalAllowed({
    approverId: approval.actorUserId,
    createdById: order.createdByUserId,
    requestedById: order.requisition?.requestedByUserId ?? null,
  });

  const line = receipt.lines[0]!;
  const at = new Date(facts.scenarioAt);
  if (
    !line.batchNumber.startsWith(facts.namespace) ||
    line.inventoryLotId ||
    line.medicineId !== facts.approvedCatalog.medicineId ||
    line.packLevelId !== facts.approvedCatalog.packLevelId ||
    line.stockLocationId !== facts.approvedCatalog.stockLocationId ||
    line.canonicalUnitsPerPack !== facts.approvedCatalog.canonicalUnitsPerPack ||
    line.purchaseOrderLine?.purchaseOrderId !== order.id ||
    line.purchaseOrderLine.medicineId !== line.medicineId ||
    line.purchaseOrderLine.packLevelId !== line.packLevelId ||
    !Number.isFinite(receipt.receivedAt.getTime()) ||
    receipt.receivedAt > at ||
    !Number.isFinite(line.printedExpiry.getTime()) ||
    expiryInstant(line.printedExpiry, line.expiryPrecision) <= at
  )
    return refuse('UNSAFE_RECEIPT_LINE_OR_EXPIRY');
  if (
    line.rejectedCanonicalUnits > 0 &&
    (!line.quarantineLocationId ||
      !line.rejectionReason ||
      !facts.references.some(
        (r) =>
          r.kind === 'location' &&
          r.id === line.quarantineLocationId &&
          r.approved &&
          r.organizationId === facts.organizationId &&
          r.branchId === facts.branchId &&
          /^[a-f0-9]{64}$/.test(r.observedHash)
      ))
  )
    return refuse('OBSERVED_QUARANTINE_LOCATION_REQUIRED');
  const quantities = receiptLineQuantities(line);
  // PUR-03: the stamped cost includes the order line's rebate and its share of
  // the order's freight and other charges, so re-derive it from the same terms.
  const { orderReceiptCostTerms } = await import('../src/lib/pharmacy/goods-receipt');
  const orderCostTerms = (
    await orderReceiptCostTerms(tx, facts.organizationId, order, receipt.id)
  ).termsFor(line.purchaseOrderLineId, quantities.receivedCanonicalUnits);
  const unitCostMinor = receiptLineUnitCostMinor({ ...line, ...orderCostTerms });
  if (
    quantities.receivedCanonicalUnits !== line.receivedCanonicalUnits ||
    quantities.bonusCanonicalUnits !== line.bonusCanonicalUnits ||
    quantities.acceptedCanonicalUnits !== line.acceptedCanonicalUnits ||
    line.acceptedCanonicalUnits !== input.acceptedUnits ||
    line.rejectedCanonicalUnits !== input.rejectedUnits ||
    unitCostMinor !== line.unitCostMinor ||
    unitCostMinor !== input.unitCostMinor
  )
    return refuse('RECEIPT_QUANTITY_OR_COST_MISMATCH');
  // Never join even a namespaced pre-existing batch without a retained root receipt.
  if (
    await tx.pharmacyManufacturingBatch.findFirst({
      where: {
        organizationId: facts.organizationId,
        medicineId: line.medicineId,
        batchNumber: line.batchNumber,
      },
      select: { id: true },
    })
  )
    return refuse('UNRECONCILED_BATCH_COLLISION');
  const { postGoodsReceipt } = await import('../src/lib/pharmacy/goods-receipt');
  const posted = await postGoodsReceipt(
    tx,
    { organizationId: facts.organizationId, branchId: facts.branchId, actorId: actor.id },
    { goodsReceiptId: receipt.id, at }
  );
  const observed = posted.lines[0];
  if (
    posted.goodsReceiptId !== receipt.id ||
    posted.lines.length !== 1 ||
    !observed ||
    observed.goodsReceiptLineId !== line.id ||
    !observed.inventoryLotId ||
    (input.acceptedUnits > 0 && !observed.acceptedMovementId) ||
    (input.rejectedUnits > 0 && !observed.quarantineMovementId)
  )
    throw new Error('RECEIPT_SERVICE_OUTPUT_MISMATCH_ROLLBACK_REQUIRED');
  const observedFacts = {
    status: 'POSTED',
    goodsReceiptLineId: line.id,
    inventoryLotId: observed.inventoryLotId,
    acceptedMovementId: observed.acceptedMovementId,
    quarantineMovementId: observed.quarantineMovementId,
    acceptedUnits: line.acceptedCanonicalUnits,
    rejectedUnits: line.rejectedCanonicalUnits,
    unitCostMinor: line.unitCostMinor,
    inventoryValueMinor:
      (line.acceptedCanonicalUnits + line.rejectedCanonicalUnits) * line.unitCostMinor,
    medicineId: line.medicineId,
    packLevelId: line.packLevelId,
    stockLocationId: line.stockLocationId,
    quarantineLocationId: line.quarantineLocationId,
    expiresAt: expiryInstant(line.printedExpiry, line.expiryPrecision).toISOString(),
    exceptionIds: JSON.stringify(posted.exceptions.map((e) => e.id)),
    postedAt: posted.postedAt.toISOString(),
  };
  return {
    status: 'applied',
    records: [
      {
        planKey: plan.records[0]!.key,
        model: 'PharmacyGoodsReceipt',
        persistedId: posted.goodsReceiptId,
        receiptReference: receipt.reference,
        observedHash: fingerprint(observedFacts),
        observedFacts,
      },
    ],
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
