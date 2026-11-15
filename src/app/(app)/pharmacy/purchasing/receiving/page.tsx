import { ProgressiveLines } from '../_components/progressive-lines';
import { APPROVAL_BLOCKED } from '@/lib/pharmacy/purchase-approval';
import type { Metadata } from 'next';
import type * as React from 'react';
import { revalidatePath } from 'next/cache';
import { PurchasingActionForm } from '../_components/action-form';
import { PurchasingOutcomeScope, PurchasingOutcomes } from '../_components/action-outcomes';
import { PackPhotoReader } from '../_components/pack-photo-reader';

import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { hasModule } from '@/lib/entitlements';
import {
  GS1_WARNING_CODES,
  receivedPacksForScan,
  type Gs1WarningCode,
} from '@/lib/pharmacy/gs1-datamatrix';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import { reconcileInputTaxBills } from '@/lib/pharmacy/input-tax-reconciliation';
import type {
  GoodsReceiptDetail,
  MedicineOption,
  PurchaseOrderDetail,
  PurchasingWorkspace,
  ReceivingExceptionRow,
  ScanResolution,
  StockLocationOption,
} from '@/lib/pharmacy/purchasing-console';
import { packConversionLabel } from '@/lib/pharmacy/pack-conversion-label';
import { configuredPackLabelOcrAdapterName } from '@/lib/pharmacy/pack-label-ocr';
import {
  defaultReceivingLocationId,
  EXTRA_LOT_SLOTS,
  findRepeatedLot,
  lotSlotKey,
} from '@/lib/pharmacy/pack-photo-receiving';
import {
  BranchPicker,
  ChooseBranchState,
  NoBranchState,
  resolveBranch,
} from '../_components/branch-scope';
import {
  AccessState,
  EmptyState,
  LoadFailure,
  NoticeBanner,
  PurchasingHeader,
  PurchasingTabs,
} from '../_components/console-chrome';
import {
  Derived,
  SelectField,
  SubmitButton,
  supplierOptions,
  TextAreaField,
  TextField,
} from '../_components/form-controls';
import {
  purchasingOutcome,
  PurchasingValidationError,
  dateOnly,
  dateTime,
  destination,
  field,
  integerField,
  money,
  moneyFieldMinor,
  noticeFrom,
  NO_ACTOR,
  optionalField,
  optionalIntegerField,
  param,
  purchasingCaller,
  PURCHASING_ROUTE,
  tenantContext,
  units,
  dateField,
  today,
  type Notice,
  type SearchQuery,
} from '../_lib/console';
import {
  readPolicyForDisplay,
  supplierChecksOn,
  supplierComplianceCaller,
} from '../suppliers/_lib/supplier-compliance';

export const metadata: Metadata = { title: 'Goods in · Pharmacy purchasing' };

const ROUTE = `${PURCHASING_ROUTE}/receiving`;
const HEADING = 'Goods in';
const DESCRIPTION =
  'The receiving bench. Capture batch, expiry, printed MRP, pack level, quantity, bonus and cost against a purchase order or a direct purchase, then post it into the batch ledger.';

const DIRECT_SLOTS = [0, 1, 2] as const;

/**
 * PUR-02 receiving, PUR-04 match exceptions and PUR-05 direct purchase.
 *
 * The layout is ordered the way the bench works rather than the way the data
 * model is drawn: the scan box first, then what is blocked (the exception
 * queue), then the capture form, then what you have already filed. The pack → unit
 * conversion, the outstanding balance and the resulting unit cost are all read
 * back beside the field that drives them, because a number that is only visible
 * after posting is a number nobody checked.
 */
export default async function PharmacyReceivingPage({
  searchParams,
}: {
  searchParams: Promise<SearchQuery>;
}) {
  const query = await searchParams;
  const notice = noticeFrom(query);
  const ctx = await tenantContext();
  if (!ctx)
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={false} />;
  const moduleEnabled = hasModule(ctx.entitlements, 'pharmacy-procurement');
  if (!moduleEnabled || !ctx.session?.user) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }
  if (!(await actorCanProcure(ctx.db, ctx.session.user.id))) {
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled />;
  }
  const caller = await purchasingCaller();
  if (!caller) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }

  let workspace: PurchasingWorkspace;
  let orders: PurchaseOrderDetail[];
  try {
    [workspace, orders] = await Promise.all([caller.workspace(), caller.purchaseOrders()]);
  } catch {
    return (
      <Frame notice={notice}>
        <LoadFailure detail="The receiving bench could not load its pickers." retryHref={ROUTE} />
      </Frame>
    );
  }
  // DEV-753: off when a listed supplier says so; with none listed, ask the stored setting
  // (fail closed: anything but a positive OFF reads as checks on).
  const checksOff =
    workspace.suppliers.length > 0
      ? workspace.suppliers.some((supplier) => supplier.compliance?.checked === false)
      : !supplierChecksOn(await readPolicyForDisplay(await supplierComplianceCaller()));

  const scope = resolveBranch(workspace.branches, param(query, 'branch'));
  if (scope.kind === 'none') {
    return (
      <Frame notice={notice}>
        <NoBranchState surface="Goods in" />
      </Frame>
    );
  }
  if (scope.kind === 'unchosen') {
    return (
      <Frame notice={notice}>
        <ChooseBranchState branches={scope.branches} route={ROUTE} surface="Goods in" />
      </Frame>
    );
  }

  const branchId = scope.branch.id;
  const procurementApprovers = workspace.procurementApprovers.filter(
    (person) =>
      person.branchIds.includes(branchId) &&
      (person.id !== ctx.session!.user.id || person.soloBranchIds?.includes(branchId))
  );
  const exceptionStatus = param(query, 'exceptions') === 'resolved' ? 'RESOLVED' : 'OPEN';

  let receipts: GoodsReceiptDetail[];
  let exceptions: ReceivingExceptionRow[];
  try {
    [receipts, exceptions] = await Promise.all([
      caller.goodsReceipts({ branchId }),
      caller.receivingExceptionQueue({ branchId, status: exceptionStatus }),
    ]);
  } catch {
    return (
      <Frame branch={scope} notice={notice}>
        <LoadFailure
          detail="Receipts for this branch could not be read. This read failure does not confirm or undo earlier changes. Check their outcomes before retrying."
          retryHref={`${ROUTE}?branch=${encodeURIComponent(branchId)}`}
        />
      </Frame>
    );
  }

  const locations = workspace.stockLocations.filter((location) => location.branchId === branchId);
  // DEV-752: the receiving shelf starts on the branch's own default (or its only
  // receiving location). Nothing here writes a default; it only pre-selects one.
  const receiveLocations = locations.filter((location) => location.kind !== 'QUARANTINE');
  const defaultLocationId = defaultReceivingLocationId(
    scope.branch.defaultStockLocationId,
    locations
  );
  const packPhotoEnabled = configuredPackLabelOcrAdapterName() !== null;
  // PUR-02 receives against an order that has left the building; a draft or
  // unapproved order has nothing to deliver.
  const receivable = orders.filter(
    (order) => order.status === 'SENT' || order.status === 'RECEIVING'
  );
  const selectedOrder = receivable.find((order) => order.id === param(query, 'order')) ?? null;
  const selectedReceipt =
    receipts.find((receipt) => receipt.id === param(query, 'receipt')) ?? null;

  let outstanding: Record<
    string,
    { receivedUnits: number; acceptedUnits: number; rejectedUnits: number }
  > = {};
  if (selectedOrder) {
    outstanding = await caller.receivedAgainstOrder({ purchaseOrderId: selectedOrder.id });
  }

  /** The scan box resolves against the register, not against a guess. */
  const scanTerm = param(query, 'scan');
  let scan: ScanResolution | null = null;
  if (scanTerm) scan = await caller.resolveScan({ term: scanTerm });

  let lots: Awaited<ReturnType<typeof caller.lotsFromReceipt>> = [];
  if (selectedReceipt && selectedReceipt.status === 'POSTED') {
    lots = await caller.lotsFromReceipt({ branchId, goodsReceiptId: selectedReceipt.id });
  }
  const needsWitness = Boolean(
    selectedReceipt &&
    (selectedReceipt.status === 'POSTED'
      ? selectedReceipt.reversalRequiresWitness
      : selectedReceipt.status === 'DRAFT' &&
        (selectedReceipt.qualifiedPersonUserId ||
          selectedReceipt.lines.some((line) => line.medicine.controlled)))
  );
  let witnessLoadFailed = false;
  const witnesses =
    needsWitness && selectedReceipt
      ? await (
          selectedReceipt.status === 'POSTED'
            ? // Reversal needs a fresh independent witness, not the original qualified person.
              caller.controlledReversalWitnesses({ branchId, goodsReceiptId: selectedReceipt.id })
            : caller.controlledWitnesses({ branchId, goodsReceiptId: selectedReceipt.id })
        ).catch(() => {
          witnessLoadFailed = true;
          return [];
        })
      : [];

  // ── actions ───────────────────────────────────────────────────────────────

  async function receiveAgainstOrder(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const purchaseOrderId = field(form, 'purchaseOrderId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const order = (await actionCaller.purchaseOrders()).find((row) => row.id === purchaseOrderId);
      if (!order)
        throw new PurchasingValidationError('That order no longer exists. Reload the page.');

      const lines = order.lines.flatMap((line) =>
        // DEV-752: one ordered line may arrive as several lots. Each different
        // batch or expiry is its own receipt line against the same order line.
        [1, ...EXTRA_LOT_SLOTS].flatMap((slot) => {
          const key = lotSlotKey(line.id, slot);
          // A lot with no batch number was not delivered on this consignment.
          // It stays outstanding rather than being filed as a zero receipt.
          if (!field(form, `batchNumber:${key}`)) return [];
          return [
            {
              ...readCaptureFields(form, key),
              purchaseOrderLineId: line.id,
              medicineId: line.medicineId,
              packLevelId: line.packLevelId,
              canonicalUnitsPerPack: line.canonicalUnitsPerPack,
            },
          ];
        })
      );
      if (findRepeatedLot(lines)) {
        throw Object.assign(
          new PurchasingValidationError(
            'The same batch and expiry is entered twice on one order line. Enter the total packs once; a separate lot is only for a different batch or expiry.'
          ),
          { field: 'batchNumber' }
        );
      }
      if (lines.length === 0) {
        throw Object.assign(
          new PurchasingValidationError(
            'Enter a batch number on at least one line — that is what marks it as arrived.'
          ),
          { field: 'batchNumber' }
        );
      }
      const receipt = await outcome.write(actionCaller.createGoodsReceipt)({
        branchId: branch,
        reference: field(form, 'reference'),
        supplierId: order.supplierId,
        purchaseOrderId: order.id,
        supplierInvoiceRef: field(form, 'supplierInvoiceRef'),
        supplierInvoiceDate: dateField(form, 'supplierInvoiceDate', 'Invoice date'),
        distributorNtn: optionalField(form, 'distributorNtn'),
        distributorStrn: optionalField(form, 'distributorStrn'),
        warrantyEvidenceRef: field(form, 'warrantyEvidenceRef'),
        receivedAt: dateField(form, 'receivedAt', 'Received on'),
        note: optionalField(form, 'note'),
        qualifiedPersonUserId: optionalField(form, 'qualifiedPersonUserId'),
        lines,
      });
      if ('blocked' in receipt)
        throw Object.assign(new PurchasingValidationError(receipt.blocked), {
          field: 'bypassApprovalPin',
        });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: `Receipt ${receipt.reference} drafted. Nothing is in stock until you post it.`,
          kind: 'success',
        },
        { branch, receipt: receipt.id, order: order.id }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not draft the receipt.'), kind: 'error' },
        { branch, order: purchaseOrderId }
      );
    }
    return next;
  }

  async function receiveDirect(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const lines = DIRECT_SLOTS.flatMap((slot) => {
        const pack = readPack(field(form, `directPack-${slot}`));
        if (!pack) return [];
        return [
          {
            ...readCaptureFields(form, `d${slot}`),
            medicineId: pack.medicineId,
            packLevelId: pack.packLevelId,
            canonicalUnitsPerPack: pack.canonicalUnitsPerPack,
          },
        ];
      });
      if (lines.length === 0) {
        throw Object.assign(
          new PurchasingValidationError('Choose a medicine and pack for at least one line.'),
          {
            field: 'directPack-0',
          }
        );
      }
      const receipt = await outcome.write(actionCaller.createGoodsReceipt)({
        branchId: branch,
        reference: field(form, 'directReference'),
        supplierId: field(form, 'supplierId'),
        supplierInvoiceRef: field(form, 'directInvoiceRef'),
        supplierInvoiceDate: dateField(form, 'directInvoiceDate', 'Invoice date'),
        distributorNtn: optionalField(form, 'directDistributorNtn'),
        distributorStrn: optionalField(form, 'directDistributorStrn'),
        warrantyEvidenceRef: field(form, 'directWarranty'),
        receivedAt: dateField(form, 'directReceivedAt', 'Received on'),
        directPurchase: {
          reason: field(form, 'bypassReason'),
          approvedByUserId: field(form, 'bypassApprovedByUserId'),
          pin: field(form, 'bypassApprovalPin'),
        },
        note: optionalField(form, 'directNote'),
        qualifiedPersonUserId: optionalField(form, 'directQualifiedPersonUserId'),
        lines,
      });
      if ('blocked' in receipt)
        throw Object.assign(new PurchasingValidationError(receipt.blocked), {
          field: 'bypassApprovalPin',
        });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: `Direct purchase ${receipt.reference} drafted with a recorded bypass. Post it to move the stock.`,
          kind: 'success',
        },
        { branch, receipt: receipt.id }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not draft the direct purchase.'), kind: 'error' },
        { branch }
      );
    }
    return next;
  }

  async function postReceipt(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const goodsReceiptId = field(form, 'goodsReceiptId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const result = await outcome.write(actionCaller.postGoodsReceipt)({
        branchId: branch,
        goodsReceiptId,
        staffProfileId: optionalField(form, 'witnessStaffProfileId'),
        pin: optionalField(form, 'witnessPin'),
        approvalPin: optionalField(form, 'receiptApprovalPin'),
      });
      if (result && 'blocked' in result) {
        next = destination(
          ROUTE,
          {
            message: result.blocked,
            kind: 'error',
            outcome: 'rejected',
            field: result.blocked === APPROVAL_BLOCKED ? 'receiptApprovalPin' : 'witnessPin',
          },
          { branch, receipt: goodsReceiptId }
        );
        return next;
      }
      revalidatePath(ROUTE);
      const raised = result.exceptions?.length ?? 0;
      next = destination(
        ROUTE,
        {
          message:
            raised === 0
              ? 'Receipt posted. The accepted units are in stock and saleable.'
              : `Receipt posted with ${raised} match exception${raised === 1 ? '' : 's'}. They stay open until somebody resolves them.`,
          kind: 'success',
        },
        { branch, receipt: goodsReceiptId }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not post the receipt.'), kind: 'error' },
        { branch, receipt: goodsReceiptId }
      );
    }
    return next;
  }

  async function reverseReceipt(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const goodsReceiptId = field(form, 'goodsReceiptId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.reverseGoodsReceipt)({
        branchId: branch,
        goodsReceiptId,
        reason: field(form, 'reversalReason'),
        controlledWitness: optionalField(form, 'witnessStaffProfileId')
          ? {
              staffProfileId: field(form, 'witnessStaffProfileId'),
              pin: field(form, 'witnessPin'),
            }
          : undefined,
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message:
            'Receipt reversed with linked compensating movements. Nothing posted was edited or deleted.',
          kind: 'success',
        },
        { branch, receipt: goodsReceiptId }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not reverse the receipt.'), kind: 'error' },
        { branch, receipt: goodsReceiptId }
      );
    }
    return next;
  }

  async function resolveException(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const receivingExceptionId = field(form, 'receivingExceptionId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.resolveReceivingException)({
        branchId: branch,
        receivingExceptionId,
        resolutionNote: field(form, 'resolutionNote'),
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: 'Exception resolved. The quantities it recorded are unchanged.',
          kind: 'success',
        },
        { branch, receipt: optionalField(form, 'goodsReceiptId') }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not resolve the exception.'), kind: 'error' },
        { branch, receipt: optionalField(form, 'goodsReceiptId') }
      );
    }
    return next;
  }

  const openExceptionCount = exceptionStatus === 'OPEN' ? exceptions.length : null;
  const inputTaxReport = reconcileInputTaxBills(receipts);

  return (
    <Frame branch={scope} notice={notice}>
      <form action={ROUTE} className="flex flex-wrap items-end gap-3" method="get">
        <input name="branch" type="hidden" value={branchId} />
        {selectedOrder ? <input name="order" type="hidden" value={selectedOrder.id} /> : null}
        {selectedReceipt ? <input name="receipt" type="hidden" value={selectedReceipt.id} /> : null}
        <label className="min-w-56 flex-1 text-sm font-medium text-text-body" htmlFor="scan">
          Scan or search
          <input
            autoComplete="off"
            autoFocus
            className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
            defaultValue={scanTerm ?? ''}
            id="scan"
            name="scan"
            placeholder="Scan a 2D or linear code, or type a product name"
          />
        </label>
        <SubmitButton variant="secondary">Find line</SubmitButton>
      </form>
      {scan ? <ScanNotice scan={scan} onThisOrder={scanOnOrder(scan, selectedOrder)} /> : null}

      <div className="grid gap-6 sm:grid-cols-4">
        <Stat
          label="Open exceptions"
          value={openExceptionCount ?? '—'}
          sub="Visible until resolved"
        />
        <Stat label="Orders to receive" value={receivable.length} sub="Sent or part-received" />
        <Stat
          label="Draft receipts"
          value={receipts.filter((receipt) => receipt.status === 'DRAFT').length}
          sub="Filed, not yet in stock"
        />
        <Stat label="Receiving locations" value={locations.length} sub={scope.branch.name} />
      </div>

      {/* ── PUR-04 review queue ────────────────────────────────────────────── */}
      <SectionCard
        eyebrow="PUR-04"
        title={`Match exceptions — ${exceptionStatus === 'OPEN' ? 'open' : 'resolved'} (${exceptions.length})`}
        titleLevel={2}
        actions={
          <a
            className="min-h-11 rounded-[var(--radius-sm)] px-3 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
            href={linkTo(query, branchId, {
              exceptions: exceptionStatus === 'OPEN' ? 'resolved' : 'open',
            })}
          >
            {exceptionStatus === 'OPEN' ? 'Show resolved' : 'Show open'}
          </a>
        }
      >
        {exceptions.length === 0 ? (
          <EmptyState
            title={
              exceptionStatus === 'OPEN'
                ? 'No open exceptions at this branch'
                : 'Nothing has been resolved yet'
            }
            detail={
              exceptionStatus === 'OPEN'
                ? 'A shortage, overage, damage, price conflict or pack conflict is raised when a receipt posts, and stays here until somebody records who closed it and why.'
                : 'Resolved exceptions are kept with the note that closed them. None have been closed at this branch.'
            }
          />
        ) : (
          <ul className="space-y-3">
            {exceptions.map((exception) => (
              <li
                className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning/5 p-4"
                key={exception.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-strong">
                    {exception.goodsReceiptLine.medicine.productName} · batch{' '}
                    {exception.goodsReceiptLine.batchNumber}
                  </span>
                  <StatusPill
                    status={exception.kind}
                    tone={exception.status === 'RESOLVED' ? 'success' : 'warning'}
                  />
                </div>
                <p className="mt-1 text-sm text-text-body">{exception.detail}</p>
                <p className="mt-1 text-xs text-text-muted">
                  {exception.goodsReceipt.reference} · {exception.goodsReceipt.supplier.name} ·
                  raised {dateTime(exception.raisedAt)}
                  {exception.expectedUnits != null
                    ? ` · expected ${exception.expectedUnits} units, observed ${exception.observedUnits ?? 0}`
                    : ''}
                  {exception.expectedMinor != null
                    ? ` · expected ${money(exception.expectedMinor)}, invoiced ${money(exception.observedMinor)}`
                    : ''}
                </p>
                {exception.status === 'RESOLVED' ? (
                  <p className="mt-2 text-xs text-text-muted">
                    Resolved {dateTime(exception.resolvedAt)} · {exception.resolutionNote}
                  </p>
                ) : (
                  <PurchasingActionForm
                    operation={{
                      resource: `receipt:${exception.goodsReceiptId}`,
                      action: `resolve-exception:${exception.id}`,
                    }}
                    action={resolveException}
                    className="mt-3 flex flex-wrap items-end gap-3"
                  >
                    <input name="branchId" type="hidden" value={branchId} />
                    <input name="receivingExceptionId" type="hidden" value={exception.id} />
                    <input name="goodsReceiptId" type="hidden" value={exception.goodsReceiptId} />
                    <TextField
                      className="min-w-64 flex-1"
                      label="How was this settled?"
                      name="resolutionNote"
                      notice={notice}
                      required
                      hint="Recorded with your name. The recorded quantities never change."
                    />
                    <SubmitButton>Resolve</SubmitButton>
                  </PurchasingActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard eyebrow="Input-tax hygiene" title="Purchase bill reconciliation" titleLevel={2}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Bills needing tax identity" value={inputTaxReport.flaggedBillCount} />
          <Stat label="Posted input tax" value={money(inputTaxReport.claimedInputTaxMinor)} />
          <Stat label="Claim on flagged bills" value={money(inputTaxReport.flaggedClaimMinor)} />
        </div>
        <p className="mt-3 text-sm text-text-muted">
          Input tax is calculated from posted, creditable invoice lines. Confirm the claim with your
          tax adviser; this report is a reconciliation aid, not a tax filing.
        </p>
        {inputTaxReport.rows.some((row) => row.flagged) ? (
          <ul className="mt-3 divide-y divide-border-subtle rounded-[var(--radius-sm)] border border-warning/40">
            {inputTaxReport.rows
              .filter((row) => row.flagged)
              .map((row) => (
                <li className="flex flex-wrap items-center justify-between gap-2 p-3" key={row.id}>
                  <span className="min-w-0 break-words">
                    <span className="block text-sm font-medium text-text-strong">
                      {row.supplierName}
                    </span>
                    <span className="block text-xs text-text-muted">
                      {row.reference} · invoice {row.supplierInvoiceRef}
                    </span>
                  </span>
                  <span className="text-sm font-medium text-warning">
                    Missing {row.missing.join(' and ')} · claim {money(row.claimMinor)}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-text-muted">
            No bills with a positive input-tax claim are missing NTN or STRN.
          </p>
        )}
      </SectionCard>

      {/* ── PUR-02 capture against a purchase order ────────────────────────── */}
      <SectionCard eyebrow="PUR-02" title="Receive against a purchase order" titleLevel={2}>
        {receivable.length === 0 ? (
          <EmptyState
            title="No order is out with a supplier"
            detail="A receipt is filed against an order that has been sent. Approve and send an order, or use the direct purchase path below for a cash-and-carry invoice."
            steps={[{ label: 'Open requisitions & orders', href: `${PURCHASING_ROUTE}/orders` }]}
          />
        ) : (
          <>
            <form action={ROUTE} className="flex flex-wrap items-end gap-3" method="get">
              <input name="branch" type="hidden" value={branchId} />
              {scanTerm ? <input name="scan" type="hidden" value={scanTerm} /> : null}
              <label className="min-w-56 text-sm font-medium text-text-body" htmlFor="order-pick">
                Purchase order
                <select
                  className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                  defaultValue={selectedOrder?.id ?? ''}
                  id="order-pick"
                  name="order"
                >
                  <option value="">Choose an order…</option>
                  {receivable.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.reference} — {order.supplier.name} ({order.lines.length} lines)
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton variant="secondary">Open order</SubmitButton>
            </form>

            {selectedOrder ? (
              <PurchasingActionForm
                operation={{ resource: `order:${selectedOrder.id}`, action: `receive:${branchId}` }}
                action={receiveAgainstOrder}
                className="mt-5 space-y-4"
              >
                <input name="branchId" type="hidden" value={branchId} />
                <input name="purchaseOrderId" type="hidden" value={selectedOrder.id} />
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <TextField label="Receipt reference" name="reference" notice={notice} required />
                  <TextField
                    label="Supplier invoice number"
                    name="supplierInvoiceRef"
                    notice={notice}
                    required
                    hint="Required: stock is not saleable without its source invoice."
                  />
                  <TextField
                    defaultValue={today()}
                    label="Invoice date"
                    name="supplierInvoiceDate"
                    notice={notice}
                    required
                    type="date"
                  />
                  <TextField
                    defaultValue={today()}
                    label="Received on"
                    name="receivedAt"
                    notice={notice}
                    required
                    type="date"
                  />
                  <TextField
                    label="Distributor NTN"
                    name="distributorNtn"
                    notice={notice}
                    hint="As printed on this purchase bill. Missing values are flagged in reconciliation."
                  />
                  <TextField
                    label="Distributor STRN"
                    name="distributorStrn"
                    notice={notice}
                    hint="As printed on this purchase bill. Missing values are flagged in reconciliation."
                  />
                  <TextField
                    className="lg:col-span-2"
                    label="Warranty / source evidence"
                    name="warrantyEvidenceRef"
                    notice={notice}
                    required
                    hint="Where the warranty or source declaration for this consignment is filed."
                  />
                </div>

                <div className="space-y-3">
                  {selectedOrder.lines.map((line) => {
                    const already = outstanding[line.id];
                    const orderedUnits = line.orderedCanonicalUnits + line.bonusCanonicalUnits;
                    const remaining = Math.max(0, orderedUnits - (already?.receivedUnits ?? 0));
                    const prefillId =
                      scan?.kind === 'gs1' && scan.medicineId
                        ? selectedOrder.lines.find((row) => row.medicineId === scan.medicineId)?.id
                        : undefined;
                    const outstandingPacks =
                      line.canonicalUnitsPerPack > 0
                        ? Math.floor(remaining / line.canonicalUnitsPerPack)
                        : null;
                    const reader = (key: string, lotLabel: string) =>
                      packPhotoEnabled ? (
                        <PackPhotoReader
                          branchId={branchId}
                          defaultLocationId={defaultLocationId ?? null}
                          fieldKey={key}
                          locations={receiveLocations.map((location) => ({
                            id: location.id,
                            label: `${location.name} (${location.kind}${location.coldChain ? ', cold chain' : ''})`,
                          }))}
                          lotLabel={lotLabel}
                          medicineName={line.medicine.productName}
                          outstandingPacks={outstandingPacks}
                          packLevel={line.packLevel.level}
                          purchaseOrderId={selectedOrder.id}
                          purchaseOrderLineId={line.id}
                          siblingFieldKeys={[1, ...EXTRA_LOT_SLOTS]
                            .map((slot) => lotSlotKey(line.id, slot))
                            .filter((sibling) => sibling !== key)}
                          unitsPerPack={line.canonicalUnitsPerPack}
                        />
                      ) : null;
                    const prefill = prefillId === line.id ? gs1Prefill(scan, scanTerm) : undefined;
                    return (
                      <div className="space-y-3" key={line.id}>
                        <CaptureFieldset
                          defaultLocationId={defaultLocationId}
                          photoReader={
                            // A scanned 2D code is the evidence for lot 1; a photo cannot replace it.
                            prefill?.payload ? undefined : reader(line.id, 'Lot 1')
                          }
                          highlighted={
                            scan?.kind !== 'unresolved' &&
                            scan?.kind !== 'manual' &&
                            scan?.medicineId === line.medicineId
                          }
                          prefill={prefill}
                          keyPrefix={line.id}
                          locations={locations}
                          notice={notice}
                          subtitle={`Ordered ${line.orderedPacks} ${line.packLevel.level}${
                            line.bonusPacks > 0 ? ` + ${line.bonusPacks} free` : ''
                          } · ${units(orderedUnits)} · already received ${units(already?.receivedUnits ?? 0)} · outstanding ${units(remaining)}`}
                          suggestedPacks={receivedPacksForScan(
                            prefillId === line.id && scan?.kind === 'gs1' ? scan.serial : null,
                            line.canonicalUnitsPerPack > 0
                              ? Math.floor(remaining / line.canonicalUnitsPerPack)
                              : 0
                          )}
                          suggestedPriceMinor={line.listPricePerPackMinor}
                          title={line.medicine.productName}
                          unitsPerPack={line.canonicalUnitsPerPack}
                        />
                        <details className="rounded-[var(--radius-sm)] border border-border-subtle px-4 py-2">
                          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-text-body focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2">
                            Another batch or expiry of {line.medicine.productName} arrived
                          </summary>
                          <p className="text-xs text-text-muted">
                            Each different batch or expiry is its own lot. The same batch and expiry
                            is one lot: enter its total packs once. Leave a lot&apos;s batch blank
                            if it did not arrive.
                          </p>
                          <div className="mt-3 space-y-3 pb-2">
                            {EXTRA_LOT_SLOTS.map((slot) => (
                              <CaptureFieldset
                                defaultLocationId={defaultLocationId}
                                key={slot}
                                keyPrefix={lotSlotKey(line.id, slot)}
                                locations={locations}
                                notice={notice}
                                photoReader={reader(lotSlotKey(line.id, slot), `Lot ${slot}`)}
                                subtitle={`A separate batch or expiry against the same order line · outstanding ${units(remaining)}`}
                                suggestedPriceMinor={line.listPricePerPackMinor}
                                title={`${line.medicine.productName} — lot ${slot}`}
                                unitsPerPack={line.canonicalUnitsPerPack}
                              />
                            ))}
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>

                <SelectField
                  emptyHint="No other active user can sign a controlled-medicine purchase."
                  hint="Required only when a line is a controlled medicine. They must be allowed to dispense, and they cannot be you. Their PIN is entered when the receipt is posted."
                  label="Qualified person"
                  name="qualifiedPersonUserId"
                  notice={notice}
                  options={workspace.approvers.map((approver) => ({
                    value: approver.id,
                    label: approver.name ? `${approver.name} (${approver.email})` : approver.email,
                  }))}
                  placeholder="Not a controlled medicine"
                />
                <TextAreaField label="Receipt note" name="note" notice={notice} />
                <SubmitButton>File receipt (draft)</SubmitButton>
                <p className="text-sm text-text-muted">
                  A draft receipt is a document. Nothing reaches the ledger, and nothing becomes
                  saleable, until it is posted.
                </p>
              </PurchasingActionForm>
            ) : (
              <p className="mt-4 text-sm text-text-muted">
                Choose an order above to open its lines for capture. Nothing is loaded until you do.
              </p>
            )}
          </>
        )}
      </SectionCard>

      {/* ── PUR-05 direct purchase ─────────────────────────────────────────── */}
      <SectionCard eyebrow="PUR-05" title="Direct purchase — no purchase order" titleLevel={2}>
        <p className="text-sm text-text-muted">
          A phone, WhatsApp or cash-and-carry invoice. Every validation and every posting is the
          same as receiving against an order — the only difference is that a bypass reason and a
          named approver stand in place of the order.
        </p>
        {procurementApprovers.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="No authorized approver is available"
              detail="A direct purchase needs a procurement approver with an active PIN. A sole active owner may reauthenticate with their own PIN; other teams need a second approver. Configure staff access and a PIN before continuing."
              steps={[
                { label: 'Invite a colleague', href: '/team' },
                { label: 'Raise a purchase order', href: `${PURCHASING_ROUTE}/orders` },
              ]}
            />
          </div>
        ) : (
          <PurchasingActionForm
            operation={{ resource: `direct-receipt:${branchId}`, action: 'create' }}
            action={receiveDirect}
            className="mt-4 space-y-4"
          >
            <input name="branchId" type="hidden" value={branchId} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <TextField
                label="Direct purchase reference"
                name="directReference"
                notice={notice}
                required
              />
              <SelectField
                emptyHint={
                  checksOff
                    ? 'No supplier yet. Add one in the supplier register first.'
                    : 'No orderable supplier. Authorize one and file a verified licence first.'
                }
                label="Supplier"
                name="supplierId"
                notice={notice}
                options={supplierOptions(workspace.suppliers)}
                required
              />
              <TextField
                label="Direct purchase invoice number"
                name="directInvoiceRef"
                notice={notice}
                required
              />
              <TextField
                defaultValue={today()}
                label="Direct purchase invoice date"
                name="directInvoiceDate"
                notice={notice}
                required
                type="date"
              />
              <TextField
                defaultValue={today()}
                label="Direct purchase received on"
                name="directReceivedAt"
                notice={notice}
                required
                type="date"
              />
              <TextField
                label="Direct purchase warranty evidence"
                name="directWarranty"
                notice={notice}
                required
              />
              <TextField
                label="Distributor NTN"
                name="directDistributorNtn"
                notice={notice}
                hint="As printed on this purchase bill."
              />
              <TextField
                label="Distributor STRN"
                name="directDistributorStrn"
                notice={notice}
                hint="As printed on this purchase bill."
              />
              <TextAreaField
                className="sm:col-span-2"
                label="Why was there no purchase order?"
                name="bypassReason"
                notice={notice}
                required
                hint="Recorded permanently with the receipt."
              />
              <SelectField
                emptyHint="No authorized procurement approver is available."
                hint="A second approver is required unless you are the sole active owner at this branch. The approver must enter their PIN."
                label="Approved by"
                name="bypassApprovedByUserId"
                notice={notice}
                options={procurementApprovers.map((approver) => ({
                  value: approver.id,
                  label: approver.name ? `${approver.name} (${approver.email})` : approver.email,
                }))}
                required
              />
              <TextField
                label="Approver PIN"
                name="bypassApprovalPin"
                notice={notice}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                required
              />
            </div>
            <ProgressiveLines
              lines={DIRECT_SLOTS.map((slot) => ({
                selected: slot === 0 && !!directPackValue(scan, workspace.medicines),
                selector: (
                  <SelectField
                    defaultValue={
                      slot === 0 ? directPackValue(scan, workspace.medicines) : undefined
                    }
                    emptyHint="No medicine has an effective pack level."
                    label={`Line ${slot + 1} — medicine and pack`}
                    name={`directPack-${slot}`}
                    notice={notice}
                    options={packOptions(workspace.medicines)}
                    placeholder="Skip this line"
                  />
                ),
                fields: (
                  <CaptureFieldset
                    keyPrefix={`d${slot}`}
                    locations={locations}
                    notice={notice}
                    prefill={slot === 0 ? gs1Prefill(scan, scanTerm) : undefined}
                    suggestedPacks={
                      slot === 0 && scan?.kind === 'gs1' && scan.serial
                        ? receivedPacksForScan(scan.serial, 0)
                        : undefined
                    }
                    subtitle="Fill this only if you chose a medicine above. A pack with no 2D code is entered by hand."
                    title={`Line ${slot + 1} capture`}
                    unitsPerPack={null}
                  />
                ),
              }))}
            />
            <SelectField
              emptyHint="No other active user can sign a controlled-medicine purchase."
              hint="Required only when a line is a controlled medicine. They must be allowed to dispense, and they cannot be you. Their PIN is entered when the receipt is posted."
              label="Qualified person"
              name="directQualifiedPersonUserId"
              notice={notice}
              options={workspace.approvers.map((approver) => ({
                value: approver.id,
                label: approver.name ? `${approver.name} (${approver.email})` : approver.email,
              }))}
              placeholder="Not a controlled medicine"
            />
            <TextAreaField label="Direct purchase note" name="directNote" notice={notice} />
            <SubmitButton>File direct purchase (draft)</SubmitButton>
          </PurchasingActionForm>
        )}
      </SectionCard>

      {/* ── receipts, side by side with the selected one ───────────────────── */}
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,11fr)] xl:items-start">
        <SectionCard eyebrow="PUR-02/04" title={`Receipts (${receipts.length})`} titleLevel={2}>
          {receipts.length === 0 ? (
            <EmptyState
              title="Nothing has been received at this branch"
              detail="File a receipt against a sent order, or record a direct purchase. Both appear here with their posting state."
            />
          ) : (
            <ul className="space-y-2">
              {receipts.map((receipt) => (
                <li key={receipt.id}>
                  <a
                    aria-current={receipt.id === selectedReceipt?.id ? 'true' : undefined}
                    className={`flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 ${
                      receipt.id === selectedReceipt?.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border-subtle hover:bg-muted'
                    }`}
                    href={linkTo(query, branchId, { receipt: receipt.id })}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-text-strong">
                        {receipt.reference}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {receipt.supplier.name} · {dateOnly(receipt.receivedAt)}
                        {receipt.directPurchase ? ' · direct purchase' : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {receipt.exceptions.some((row) => row.status === 'OPEN') ? (
                        <StatusPill status="Exceptions" tone="warning" />
                      ) : null}
                      <StatusPill status={receipt.status} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {selectedReceipt ? (
          <ReceiptDetail
            branchId={branchId}
            lots={lots}
            notice={notice}
            onPost={postReceipt}
            onReverse={reverseReceipt}
            receipt={selectedReceipt}
            witnesses={witnesses}
            witnessLoadFailed={witnessLoadFailed}
          />
        ) : (
          <SectionCard title="No receipt selected" titleLevel={2}>
            <EmptyState
              title="Pick a receipt to post or inspect it"
              detail="Its captured lines, the exceptions it raised and the batch lots it produced open here, beside the list."
            />
          </SectionCard>
        )}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------

function Frame({
  branch,
  notice,
  children,
}: {
  branch?: ReturnType<typeof resolveBranch>;
  notice: Notice | null;
  children: React.ReactNode;
}) {
  return (
    <PurchasingOutcomeScope>
      <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
      <PurchasingTabs active={ROUTE} />
      {branch?.kind === 'resolved' ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="text-sm text-text-muted">
            Receiving into{' '}
            <span className="font-medium text-text-strong">{branch.branch.name}</span>
            {branch.implicit ? ' — the only active branch in this workspace.' : '.'}
          </p>
          <BranchPicker branches={branch.branches} route={ROUTE} selected={branch.branch.id} />
        </div>
      ) : null}
      <NoticeBanner notice={notice} />
      <PurchasingOutcomes />
      {children}
    </PurchasingOutcomeScope>
  );
}

/**
 * One line of capture. Every field the PH-INV lot needs is here, because the lot
 * is built from this row: a batch, an expiry with its printed precision, the
 * printed MRP, the pack conversion, the quantity, the bonus and the invoiced
 * cost. The pack → unit conversion and the resulting unit cost are read back
 * beside the inputs, so what is about to be committed is legible before it is.
 */
function CaptureFieldset({
  keyPrefix,
  title,
  subtitle,
  locations,
  notice,
  unitsPerPack,
  suggestedPacks,
  suggestedPriceMinor,
  highlighted,
  prefill,
  photoReader,
  defaultLocationId,
}: {
  keyPrefix: string;
  title: string;
  subtitle: string;
  locations: StockLocationOption[];
  notice: Notice | null;
  unitsPerPack: number | null;
  suggestedPacks?: number;
  suggestedPriceMinor?: number;
  highlighted?: boolean;
  prefill?: Gs1Prefill;
  /** DEV-752: the pack-photo shortcut that fills this line's lot fields. */
  photoReader?: React.ReactNode;
  defaultLocationId?: string;
}) {
  const stock = locations.filter((location) => location.kind !== 'QUARANTINE');
  const quarantine = locations.filter((location) => location.kind === 'QUARANTINE');
  return (
    <fieldset
      className={`min-w-0 rounded-[var(--radius-sm)] border p-4 ${
        highlighted ? 'border-primary bg-primary/5' : 'border-border-subtle'
      }`}
    >
      <legend className="px-1 text-sm font-medium text-text-strong">{title}</legend>
      <p className="text-xs text-text-muted">{subtitle}</p>
      {prefill?.warnings.length ? (
        <p className="mt-1 text-xs text-text-muted">{prefill.warnings.join(' ')}</p>
      ) : null}
      {unitsPerPack ? (
        <Derived label="Pack conversion" value={packConversionLabel('pack', [], unitsPerPack)} />
      ) : null}
      {photoReader}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          defaultValue={prefill?.batchNumber}
          label="Batch number"
          name={`batchNumber:${keyPrefix}`}
          notice={notice}
          hint="Leave blank if this line did not arrive. A 2D scan fills this in."
        />
        <TextField
          defaultValue={prefill?.printedExpiry}
          label="Printed expiry"
          name={`printedExpiry:${keyPrefix}`}
          notice={notice}
          type="date"
          hint={
            prefill?.printedExpiry
              ? 'Filled from the scan. Confirm it against the supplier invoice.'
              : undefined
          }
        />
        <TextField
          defaultValue={prefill?.serialNumber}
          label="Serial"
          name={`serialNumber:${keyPrefix}`}
          notice={notice}
          hint="From the 2D code. Leave blank on an older pack with no serial."
        />
        {prefill?.gtin ? (
          <input name={`gtin:${keyPrefix}`} type="hidden" value={prefill.gtin} />
        ) : null}
        {prefill?.payload ? (
          <input name={`gs1Payload:${keyPrefix}`} type="hidden" value={prefill.payload} />
        ) : null}
        {prefill?.warningCodes.length ? (
          <input
            name={`gs1Warnings:${keyPrefix}`}
            type="hidden"
            value={prefill.warningCodes.join('\n')}
          />
        ) : null}
        <SelectField
          defaultValue={prefill?.expiryPrecision ?? 'MONTH'}
          emptyHint="—"
          hint="Most cartons print a month only. Day 00 on a 2D code is the end of the month."
          label="Expiry precision"
          name={`expiryPrecision:${keyPrefix}`}
          notice={notice}
          options={[
            { value: 'MONTH', label: 'Month printed (e.g. 06/2027)' },
            { value: 'DAY', label: 'Exact day printed' },
          ]}
        />
        <TextField
          inputMode="decimal"
          label="Printed MRP (PKR)"
          name={`printedMrp:${keyPrefix}`}
          notice={notice}
          hint="Per pack, as printed on the carton."
        />
        <TextField
          defaultValue={suggestedPacks && suggestedPacks > 0 ? suggestedPacks : undefined}
          inputMode="numeric"
          label="Packs received"
          min={0}
          name={`receivedPacks:${keyPrefix}`}
          notice={notice}
          type="number"
          hint={
            prefill?.serialNumber
              ? 'One serialized pack counts as one unit.'
              : suggestedPacks
                ? 'Pre-filled with the outstanding balance.'
                : undefined
          }
        />
        {prefill ? (
          <label className="flex min-h-11 items-center gap-2 text-sm text-text-body sm:col-span-2">
            <input name={`invoiceCorrection:${keyPrefix}`} type="checkbox" value="yes" />
            Invoice corrects the printed batch or expiry
          </label>
        ) : null}
        <TextField
          inputMode="numeric"
          label="Free / bonus packs"
          min={0}
          name={`bonusPacks:${keyPrefix}`}
          notice={notice}
          type="number"
          hint="Lowers the unit cost; never revenue."
        />
        <TextField
          defaultValue={
            suggestedPriceMinor != null ? (suggestedPriceMinor / 100).toFixed(2) : undefined
          }
          inputMode="decimal"
          label="Invoiced price / pack (PKR)"
          name={`invoicedPrice:${keyPrefix}`}
          notice={notice}
          hint={suggestedPriceMinor != null ? 'Pre-filled from the order.' : undefined}
        />
        <TextField
          inputMode="decimal"
          label="Discount %"
          name={`discount:${keyPrefix}`}
          notice={notice}
        />
        <TextField inputMode="decimal" label="Tax %" name={`tax:${keyPrefix}`} notice={notice} />
        <SelectField
          defaultValue="no"
          emptyHint="—"
          hint="A creditable input tax is recovered, so it is not stock cost."
          label="Tax creditable"
          name={`taxCreditable:${keyPrefix}`}
          notice={notice}
          options={[
            { value: 'no', label: 'No — tax is part of the cost' },
            { value: 'yes', label: 'Yes — input tax is recoverable' },
          ]}
        />
        <SelectField
          defaultValue={defaultLocationId}
          emptyHint="This branch has no active stock location. Create one before receiving."
          hint={
            defaultLocationId
              ? "Starts on this branch's receiving location. A change applies to this line only."
              : undefined
          }
          label="Receive into"
          name={`stockLocation:${keyPrefix}`}
          notice={notice}
          options={stock.map((location) => ({
            value: location.id,
            label: `${location.name} (${location.kind}${location.coldChain ? ', cold chain' : ''})`,
          }))}
        />
        <TextField
          inputMode="numeric"
          label="Rejected units"
          min={0}
          name={`rejectedUnits:${keyPrefix}`}
          notice={notice}
          type="number"
          hint="Damaged or short-dated. Never enters available stock."
        />
        <SelectField
          className="lg:col-span-2"
          emptyHint="No quarantine location at this branch. Create one before rejecting goods."
          label="Quarantine into (only if rejecting)"
          name={`quarantineLocation:${keyPrefix}`}
          notice={notice}
          options={quarantine.map((location) => ({
            value: location.id,
            label: location.name,
          }))}
          placeholder="Not rejecting anything"
        />
        <TextField
          className="lg:col-span-2"
          label="Rejection reason (only if rejecting)"
          name={`rejectionReason:${keyPrefix}`}
          notice={notice}
        />
      </div>
    </fieldset>
  );
}

function ReceiptDetail({
  receipt,
  lots,
  branchId,
  notice,
  onPost,
  onReverse,
  witnesses,
  witnessLoadFailed,
}: {
  receipt: GoodsReceiptDetail;
  lots: {
    lineNumber: number;
    batchNumber: string;
    medicine: { productName: string };
    inventoryLot: unknown;
  }[];
  branchId: string;
  notice: Notice | null;
  onPost: (form: FormData) => Promise<string>;
  onReverse: (form: FormData) => Promise<string>;
  witnesses: ReadonlyArray<{ id: string; name: string; self?: boolean }>;
  witnessLoadFailed: boolean;
}) {
  return (
    <SectionCard
      eyebrow="PUR-02/04/05"
      title={receipt.reference}
      titleLevel={2}
      actions={<StatusPill status={receipt.status} />}
    >
      <p className="text-sm text-text-muted">
        {receipt.supplier.name} · invoice {receipt.supplierInvoiceRef} (
        {dateOnly(receipt.supplierInvoiceDate)}) · received {dateOnly(receipt.receivedAt)}
        {receipt.purchaseOrder ? ` · against ${receipt.purchaseOrder.reference}` : ''}
      </p>
      <p
        className={`mt-1 text-sm ${receipt.distributorNtn && receipt.distributorStrn ? 'text-text-muted' : 'font-medium text-warning'}`}
      >
        Distributor NTN {receipt.distributorNtn ?? 'missing'} · STRN{' '}
        {receipt.distributorStrn ?? 'missing'}
      </p>
      {receipt.directPurchase ? (
        <div className="mt-3 rounded-[var(--radius-sm)] border border-warning/40 bg-warning/5 p-3">
          <p className="text-sm text-text-body">
            <span className="font-medium">Direct purchase.</span> {receipt.bypassReason}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Bypass approved {dateTime(receipt.bypassApprovedAt)}. Recorded permanently.
          </p>
        </div>
      ) : null}

      <ul className="mt-4 space-y-2">
        {receipt.lines.map((line) => (
          <li className="rounded-[var(--radius-sm)] border border-border-subtle p-3" key={line.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-text-strong">{line.medicine.productName}</span>
              <span className="font-mono text-sm tabular-nums text-text-strong">
                {money(line.unitCostMinor)} / unit
              </span>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Batch {line.batchNumber}
              {line.serialNumber ? ` · serial ${line.serialNumber}` : ''}
              {line.gtin ? ` · GTIN ${line.gtin}` : ''} · expires {dateOnly(line.printedExpiry)} (
              {line.expiryPrecision.toLowerCase()} precision) · MRP {money(line.printedMrpMinor)} ·{' '}
              {line.receivedPacks} {line.packLevel.level}
              {line.bonusPacks > 0 ? ` + ${line.bonusPacks} free` : ''} ×{' '}
              {line.canonicalUnitsPerPack} ={' '}
              {units(line.receivedCanonicalUnits + line.bonusCanonicalUnits)}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Accepted {units(line.acceptedCanonicalUnits)} into {line.stockLocation.name}
              {line.rejectedCanonicalUnits > 0
                ? ` · rejected ${units(line.rejectedCanonicalUnits)} into ${line.quarantineLocation?.name ?? 'quarantine'} — ${line.rejectionReason}`
                : ''}
            </p>
          </li>
        ))}
      </ul>

      {receipt.exceptions.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-sm font-medium text-text-strong">
            Exceptions raised by this receipt
          </h4>
          <ul className="mt-2 space-y-1">
            {receipt.exceptions.map((exception) => (
              <li className="text-xs text-text-muted" key={exception.id}>
                {exception.kind} · {exception.status} · {exception.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {receipt.status === 'POSTED' ? (
        <div className="mt-4">
          <h4 className="text-sm font-medium text-text-strong">Stock produced</h4>
          {lots.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">
              This receipt posted no lot, which means every line was rejected in full.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {lots.map((lot) => (
                <li
                  className="text-xs text-text-muted"
                  key={`${lot.lineNumber}-${lot.batchNumber}`}
                >
                  {lot.medicine.productName} · batch {lot.batchNumber} · in the batch ledger
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="mt-5 border-t border-border-subtle pt-5">
        {receipt.status === 'DRAFT' ? (
          <PurchasingActionForm
            operation={{ resource: `receipt:${receipt.id}`, action: 'post' }}
            action={onPost}
          >
            <input name="branchId" type="hidden" value={branchId} />
            <input name="goodsReceiptId" type="hidden" value={receipt.id} />
            {receipt.qualifiedPersonUserId ||
            receipt.lines.some((line) => line.medicine.controlled) ? (
              <div className="mb-3 grid gap-3 sm:grid-cols-2">
                <SelectField
                  emptyHint="No other active user with a dispensing PIN can witness this receipt."
                  hint="Must be the qualified person named when the receipt was drafted, and cannot be you."
                  label="Qualified person PIN"
                  name="witnessStaffProfileId"
                  notice={notice}
                  options={witnesses.map((witness) => ({
                    value: witness.id,
                    label: witness.name,
                  }))}
                  placeholder="Select the qualified person"
                  required
                />
                <TextField
                  autoComplete="off"
                  hint="Four to eight digits. A wrong PIN is refused and stock stays unposted."
                  inputMode="numeric"
                  label="PIN"
                  name="witnessPin"
                  notice={notice}
                  required
                  type="password"
                />
              </div>
            ) : null}
            {receipt.directPurchase ? (
              <TextField
                label="Direct purchase approver PIN (existing drafts)"
                name="receiptApprovalPin"
                notice={notice}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                hint="Required if this draft predates verified approval. The recorded approver must enter their PIN."
              />
            ) : null}
            <SubmitButton>Post into stock</SubmitButton>
            <p className="mt-2 text-sm text-text-muted">
              Posting creates the batch lot, both dispositions and any match exception in one
              transaction: all of it commits, or none of it does.
            </p>
          </PurchasingActionForm>
        ) : receipt.status === 'POSTED' ? (
          <PurchasingActionForm
            operation={{ resource: `receipt:${receipt.id}`, action: 'reverse' }}
            action={onReverse}
            className="flex flex-wrap items-end gap-3"
          >
            <input name="branchId" type="hidden" value={branchId} />
            <input name="goodsReceiptId" type="hidden" value={receipt.id} />
            <TextField
              className="min-w-64 flex-1"
              label="Why is this being reversed?"
              name="reversalReason"
              notice={notice}
              required
            />
            {receipt.reversalRequiresWitness ? (
              <div className="grid w-full gap-3 sm:grid-cols-2">
                <SelectField
                  emptyHint={
                    witnessLoadFailed
                      ? 'Witness choices could not load. Check your pharmacy safety access and reload before reversing controlled stock.'
                      : 'No other active user with a dispensing PIN can witness this reversal.'
                  }
                  hint={
                    witnesses.some((witness) => witness.self)
                      ? 'You are the only pharmacist, so you witness this reversal with your own PIN. It is recorded in the audit log.'
                      : 'A different pharmacist must approve this controlled stock reversal.'
                  }
                  label="Reversal witness"
                  name="witnessStaffProfileId"
                  notice={notice}
                  options={witnesses.map((witness) => ({ value: witness.id, label: witness.name }))}
                  placeholder="Select a pharmacist"
                  required
                />
                <TextField
                  autoComplete="off"
                  inputMode="numeric"
                  label="PIN"
                  name="witnessPin"
                  notice={notice}
                  required
                  type="password"
                />
              </div>
            ) : null}
            <SubmitButton
              variant="destructive"
              disabled={receipt.reversalRequiresWitness && witnesses.length === 0}
            >
              Reverse posting
            </SubmitButton>
            <p className="w-full text-sm text-text-muted">
              A reversal writes linked compensating movements. If the stock has already moved on,
              the ledger refuses rather than driving a balance negative.
            </p>
          </PurchasingActionForm>
        ) : (
          <p className="text-sm text-text-muted">
            This receipt is {receipt.status.toLowerCase()} and cannot be posted again.
            {receipt.reversalReason ? ` Reversed because: ${receipt.reversalReason}` : ''}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Form readers
// ---------------------------------------------------------------------------

function packOptions(medicines: MedicineOption[]) {
  return medicines.flatMap((medicine) =>
    medicine.packs.map((pack) => ({
      value: `${medicine.id}|${pack.packLevelId}|${pack.canonicalUnitsPerPack}`,
      label: `${medicine.productName} — ${pack.level} (${pack.conversionLabel})`,
    }))
  );
}

function warningCodes(form: FormData, key: string): Gs1WarningCode[] {
  const allowed = new Set<string>(GS1_WARNING_CODES);
  return (optionalField(form, `gs1Warnings:${key}`) ?? '')
    .split('\n')
    .map((code) => code.trim())
    .filter((code): code is Gs1WarningCode => allowed.has(code));
}

function readPack(value: string) {
  const [medicineId, packLevelId, unitsPerPack] = value.split('|');
  if (!medicineId || !packLevelId || !unitsPerPack) return null;
  const canonicalUnitsPerPack = Number(unitsPerPack);
  if (!Number.isSafeInteger(canonicalUnitsPerPack) || canonicalUnitsPerPack <= 0) return null;
  return { medicineId, packLevelId, canonicalUnitsPerPack };
}

function percentToBps(form: FormData, name: string, label: string): number {
  const raw = field(form, name);
  if (!raw) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw Object.assign(
      new PurchasingValidationError(`${label}: enter a percentage like 5 or 12.5.`),
      { field: name }
    );
  }
  return Math.round(Number(raw) * 100);
}

/** Everything the PH-INV lot needs, read off one capture fieldset. */
function readCaptureFields(form: FormData, key: string) {
  const rejectedCanonicalUnits = optionalIntegerField(
    form,
    `rejectedUnits:${key}`,
    'Rejected units',
    0
  );
  return {
    batchNumber: field(form, `batchNumber:${key}`),
    printedExpiry: dateField(form, `printedExpiry:${key}`, 'Printed expiry'),
    gtin: optionalField(form, `gtin:${key}`),
    serialNumber: optionalField(form, `serialNumber:${key}`),
    gs1Payload: optionalField(form, `gs1Payload:${key}`),
    invoiceCorrection: field(form, `invoiceCorrection:${key}`) === 'yes',
    gs1Warnings: warningCodes(form, key),
    expiryPrecision: (field(form, `expiryPrecision:${key}`) === 'DAY' ? 'DAY' : 'MONTH') as
      'DAY' | 'MONTH',
    printedMrpMinor: moneyFieldMinor(form, `printedMrp:${key}`, 'Printed MRP'),
    receivedPacks: integerField(form, `receivedPacks:${key}`, 'Packs received'),
    bonusPacks: optionalIntegerField(form, `bonusPacks:${key}`, 'Free packs', 0),
    rejectedCanonicalUnits,
    // PUR-04 refuses a rejection with nowhere to put it, so the reason and the
    // quarantine location travel together or not at all.
    rejectionReason: rejectedCanonicalUnits > 0 ? field(form, `rejectionReason:${key}`) : undefined,
    quarantineLocationId:
      rejectedCanonicalUnits > 0 ? field(form, `quarantineLocation:${key}`) : undefined,
    invoicedPricePerPackMinor: moneyFieldMinor(
      form,
      `invoicedPrice:${key}`,
      'Invoiced price per pack'
    ),
    discountBps: percentToBps(form, `discount:${key}`, 'Discount'),
    taxBps: percentToBps(form, `tax:${key}`, 'Tax'),
    taxCreditable: field(form, `taxCreditable:${key}`) === 'yes',
    stockLocationId: field(form, `stockLocation:${key}`),
  };
}

type Gs1Prefill = {
  batchNumber?: string;
  printedExpiry?: string;
  expiryPrecision?: 'DAY' | 'MONTH';
  serialNumber?: string;
  gtin?: string;
  payload?: string;
  warnings: string[];
  warningCodes: string[];
};

function gs1Prefill(scan: ScanResolution | null, rawScan?: string): Gs1Prefill | undefined {
  if (scan?.kind !== 'gs1') return undefined;
  const dayZero = scan.rawExpiry?.endsWith('00') === true;
  return {
    batchNumber: scan.batch ?? undefined,
    printedExpiry: scan.expiryDate ?? undefined,
    expiryPrecision: scan.expiryDate ? (dayZero ? 'MONTH' : 'DAY') : undefined,
    serialNumber: scan.serial ?? undefined,
    gtin: scan.serial ? scan.gtin : undefined,
    payload: rawScan,
    warnings: scan.warnings.map((warning) => warning.message),
    warningCodes: scan.warnings.map((warning) => warning.code),
  };
}

function scanOnOrder(scan: ScanResolution, order: PurchaseOrderDetail | null): boolean {
  if (!order || !('medicineId' in scan) || !scan.medicineId) return false;
  return order.lines.some((line) => line.medicineId === scan.medicineId);
}

function directPackValue(
  scan: ScanResolution | null,
  medicines: MedicineOption[]
): string | undefined {
  if (scan?.kind !== 'gs1' || !scan.medicineId || !scan.packLevelId) return undefined;
  return packOptions(medicines).find((option) =>
    option.value.startsWith(`${scan.medicineId}|${scan.packLevelId}|`)
  )?.value;
}

function ScanNotice({ scan, onThisOrder }: { scan: ScanResolution; onThisOrder: boolean }) {
  if (scan.kind === 'unresolved') {
    return (
      <p className="mt-3 text-xs text-destructive" role="alert">
        Nothing in this workspace matches “{scan.label}”. Check the code, or pick the line by name
        below.
      </p>
    );
  }
  if (scan.kind === 'manual') {
    return (
      <p className="mt-3 text-xs text-text-muted" role="alert">
        This code could not be read ({scan.reason}). Enter the product, batch and expiry by hand.
        Older packs without a 2D code stay receivable.
      </p>
    );
  }
  if (scan.kind === 'barcode') {
    return (
      <p className="mt-3 text-xs text-text-muted" role="status">
        Linear code matched {scan.label}. It has no batch or expiry, so enter those by hand.
      </p>
    );
  }
  if (scan.kind === 'medicine') {
    return (
      <p className="mt-3 text-xs text-text-muted" role="status">
        Matched {scan.label}. Enter batch, expiry and serial by hand.
      </p>
    );
  }
  const warning = scan.warnings.map((item) => item.message).join(' ');
  const where = scan.medicineId
    ? onThisOrder
      ? `Matched ${scan.label}. Batch, expiry and serial are filled on that line. Confirm the expiry against the invoice.`
      : `${scan.label} matches GTIN ${scan.gtin}, but it is not a line on this order. Enter it by hand or receive it as a direct purchase.`
    : `GTIN ${scan.gtin} is not linked to a product. Batch ${scan.batch ?? '—'}, expiry ${scan.expiryDate ?? '—'}, serial ${scan.serial ?? '—'}. Link the GTIN, or type the line by hand.`;
  return (
    <p className="mt-3 text-xs text-text-muted" role="status">
      {where}
      {warning ? ` ${warning}` : ''}
    </p>
  );
}

function linkTo(query: SearchQuery, branchId: string, next: Record<string, string>): string {
  const params = new URLSearchParams({ branch: branchId });
  for (const key of ['order', 'receipt', 'exceptions', 'scan'] as const) {
    const value = param(query, key);
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(next)) params.set(key, value);
  return `${ROUTE}?${params}`;
}
