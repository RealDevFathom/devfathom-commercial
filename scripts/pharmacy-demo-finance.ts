import { createHash } from 'node:crypto';
import { canonicalUnits, priceFromLot } from '../src/lib/pharmacy/medicine';
import { isPharmacyDemoNamespace } from './pharmacy-demo-contract';
import type {
  DemoObservedRecord,
  DemoGap,
  PharmacyDemoContext,
  PharmacyDemoPlan,
  PharmacyDemoResult,
} from './pharmacy-demo-contract';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import type { LedgerScope } from '../src/lib/pharmacy/stock-ledger';
import type { EntitlementView } from '../src/lib/module-catalog';

/** Internal, never JSON/request input. Root authenticates the current operator,
 * resolves entitlements/branch access, reconciles receipt/tombstone history BEFORE
 * calling once, and retains this result in its SAME withTenantDb transaction.
 * records are root-observed prior synthetic provisioning, not approval flags.
 */
export interface PharmacyDemoCashRoot {
  scope: LedgerScope;
  namespace: string;
  entitlements: EntitlementView;
  records: readonly DemoObservedRecord[];
  businessDate: Date;
}

export type PharmacyDemoOriginalCashSale = Extract<
  Awaited<ReturnType<typeof executePharmacyDemoCashSale>>,
  { status: 'applied' }
>;

/** Fresh-only FULL return of the accepted one-UNIT cash fixture. Root supplies
 * its durable original result (not request JSON), authorizes the actual supplied
 * integrity decision, locks/reconciles history, and owns this entire transaction.
 * Existing return/refund idempotency is preserved. Root replay returns its retained
 * reversal result; never invoke this step again or commit after any thrown error.
 * Quarantine is NOT saleable restocking. A completed sale cannot use OPEN-only void.
 */
export async function executePharmacyDemoCashReturn(
  tx: ScopedDb,
  root: PharmacyDemoCashRoot,
  original: PharmacyDemoOriginalCashSale,
  input: { quarantineLocationId: string; reason: string; integrityDecision: string }
) {
  const { scope, namespace } = root;
  const scoped = { organizationId: scope.organizationId, branchId: scope.branchId };
  const refuse = (reason: string) => ({
    status: 'refused' as const,
    unmetPrerequisites: [`UNSEEDED: ${reason}`],
  });
  if (
    !isPharmacyDemoNamespace(namespace) ||
    root.entitlements.organizationId !== scope.organizationId ||
    root.entitlements.vertical !== 'PHARMACY' ||
    !root.entitlements.enabledModules.includes('pharmacy-counter')
  )
    return refuse('CURRENT_SCOPED_PHARMACY_AUTHORITY');
  if (
    !input.reason.trim() ||
    !input.integrityDecision.trim() ||
    !input.quarantineLocationId.trim() ||
    !Number.isFinite(root.businessDate.getTime())
  )
    return refuse('SUPPLIED_RETURN_DISPOSITION_AND_BUSINESS_DATE');
  const retained = (model: string, id: string) =>
    root.records.filter(
      (record) =>
        record.model === model &&
        record.persistedId === id &&
        record.planKey.startsWith(namespace) &&
        record.receiptReference.startsWith(namespace)
    ).length === 1;
  if (
    original.coverage !== 'SYNTHETIC_CASH_SALE' ||
    original.records.length !== 6 ||
    original.records.some(
      (record) =>
        !retained(record.model, record.persistedId) ||
        !record.planKey.startsWith(namespace) ||
        !root.records.some(
          (saved) =>
            saved.planKey === record.planKey &&
            saved.persistedId === record.persistedId &&
            saved.observedHash === record.observedHash
        )
    ) ||
    !retained('PharmacySale', original.saleId) ||
    !retained('PharmacySaleLine', original.saleLineId) ||
    !retained('PharmacyTender', original.tenderId) ||
    !retained('User', scope.actorId) ||
    !retained('PharmacyStockLocation', input.quarantineLocationId) ||
    !original.receiptDeviceId ||
    !retained('PharmacyRegisteredDevice', original.receiptDeviceId)
  )
    return refuse('ORIGINAL_ROOT_RETAINED_SYNTHETIC_IDENTITIES');
  const actor = await tx.user.findFirst({
    where: {
      organizationId: scope.organizationId,
      id: scope.actorId,
      status: 'ACTIVE',
      name: { startsWith: namespace },
    },
    select: { id: true },
  });
  const branch = await tx.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { id: true, name: true },
  });
  const device = await tx.pharmacyRegisteredDevice.findFirst({
    where: {
      ...scoped,
      id: original.receiptDeviceId,
      status: 'ACTIVE',
      revokedAt: null,
      name: { startsWith: namespace },
    },
    select: { id: true },
  });
  const quarantine = await tx.pharmacyStockLocation.findFirst({
    where: {
      ...scoped,
      id: input.quarantineLocationId,
      active: true,
      kind: 'QUARANTINE',
      code: { startsWith: namespace },
    },
    select: { id: true },
  });
  if (!actor || !branch || !device || !quarantine)
    return refuse('ACTIVE_SYNTHETIC_RETURN_OPERATOR_DEVICE_QUARANTINE');
  const sale = await tx.pharmacySale.findFirst({
    where: { ...scoped, id: original.saleId },
    include: {
      lines: { include: { allocations: true, returnLines: true } },
      tenders: { include: { refunds: true } },
      returns: true,
    },
  });
  const line = sale?.lines[0],
    tender = sale?.tenders[0],
    allocation = line?.allocations[0];
  if (
    !sale ||
    sale.status !== 'COMPLETED' ||
    sale.createdByUserId !== scope.actorId ||
    sale.customerId !== null ||
    sale.receiptNumber !== original.receiptNumber ||
    sale.receiptDeviceId !== original.receiptDeviceId ||
    sale.completedAt?.getTime() !== new Date(original.issuedAt).getTime() ||
    sale.lines.length !== 1 ||
    !line ||
    line.id !== original.saleLineId ||
    line.canonicalUnits !== 1 ||
    line.quantity !== 1 ||
    line.saleUnit !== 'UNIT' ||
    line.canonicalUnitsPerSaleUnit !== 1 ||
    line.discountMinor !== 0 ||
    line.unitPriceMinor !== original.amountMinor ||
    line.returnLines.length !== 0 ||
    sale.returns.length !== 0 ||
    line.allocations.length !== 1 ||
    !allocation ||
    allocation.canonicalUnits !== 1 ||
    original.allocationIds.length !== 1 ||
    allocation.id !== original.allocationIds[0] ||
    allocation.stockMovementId !== original.stockMovementIds[0] ||
    sale.tenders.length !== 1 ||
    !tender ||
    tender.id !== original.tenderId ||
    tender.type !== 'CASH' ||
    tender.refunds.length !== 0 ||
    tender.actorId !== scope.actorId ||
    tender.amountMinor !== original.amountMinor ||
    tender.cashReceivedMinor !== original.cashReceivedMinor ||
    tender.changeGivenMinor !== original.changeGivenMinor ||
    tender.deviceId !== original.receiptDeviceId ||
    !tender.drawerSessionId ||
    !retained('PharmacyDrawerSession', tender.drawerSessionId) ||
    allocation.stockLocationId === quarantine.id ||
    !Number.isSafeInteger(original.amountMinor) ||
    original.amountMinor <= 0
  )
    return refuse('FOREIGN_CHANGED_OR_ALREADY_REVERSED_ORIGINAL');
  const drawers = await tx.pharmacyDrawerSession.findMany({
    where: { ...scoped, deviceId: device.id, status: 'OPEN' },
  });
  if (
    drawers.length !== 1 ||
    drawers[0]!.id !== tender.drawerSessionId ||
    drawers[0]!.openedByActorId !== scope.actorId ||
    drawers[0]!.businessDate.toISOString().slice(0, 10) !==
      root.businessDate.toISOString().slice(0, 10)
  )
    return refuse('ORIGINAL_OPEN_SYNTHETIC_DRAWER');
  const lot = await tx.pharmacyInventoryLot.findFirst({
    where: {
      ...scoped,
      id: allocation.inventoryLotId,
      supplierInvoiceRef: { startsWith: namespace },
      batch: { medicineId: line.medicineId },
    },
    select: { id: true, unitCostMinor: true, unitsPerPack: true },
  });
  if (
    !lot ||
    !retained('PharmacyInventoryLot', lot.id) ||
    lot.unitsPerPack !== 1 ||
    lot.unitCostMinor !== original.margin.cogsMinor
  )
    return refuse('ORIGINAL_RECEIVED_UNIT_LOT_COST');
  const { readCounterReceipt } = await import('../src/lib/pharmacy/counter');
  const receiptBefore = await readCounterReceipt(tx, scoped, sale.id, {
    name: branch.name,
    currency: 'PKR',
  });
  if (JSON.stringify(receiptBefore) !== JSON.stringify(original.receipt))
    return refuse('ORIGINAL_ISSUED_RECEIPT_CHANGED');
  const sourceEntries = await tx.financeJournalEntry.findMany({
    where: { ...scoped, id: { in: original.journalEntryIds } },
    include: { lines: true },
  });
  const legFacts = (legs: typeof original.journalLines) =>
    JSON.stringify(
      [...legs]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((leg) => ({
          id: leg.id,
          entryId: leg.entryId,
          accountCode: leg.accountCode,
          side: leg.side,
          amountMinor: leg.amountMinor,
          branchId: leg.branchId,
          productId: leg.productId,
          lotId: leg.lotId,
          locationId: leg.locationId,
          sourceLineId: leg.sourceLineId,
        }))
    );
  if (
    sourceEntries.length !== 2 ||
    !sourceEntries.some(
      (entry) => entry.sourceKind === 'PHARMACY_SALE_LINE' && entry.sourceId === line.id
    ) ||
    !sourceEntries.some(
      (entry) => entry.sourceKind === 'PHARMACY_TENDER' && entry.sourceId === tender.id
    ) ||
    legFacts(sourceEntries.flatMap((entry) => entry.lines)) !== legFacts(original.journalLines)
  )
    return refuse('ORIGINAL_JOURNAL_CHANGED');
  const availableWhere = {
    ...scoped,
    inventoryLotId: lot.id,
    stockLocationId: allocation.stockLocationId,
    disposition: 'AVAILABLE' as const,
  };
  const quarantineWhere = {
    ...scoped,
    inventoryLotId: lot.id,
    stockLocationId: quarantine.id,
    disposition: 'QUARANTINE' as const,
  };
  const availableBefore = await tx.pharmacyStockBalance.findFirst({ where: availableWhere });
  const quarantineBefore = await tx.pharmacyStockBalance.findFirst({ where: quarantineWhere });
  const drawerWhere = {
    organizationId: scope.organizationId,
    drawerSessionId: tender.drawerSessionId,
  };
  const drawerBefore = await tx.pharmacyDrawerMovement.findMany({ where: drawerWhere });
  const { foldExpectedCash, refundPharmacyTender } = await import('../src/lib/pharmacy/settlement');
  const cashMovement = (row: (typeof drawerBefore)[number]) => {
    if (row.kind === 'CLOSING_COUNT')
      throw new Error('UNSEEDED: ORIGINAL_DRAWER_HAS_CLOSING_COUNT');
    return { kind: row.kind, amountMinor: row.amountMinor };
  };
  const cashBefore = foldExpectedCash(drawerBefore.map(cashMovement));
  if (
    availableBefore?.onHandUnits !== original.stockAfter ||
    cashBefore < tender.amountMinor ||
    (quarantineBefore &&
      (!Number.isSafeInteger(quarantineBefore.onHandUnits) || quarantineBefore.onHandUnits < 0))
  )
    return refuse('CHANGED_STOCK_OR_INSUFFICIENT_DRAWER_CASH');
  const { returnSaleLine } = await import('../src/lib/pharmacy/sales');
  const { postSaleReturnEntry, postTenderRefundEntry } =
    await import('../src/lib/pharmacy/finance-postings');
  const returned = await returnSaleLine(tx, scope, {
    saleLineId: line.id,
    canonicalUnits: 1,
    quarantineLocationId: quarantine.id,
    reason: input.reason,
    integrityDecision: input.integrityDecision,
    idempotencyKey: `${namespace}finance:cash:full-return`,
  });
  if (
    returned.saleReturn.originalSaleId !== sale.id ||
    returned.returnLine.saleLineId !== line.id ||
    returned.returnLine.inventoryLotId !== lot.id ||
    returned.returnLine.stockLocationId !== quarantine.id ||
    returned.returnLine.canonicalUnits !== 1 ||
    returned.returnLine.integrityDecision !== input.integrityDecision ||
    returned.returnLine.stockMovementId !== returned.movement.id ||
    returned.movement.kind !== 'RETURN' ||
    returned.movement.disposition !== 'QUARANTINE' ||
    returned.movement.quantityUnits !== 1
  )
    throw new Error('DEMO_RETURN_STOCK_MISMATCH_ROLLBACK');
  const refunded = await refundPharmacyTender(tx, scope, {
    originalTenderId: tender.id,
    deviceId: device.id,
    businessDate: root.businessDate,
    amountMinor: tender.amountMinor,
    reason: input.reason,
    idempotencyKey: `${namespace}finance:cash:full-refund`,
  });
  if (refunded.replayed) throw new Error('DEMO_RETURN_UNEXPECTED_REFUND_REPLAY_ROLLBACK');
  const refunds = await tx.pharmacyRefund.findMany({
    where: { ...scoped, originalTenderId: tender.id },
  });
  const refund = refunds[0];
  if (
    refunds.length !== 1 ||
    !refund ||
    refund.saleId !== sale.id ||
    refund.amountMinor !== tender.amountMinor ||
    refund.drawerSessionId !== tender.drawerSessionId ||
    refund.providerRef !== null
  )
    throw new Error('DEMO_RETURN_CASH_MISMATCH_ROLLBACK');
  const at = refund.createdAt;
  const stockJournal = await postSaleReturnEntry(tx, scope, {
    saleReturnLineId: returned.returnLine.id,
    at,
  });
  const refundJournal = await postTenderRefundEntry(tx, scope, { refundId: refund.id, at });
  const availableAfter = await tx.pharmacyStockBalance.findFirst({ where: availableWhere });
  const quarantineAfter = await tx.pharmacyStockBalance.findFirst({ where: quarantineWhere });
  const drawerAfter = await tx.pharmacyDrawerMovement.findMany({ where: drawerWhere });
  const newDrawer = drawerAfter.filter((row) => !drawerBefore.some((prior) => prior.id === row.id));
  const receiptAfter = await readCounterReceipt(tx, scoped, sale.id, {
    name: branch.name,
    currency: 'PKR',
  });
  const returnLines = await tx.pharmacySaleReturnLine.findMany({
    where: { ...scoped, saleLineId: line.id },
  });
  const { grossMargin } = await import('../src/lib/pharmacy/finance-reports');
  const margin = (
    await grossMargin(tx, scoped, {
      from: new Date(original.issuedAt),
      to: new Date(at.getTime() + 1),
      by: 'line',
    })
  ).filter((row) => row.key === line.id);
  const net = new Map<string, number>();
  for (const leg of [...stockJournal.lines, ...refundJournal.lines])
    net.set(
      leg.accountCode,
      (net.get(leg.accountCode) ?? 0) + (leg.side === 'DEBIT' ? leg.amountMinor : -leg.amountMinor)
    );
  if (
    net.get('CASH') !== -tender.amountMinor ||
    net.get('SALES_CLEARING') !== 0 ||
    net.get('SALES_REVENUE') !== tender.amountMinor ||
    (net.get('INVENTORY') ?? 0) !== lot.unitCostMinor ||
    (net.get('COST_OF_GOODS_SOLD') ?? 0) !== -lot.unitCostMinor ||
    [...net.values()].reduce((a, b) => a + b, 0) !== 0 ||
    availableAfter?.onHandUnits !== availableBefore.onHandUnits ||
    quarantineAfter?.onHandUnits !== (quarantineBefore?.onHandUnits ?? 0) + 1 ||
    returnLines.length !== 1 ||
    returnLines[0]!.id !== returned.returnLine.id ||
    newDrawer.length !== 1 ||
    newDrawer[0]!.kind !== 'CASH_REFUND' ||
    newDrawer[0]!.amountMinor !== tender.amountMinor ||
    foldExpectedCash(drawerAfter.map(cashMovement)) - cashBefore !== -tender.amountMinor ||
    JSON.stringify(receiptAfter) !== JSON.stringify(receiptBefore) ||
    margin.length !== 1 ||
    margin[0]!.revenueMinor !== 0 ||
    margin[0]!.discountMinor !== 0 ||
    margin[0]!.cogsMinor !== 0 ||
    margin[0]!.grossMarginMinor !== 0
  )
    throw new Error('DEMO_RETURN_RECONCILIATION_MISMATCH_ROLLBACK');
  const record = (
    model: string,
    id: string,
    suffix: string,
    facts: DemoObservedRecord['observedFacts']
  ): DemoObservedRecord => ({
    model,
    persistedId: id,
    planKey: `${namespace}finance:cash:${suffix}`,
    receiptReference: `${namespace}finance:cash`,
    observedFacts: facts,
    observedHash: createHash('sha256').update(JSON.stringify({ model, id, facts })).digest('hex'),
  });
  return {
    status: 'applied' as const,
    records: [
      record('PharmacySaleReturn', returned.saleReturn.id, 'full-return', {
        originalSaleId: sale.id,
        originalReceiptNumber: sale.receiptNumber,
      }),
      record('PharmacySaleReturnLine', returned.returnLine.id, 'full-return-line', {
        saleLineId: line.id,
        canonicalUnits: 1,
        integrityDecision: input.integrityDecision,
      }),
      record('PharmacyStockMovement', returned.movement.id, 'return-stock', {
        inventoryLotId: lot.id,
        stockLocationId: quarantine.id,
        disposition: 'QUARANTINE',
        quantityUnits: 1,
      }),
      record('PharmacyRefund', refund.id, 'full-refund', {
        originalTenderId: tender.id,
        originalSaleId: sale.id,
        amountMinor: refund.amountMinor,
      }),
      record('PharmacyDrawerMovement', newDrawer[0]!.id, 'refund-drawer', {
        kind: 'CASH_REFUND',
        amountMinor: tender.amountMinor,
      }),
      record('FinanceJournalEntry', stockJournal.id, 'return-journal', {
        sourceId: returned.returnLine.id,
      }),
      record('FinanceJournalEntry', refundJournal.id, 'refund-journal', { sourceId: refund.id }),
    ],
    gaps: [
      {
        function: 'sales.returnSaleLine:partial',
        status: 'UNSEEDED',
        reason:
          'The accepted cash fixture sold one canonical UNIT; a fractional-unit partial return is not eligible.',
      },
      {
        function: 'sales.changeSaleStatus:void',
        status: 'UNSEEDED',
        reason:
          'Void only accepts OPEN; this source is COMPLETED. This helper does not relabel a paid refund as void.',
      },
    ] satisfies DemoGap[],
    originalSaleId: sale.id,
    originalReceipt: receiptAfter,
    refundId: refund.id,
    returnedUnits: 1,
    stockDisposition: 'QUARANTINE' as const,
    refundedCashMinor: refund.amountMinor,
    drawerCashDeltaMinor: -refund.amountMinor,
    availableStockDelta: 0,
    quarantineStockDelta: 1,
    reversalJournalIds: [stockJournal.id, refundJournal.id],
    reversalJournalLines: [...stockJournal.lines, ...refundJournal.lines],
    margin: margin[0]!,
    physicalDrawerProof: false as const,
  };
}

/** One OTC UNIT from one prerecorded synthetic lot/location; no clinical
 * approvals, discounts, provider, printer, contact, refund or status shortcut.
 * Refusals precede sale creation. ALL later failures throw to root for rollback.
 * Never catch an error and commit this transaction. This is not a replay API:
 * root must return its retained result on rerun rather than call this step twice.
 */
export async function executePharmacyDemoCashSale(
  tx: ScopedDb,
  root: PharmacyDemoCashRoot,
  input: {
    deviceId: string;
    drawerSessionId: string;
    medicineId: string;
    presentationId: string;
    packLevelId: string;
    inventoryLotId: string;
    stockLocationId: string;
    expectedAmountMinor: number;
    cashReceivedMinor: number;
  }
) {
  const { scope, namespace } = root;
  const refuse = (reason: string) => ({
    status: 'refused' as const,
    unmetPrerequisites: [`UNSEEDED: ${reason}`],
  });
  if (!isPharmacyDemoNamespace(namespace)) return refuse('INVALID_DEMO_NAMESPACE');
  if (
    root.entitlements.organizationId !== scope.organizationId ||
    root.entitlements.vertical !== 'PHARMACY' ||
    !root.entitlements.enabledModules.includes('pharmacy-counter')
  )
    return refuse('CURRENT_PHARMACY_COUNTER_ENTITLEMENT');
  if (!Number.isFinite(root.businessDate.getTime())) return refuse('BUSINESS_DATE');
  if (
    !Number.isSafeInteger(input.expectedAmountMinor) ||
    input.expectedAmountMinor <= 0 ||
    !Number.isSafeInteger(input.cashReceivedMinor) ||
    input.cashReceivedMinor < input.expectedAmountMinor
  )
    return refuse('EXACT_CASH_INPUT');
  const required = [
    ['User', scope.actorId],
    ['PharmacyRegisteredDevice', input.deviceId],
    ['PharmacyDrawerSession', input.drawerSessionId],
    ['PharmacyInventoryLot', input.inventoryLotId],
    ['PharmacyStockLocation', input.stockLocationId],
  ];
  if (
    required.some(
      ([model, id]) =>
        root.records.filter(
          (record) =>
            record.model === model &&
            record.persistedId === id &&
            record.planKey.startsWith(namespace) &&
            record.receiptReference.startsWith(namespace)
        ).length !== 1
    )
  )
    return refuse('ROOT_PRERECORDED_SYNTHETIC_IDS');
  const scoped = { organizationId: scope.organizationId, branchId: scope.branchId };
  const actor = await tx.user.findFirst({
    where: {
      id: scope.actorId,
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      name: { startsWith: namespace },
    },
    select: { id: true },
  });
  const branch = await tx.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true, name: true },
  });
  const device = await tx.pharmacyRegisteredDevice.findFirst({
    where: {
      ...scoped,
      id: input.deviceId,
      name: { startsWith: namespace },
      status: 'ACTIVE',
      revokedAt: null,
    },
    select: { id: true },
  });
  const drawers = await tx.pharmacyDrawerSession.findMany({
    where: { ...scoped, deviceId: input.deviceId, status: 'OPEN' },
    select: { id: true, openedByActorId: true, businessDate: true },
  });
  if (
    !actor ||
    !branch ||
    !device ||
    drawers.length !== 1 ||
    drawers[0]!.id !== input.drawerSessionId ||
    drawers[0]!.openedByActorId !== scope.actorId ||
    drawers[0]!.businessDate.toISOString().slice(0, 10) !==
      root.businessDate.toISOString().slice(0, 10)
  )
    return refuse('ACTIVE_SCOPED_SYNTHETIC_OPERATOR_DEVICE_DRAWER');
  const at = new Date(); // Real services allocate/issue at wall clock; never backdate them.
  const profile = await tx.branchRegulatoryProfile.findFirst({
    where: {
      ...scoped,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    include: { jurisdictionRuleSet: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!profile) return refuse('CURRENT_STORED_REGULATORY_PROFILE');
  const { assertBranchMayOperate } = await import('../src/lib/pharmacy/regulatory');
  // Root owns denial audit in its orchestration; no out-of-transaction audit client.
  assertBranchMayOperate(
    { ...profile, ruleSet: profile.jurisdictionRuleSet, auditDenied: () => undefined },
    { name: 'pharmacy-demo.cash-sale', at }
  );
  const medicine = await tx.medicine.findFirst({
    where: {
      id: input.medicineId,
      organizationId: scope.organizationId,
      saleable: true,
      otc: true,
      rx: false,
      restricted: false,
      controlled: false,
      highAlert: false,
      coldChain: false,
    },
    select: { id: true },
  });
  const presentation = await tx.presentation.findFirst({
    where: {
      id: input.presentationId,
      organizationId: scope.organizationId,
      medicineId: input.medicineId,
    },
    select: { id: true },
  });
  const pack = await tx.packLevel.findFirst({
    where: {
      id: input.packLevelId,
      organizationId: scope.organizationId,
      presentationId: input.presentationId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    select: { id: true },
  });
  const lot = await tx.pharmacyInventoryLot.findFirst({
    where: {
      ...scoped,
      id: input.inventoryLotId,
      packLevelId: input.packLevelId,
      supplierInvoiceRef: { startsWith: namespace },
      batch: { medicineId: input.medicineId },
    },
    select: { id: true, unitCostMinor: true, printedMrpMinor: true, unitsPerPack: true },
  });
  if (!medicine || !presentation || !pack || !lot)
    return refuse('OBSERVED_OTC_PRODUCT_AND_MARKED_SYNTHETIC_LOT');
  // FEFO is authoritative. Refuse mixed inventory before allocation; recheck the
  // service's actual allocations afterwards to catch concurrent candidate changes.
  const balances = await tx.pharmacyStockBalance.findMany({
    where: { ...scoped, onHandUnits: { gt: 0 }, lot: { batch: { medicineId: input.medicineId } } },
  });
  if (
    balances.length !== 1 ||
    balances[0]!.inventoryLotId !== lot.id ||
    balances[0]!.stockLocationId !== input.stockLocationId ||
    balances[0]!.disposition !== 'AVAILABLE' ||
    !Number.isSafeInteger(lot.unitsPerPack) ||
    lot.unitsPerPack < 1 ||
    !Number.isSafeInteger(balances[0]!.onHandUnits) ||
    balances[0]!.onHandUnits < 1 ||
    !Number.isSafeInteger(balances[0]!.sealedPacks) ||
    balances[0]!.sealedPacks < 0 ||
    !Number.isSafeInteger(balances[0]!.looseUnits) ||
    balances[0]!.looseUnits < 0 ||
    !Number.isSafeInteger(balances[0]!.sealedPacks * lot.unitsPerPack + balances[0]!.looseUnits) ||
    balances[0]!.sealedPacks * lot.unitsPerPack + balances[0]!.looseUnits !==
      balances[0]!.onHandUnits ||
    // postSaleMovements consumes loose units first, then only whole sealed packs.
    // A sealed canonical UNIT is sellable; larger packs still require BREAK_PACK.
    (1 - Math.min(balances[0]!.looseUnits, 1)) % lot.unitsPerPack !== 0
  )
    return refuse('EXCLUSIVE_PRERECORDED_SYNTHETIC_STOCK');
  const quote = priceFromLot({
    printedMrpMinor: lot.printedMrpMinor,
    canonicalUnitsInPack: lot.unitsPerPack,
    canonicalUnitsPerSaleUnit: 1,
  });
  if (quote.unitPriceMinor !== input.expectedAmountMinor) return refuse('OBSERVED_PRICE_CHANGED');
  const { createSale, addSaleLine } = await import('../src/lib/pharmacy/sales');
  const { applyPharmacyTender } = await import('../src/lib/pharmacy/settlement');
  const { postSaleLineEntry, postTenderEntry } =
    await import('../src/lib/pharmacy/finance-postings');
  const drawerBefore = await tx.pharmacyDrawerMovement.aggregate({
    where: { organizationId: scope.organizationId, drawerSessionId: input.drawerSessionId },
    _count: true,
    _sum: { amountMinor: true },
  });
  const sale = await createSale(tx, scope);
  const added = await addSaleLine(tx, scope, {
    saleId: sale.id,
    medicineId: input.medicineId,
    presentationId: input.presentationId,
    packLevelId: input.packLevelId,
    saleUnit: 'UNIT',
    quantity: 1,
    canonicalUnitsPerSaleUnit: 1,
    idempotencyKey: `${namespace}finance:cash:line`,
  });
  if (
    added.line.saleId !== sale.id ||
    added.line.unitPriceMinor !== input.expectedAmountMinor ||
    added.line.discountMinor !== 0 ||
    added.allocation.allocations.length !== 1 ||
    added.allocation.allocations[0]!.inventoryLotId !== lot.id ||
    added.allocation.allocations[0]!.stockLocationId !== input.stockLocationId ||
    added.allocation.allocations[0]!.units !== 1
  )
    throw new Error('DEMO_CASH_ALLOCATION_CHANGED_ROLLBACK');
  const tenderResult = await applyPharmacyTender(tx, scope, {
    saleId: sale.id,
    deviceId: input.deviceId,
    businessDate: root.businessDate,
    type: 'CASH',
    amountMinor: input.expectedAmountMinor,
    cashReceivedMinor: input.cashReceivedMinor,
    idempotencyKey: `${namespace}finance:cash:tender`,
  });
  // Tender replay result is deliberately broad in the owning API. Read actual
  // persisted tender/sale instead of casting an idempotency JSON blob to facts.
  const tenders = await tx.pharmacyTender.findMany({ where: { ...scoped, saleId: sale.id } });
  const issued = await tx.pharmacySale.findFirst({ where: { ...scoped, id: sale.id } });
  const tender = tenders[0];
  if (
    tenderResult.replayed ||
    tenders.length !== 1 ||
    !tender ||
    tender.type !== 'CASH' ||
    tender.amountMinor !== input.expectedAmountMinor ||
    tender.cashReceivedMinor !== input.cashReceivedMinor ||
    tender.changeGivenMinor !== input.cashReceivedMinor - input.expectedAmountMinor ||
    tender.drawerSessionId !== input.drawerSessionId ||
    issued?.status !== 'COMPLETED' ||
    issued.receiptNumber === null ||
    !issued.completedAt
  )
    throw new Error('DEMO_CASH_SETTLEMENT_MISMATCH_ROLLBACK');
  const saleJournal = await postSaleLineEntry(tx, scope, {
    saleLineId: added.line.id,
    at: issued.completedAt,
  });
  const tenderJournal = await postTenderEntry(tx, scope, {
    tenderId: tender.id,
    at: issued.completedAt,
  });
  const { readCounterReceipt } = await import('../src/lib/pharmacy/counter');
  const receipt = await readCounterReceipt(tx, scoped, sale.id, {
    name: branch.name,
    currency: 'PKR',
  });
  if (
    receipt.receiptNumber !== issued.receiptNumber ||
    receipt.saleId !== sale.id ||
    receipt.lines.length !== 1 ||
    receipt.lines[0]!.saleLineId !== added.line.id ||
    receipt.lines[0]!.identityStatus !== 'ISSUED' ||
    receipt.totals.netMinor !== input.expectedAmountMinor ||
    receipt.totals.tenderedMinor !== input.expectedAmountMinor ||
    receipt.totals.changeMinor !== input.cashReceivedMinor - input.expectedAmountMinor
  )
    throw new Error('DEMO_CASH_RECEIPT_MISMATCH_ROLLBACK');
  const allocations = await tx.pharmacySaleLineAllocation.findMany({
    where: { ...scoped, saleLineId: added.line.id },
  });
  const movements = await tx.pharmacyStockMovement.findMany({
    where: { ...scoped, id: { in: added.allocation.movementIds } },
  });
  const after = await tx.pharmacyStockBalance.findFirst({
    where: {
      ...scoped,
      inventoryLotId: lot.id,
      stockLocationId: input.stockLocationId,
      disposition: 'AVAILABLE',
    },
  });
  const drawerAfter = await tx.pharmacyDrawerMovement.aggregate({
    where: { organizationId: scope.organizationId, drawerSessionId: input.drawerSessionId },
    _count: true,
    _sum: { amountMinor: true },
  });
  const { grossMargin } = await import('../src/lib/pharmacy/finance-reports');
  const margin = (
    await grossMargin(tx, scoped, {
      from: issued.completedAt,
      to: new Date(issued.completedAt.getTime() + 1),
      by: 'line',
    })
  ).filter((row) => row.key === added.line.id);
  const expectedMargin = input.expectedAmountMinor - lot.unitCostMinor;
  const journalNet = new Map<string, number>();
  for (const leg of [...saleJournal.lines, ...tenderJournal.lines])
    journalNet.set(
      leg.accountCode,
      (journalNet.get(leg.accountCode) ?? 0) +
        (leg.side === 'DEBIT' ? leg.amountMinor : -leg.amountMinor)
    );
  if (
    journalNet.get('CASH') !== input.expectedAmountMinor ||
    journalNet.get('SALES_CLEARING') !== 0 ||
    journalNet.get('SALES_REVENUE') !== -input.expectedAmountMinor ||
    (journalNet.get('COST_OF_GOODS_SOLD') ?? 0) !== lot.unitCostMinor ||
    (journalNet.get('INVENTORY') ?? 0) !== -lot.unitCostMinor ||
    [...journalNet.values()].reduce((sum, value) => sum + value, 0) !== 0 ||
    drawerAfter._count !== drawerBefore._count + 1 ||
    (drawerAfter._sum.amountMinor ?? 0) - (drawerBefore._sum.amountMinor ?? 0) !==
      input.expectedAmountMinor
  )
    throw new Error('DEMO_CASH_JOURNAL_DRAWER_MISMATCH_ROLLBACK');
  if (
    allocations.length !== 1 ||
    allocations[0]!.canonicalUnits !== 1 ||
    movements.length !== 1 ||
    movements[0]!.quantityUnits !== -1 ||
    after?.onHandUnits !== balances[0]!.onHandUnits - 1 ||
    margin.length !== 1 ||
    margin[0]!.revenueMinor !== input.expectedAmountMinor ||
    margin[0]!.discountMinor !== 0 ||
    margin[0]!.cogsMinor !== lot.unitCostMinor ||
    margin[0]!.grossMarginMinor !== expectedMargin
  )
    throw new Error('DEMO_CASH_READBACK_MISMATCH_ROLLBACK');
  const observedRecord = (
    model: string,
    persistedId: string,
    suffix: string,
    observedFacts: DemoObservedRecord['observedFacts']
  ): DemoObservedRecord => ({
    model,
    persistedId,
    planKey: `${namespace}finance:cash:${suffix}`,
    receiptReference: `${namespace}finance:cash`,
    observedFacts,
    observedHash: createHash('sha256')
      .update(JSON.stringify({ model, persistedId, observedFacts }))
      .digest('hex'),
  });
  const records = [
    observedRecord('PharmacySale', sale.id, 'sale', {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      receiptNumber: issued.receiptNumber,
      receiptDeviceId: issued.receiptDeviceId,
      status: issued.status,
    }),
    observedRecord('PharmacySaleLine', added.line.id, 'line', {
      saleId: sale.id,
      canonicalUnits: 1,
      amountMinor: tender.amountMinor,
    }),
    observedRecord('PharmacyTender', tender.id, 'tender', {
      saleId: sale.id,
      drawerSessionId: input.drawerSessionId,
      amountMinor: tender.amountMinor,
      cashReceivedMinor: tender.cashReceivedMinor,
      changeGivenMinor: tender.changeGivenMinor,
    }),
    observedRecord('FinanceJournalEntry', saleJournal.id, 'sale-journal', {
      sourceId: added.line.id,
    }),
    observedRecord('FinanceJournalEntry', tenderJournal.id, 'tender-journal', {
      sourceId: tender.id,
    }),
    observedRecord('PharmacyStockMovement', movements[0]!.id, 'stock', {
      inventoryLotId: lot.id,
      stockLocationId: input.stockLocationId,
      quantityUnits: -1,
    }),
  ];
  return {
    status: 'applied' as const,
    records,
    gaps: [] as DemoGap[],
    saleId: sale.id,
    saleLineId: added.line.id,
    tenderId: tender.id,
    receiptNumber: issued.receiptNumber,
    receiptDeviceId: issued.receiptDeviceId,
    issuedAt: issued.completedAt,
    receipt,
    allocationIds: allocations.map((row) => row.id),
    stockMovementIds: movements.map((row) => row.id),
    journalEntryIds: [saleJournal.id, tenderJournal.id],
    journalLines: [...saleJournal.lines, ...tenderJournal.lines],
    drawerMovementCountDelta: drawerAfter._count - drawerBefore._count,
    drawerMoneyDeltaMinor:
      (drawerAfter._sum.amountMinor ?? 0) - (drawerBefore._sum.amountMinor ?? 0),
    amountMinor: tender.amountMinor,
    cashReceivedMinor: tender.cashReceivedMinor,
    changeGivenMinor: tender.changeGivenMinor,
    stockBefore: balances[0]!.onHandUnits,
    stockAfter: after.onHandUnits,
    margin: margin[0]!,
    coverage: 'SYNTHETIC_CASH_SALE' as const,
    physicalDrawerProof: false as const,
  };
}

/** Internal tooling only. Root must validate identity, branch assignment, module
 * and report capabilities, approved references and receipt/tombstones FIRST.
 * These facts are not an authorization token and must never come from a client.
 * No DB client, transaction, executable main or mutation is owned here.
 */
export type PharmacyDemoFinanceContext = PharmacyDemoContext;

export interface PharmacyDemoFinanceStock {
  medicineId: string;
  presentationId: string;
  inventoryLotId: string;
  stockLocationId: string;
  printedMrpMinor: number;
  unitsPerPack: number;
  /** Real pre-approved conversion for each offered sale unit, supplied by root. */
  units: readonly {
    saleUnit: 'PACK' | 'STRIP' | 'UNIT';
    packLevelId: string;
    canonicalUnitsPerSaleUnit: number;
  }[];
}

export const pharmacyDemoFinanceGaps = [
  {
    scenario: 'open-sale',
    service: 'sales.createSale',
    reason:
      'OWNER-INPUT: createSale has no namespace/idempotency input. Root must supply atomic retained receipt binding and tombstone reconciliation before creating a draft.',
  },
  {
    scenario: 'sale-tender',
    service: 'sales.addSaleLine / settlement.applyPharmacyTender',
    reason:
      'OWNER-INPUT: approved stock, service actor, existing drawer/device and regulatory eligibility must be validated. addSaleLine allocates stock even while OPEN; replay must recover exact line/allocation refs before calling it again.',
  },
  {
    scenario: 'partial-full-return',
    service: 'sales.returnSaleLine / settlement.refundPharmacyTender',
    reason:
      'OWNER-INPUT: returnSaleLine chooses one allocation; stock return and refund are separate. Require supplied quarantine/integrity decision and exact allocation, tender, refund and journal reconciliation before replay.',
  },
  {
    scenario: 'void',
    service: 'sales.changeSaleStatus',
    reason:
      'OWNER-INPUT: void accepts OPEN only and reverses allocations; root must prove no prior tender and retain/reconcile the resulting state. It is not a refund workflow.',
  },
] as const;

function ref(value: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128)
    throw new Error('INVALID_REFERENCE');
  return value;
}

function integer(value: number, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new Error('INVALID_ARITHMETIC');
  return value;
}

/** Fixed maximum: one approved lot, one example per PACK/STRIP/UNIT, quantity 1.
 * Arithmetic is a quote only: no allocated cost, revenue or stock proof implied.
 */
export function planPharmacyDemoFinance(
  context: PharmacyDemoFinanceContext,
  stock?: PharmacyDemoFinanceStock
) {
  const scope = {
    organizationId: ref(context.organizationId),
    branchId: ref(context.branchId),
    ownerUserId: ref(context.ownerUserId),
    namespace: ref(context.namespace),
  };
  if (!isPharmacyDemoNamespace(scope.namespace)) throw new Error('INVALID_DEMO_NAMESPACE');
  if (context.currency !== 'PKR') throw new Error('INVALID_CURRENCY');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(context.businessDate) ||
    !Number.isFinite(Date.parse(context.businessDate)) ||
    new Date(context.businessDate).toISOString().slice(0, 10) !== context.businessDate
  )
    throw new Error('INVALID_BUSINESS_DATE');
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(context.scenarioAt) ||
    !Number.isFinite(Date.parse(context.scenarioAt))
  )
    throw new Error('INVALID_SCENARIO_AT');
  new Intl.DateTimeFormat('en', { timeZone: context.timezone }).format(
    new Date(context.scenarioAt)
  );
  const units = stock?.units ?? [];
  if (
    stock &&
    (units.length < 1 ||
      units.length > 3 ||
      new Set(units.map((unit) => unit.saleUnit)).size !== units.length)
  )
    throw new Error('INVALID_UNIT_EXAMPLES');
  const examples = stock
    ? [...units]
        .sort((a, b) => a.saleUnit.localeCompare(b.saleUnit))
        .map((unit) => {
          if (!['PACK', 'STRIP', 'UNIT'].includes(unit.saleUnit))
            throw new Error('INVALID_UNIT_EXAMPLES');
          const factor = integer(unit.canonicalUnitsPerSaleUnit, true);
          const pack = integer(stock.unitsPerPack, true);
          if (
            factor > pack ||
            pack % factor !== 0 ||
            (unit.saleUnit === 'PACK' && factor !== pack) ||
            (unit.saleUnit === 'UNIT' && factor !== 1)
          )
            throw new Error('INVALID_UNIT_EXAMPLES');
          const price = priceFromLot({
            printedMrpMinor: integer(stock.printedMrpMinor),
            canonicalUnitsInPack: pack,
            canonicalUnitsPerSaleUnit: factor,
          });
          return {
            ref: `${scope.namespace}:finance:${unit.saleUnit.toLowerCase()}`,
            medicineId: ref(stock.medicineId),
            presentationId: ref(stock.presentationId),
            inventoryLotId: ref(stock.inventoryLotId),
            stockLocationId: ref(stock.stockLocationId),
            packLevelId: ref(unit.packLevelId),
            saleUnit: unit.saleUnit,
            quantity: 1,
            canonicalUnits: canonicalUnits(1, [factor]),
            unitPriceMinor: integer(price.unitPriceMinor),
            proRataCeilingMinor: integer(price.proRataCeilingMinor),
          };
        })
    : [];
  const facts = {
    version: 1,
    scope,
    businessDate: context.businessDate,
    scenarioAt: new Date(context.scenarioAt).toISOString(),
    timezone: context.timezone,
    currency: context.currency,
    // Observations bind the quote, but never authorize a service call.
    observations: canonicalObservations(context),
    // Include source price even when rounding produces the same quote.
    sourcePrice: stock
      ? { printedMrpMinor: stock.printedMrpMinor, unitsPerPack: stock.unitsPerPack }
      : null,
    examples,
    gaps: pharmacyDemoFinanceGaps,
    coverage: 'ARITHMETIC_ONLY' as const,
    regulatory: 'UNSEEDED/OWNER-INPUT' as const,
    writesEnabled: false as const,
  };
  const gaps: DemoGap[] = pharmacyDemoFinanceGaps.map((gap) => ({
    function: gap.service,
    status: 'OWNER-INPUT',
    reason: gap.reason,
  }));
  gaps.push({
    function: 'finance-reports.grossMargin',
    status: 'UNSEEDED',
    reason:
      'The data-only context cannot authorize a report or establish retained sale-line ownership. Require the genuine scoped service context and root receipt reconciliation; journal arithmetic alone is not money/stock proof.',
  });
  if (!stock)
    gaps.push({
      function: 'medicine.priceFromLot',
      status: 'OWNER-INPUT',
      reason:
        'Supply observed lot price and approved pack conversions; no stock reference was supplied.',
    });
  if (stock) {
    const required = [
      ['medicine', stock.medicineId],
      ['presentation', stock.presentationId],
      ['location', stock.stockLocationId],
      ...stock.units.map((unit) => ['pack', unit.packLevelId]),
    ];
    for (const [kind, id] of required) {
      const matches = context.references.filter((item) => item.kind === kind && item.id === id);
      if (
        matches.length !== 1 ||
        !matches[0]!.approved ||
        !matches[0]!.observedHash ||
        matches[0]!.organizationId !== context.organizationId ||
        matches[0]!.branchId !== context.branchId
      )
        gaps.push({
          function: 'finance.reference',
          status: 'OWNER-INPUT',
          reason: `Missing or ambiguous scoped observation: ${kind}:${id}`,
        });
    }
  }
  gaps.sort((a, b) => {
    const left = JSON.stringify(a),
      right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const plan = {
    lane: 'finance',
    namespace: scope.namespace,
    digest: createHash('sha256').update(JSON.stringify({ facts, gaps })).digest('hex'),
    // Quotes are not persistent records. No model/ID or expected posted facts invented.
    records: [],
    gaps,
  } satisfies PharmacyDemoPlan;
  return { ...facts, ...plan };
}

function canonicalObservations(context: PharmacyDemoContext) {
  const order = <T>(items: T[]) =>
    items.sort((a, b) => {
      const left = JSON.stringify(a),
        right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return {
    actors: order(
      context.actors.map((actor) => ({
        userId: actor.userId,
        actorId: actor.actorId,
        organizationId: actor.organizationId,
        branchId: actor.branchId,
        active: actor.active,
        synthetic: actor.synthetic,
        capabilities: [...actor.capabilities].sort(),
      }))
    ),
    references: order(
      context.references.map((item) => ({
        kind: item.kind,
        id: item.id,
        organizationId: item.organizationId,
        branchId: item.branchId,
        approved: item.approved,
        observedHash: item.observedHash,
      }))
    ),
    modules: order(context.modules.map((module) => ({ key: module.key, enabled: module.enabled }))),
  };
}

/** Pure assertion over genuine grossMargin output; not a DB execution adapter. */
export interface PharmacyDemoMarginRow {
  key: string | null;
  revenueMinor: number;
  discountMinor: number;
  cogsMinor: number;
  grossMarginMinor: number;
}
/** No runnable root/service contract has been supplied. Manual observations are
 * never authority, even when every approved/synthetic/capability flag is true.
 * Refuse before any service call; do not invent a transaction or callback adapter.
 */
export async function executePharmacyDemoFinance(
  context: PharmacyDemoFinanceContext,
  stock: PharmacyDemoFinanceStock | undefined,
  expectedPlanHash: string
): Promise<PharmacyDemoResult> {
  const plan = planPharmacyDemoFinance(context, stock);
  if (plan.digest !== expectedPlanHash)
    return { status: 'refused', unmetPrerequisites: ['PLAN_CHANGED'] };
  return {
    status: 'refused',
    unmetPrerequisites: plan.gaps.map((gap) => `${gap.function}: ${gap.reason}`),
  };
}

/** Root must establish retained-line ownership before supplying IDs. This pure
 * check never claims authorization, live revenue or tender/stock reconciliation.
 */
export function inspectPharmacyDemoJournalArithmetic(
  source: readonly PharmacyDemoMarginRow[],
  ids: readonly string[]
) {
  if (ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length)
    throw new Error('INVALID_RETAINED_LINES');
  ids.forEach(ref);
  const rows = source.filter((row) => row.key !== null && ids.includes(row.key));
  if (new Set(rows.map((row) => row.key)).size !== rows.length)
    throw new Error('DUPLICATE_REPORT_LINE');
  for (const row of rows) {
    const values = [row.revenueMinor, row.discountMinor, row.cogsMinor, row.grossMarginMinor];
    if (
      !values.every(Number.isSafeInteger) ||
      row.revenueMinor - row.discountMinor - row.cogsMinor !== row.grossMarginMinor
    )
      throw new Error('JOURNAL_MARGIN_MISMATCH');
  }
  return {
    moneyStockReconciled: false as const,
    drawerProof: false as const,
    journalInspection:
      rows.length === ids.length
        ? ('JOURNAL_ARITHMETIC_ONLY' as const)
        : ('MISSING_JOURNAL_LINES' as const),
    rows,
  };
}
