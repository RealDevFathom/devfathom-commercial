import { isSoloPharmacyOwner } from '@/lib/pharmacy/solo-owner-approval';
import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { PurchasingActionForm } from '../_components/action-form';
import { PurchasingOutcomeScope, PurchasingOutcomes } from '../_components/action-outcomes';

import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { hasModule } from '@/lib/entitlements';
import type { QuoteComparisonRow } from '@/lib/pharmacy/purchasing';
import type {
  MedicineOption,
  PurchaseOrderDetail,
  PurchasingWorkspace,
  RequisitionDetail,
} from '@/lib/pharmacy/purchasing-console';
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
  bps,
  dateOnly,
  dateTime,
  destination,
  field,
  integerField,
  microMoney,
  money,
  moneyFieldMinor,
  noticeFrom,
  NO_ACTOR,
  optionalDateField,
  optionalField,
  optionalIntegerField,
  optionalMoneyFieldMinor,
  param,
  purchasingCaller,
  PURCHASING_ROUTE,
  tenantContext,
  units,
  type Notice,
  type SearchQuery,
} from '../_lib/console';

export const metadata: Metadata = { title: 'Requisitions & orders · Pharmacy purchasing' };

const ROUTE = `${PURCHASING_ROUTE}/orders`;
const HEADING = 'Requisitions & orders';
const DESCRIPTION =
  'Demand becomes a requisition, quotes are compared and explained, and an approved order is sent to a supplier that is still licensed at the moment it leaves.';

/** Five slots is enough for a hand-written order and needs no client script. */
const LINE_SLOTS = [0, 1, 2, 3, 4] as const;

/** One requisition line, with every quote for it ranked and explained. */
type LineComparison = {
  lineId: string;
  medicine: string;
  ranking: readonly QuoteComparisonRow[];
};

export default async function PharmacyOrdersPage({
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
  const caller = await purchasingCaller();
  if (!caller) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }

  const requestedRequisition = param(query, 'req');
  const requestedOrder = param(query, 'po');

  let workspace: PurchasingWorkspace | null = null;
  let requisitions: RequisitionDetail[] = [];
  let orders: PurchaseOrderDetail[] = [];
  let loadError = false;
  try {
    [workspace, requisitions, orders] = await Promise.all([
      caller.workspace(),
      caller.requisitions(),
      caller.purchaseOrders(),
    ]);
  } catch {
    loadError = true;
  }

  // UX rule 5 again: an unmatched id resolves to the empty state, never to
  // whichever record happens to be first.
  const requisition = requisitions.find((row) => row.id === requestedRequisition) ?? null;
  const order = orders.find((row) => row.id === requestedOrder) ?? null;
  const soloOwner = order
    ? await isSoloPharmacyOwner(
        ctx.db,
        ctx.entitlements.organizationId,
        ctx.session.user.id,
        order.branchId ?? undefined
      )
    : false;

  /**
   * PUR-02: the ranked, explained comparison for every line of the selected
   * requisition. Loaded only for the selection, because the comparison is a
   * priced calculation per line and running it for the whole register would be
   * work nobody asked for.
   */
  let comparisons: LineComparison[] = [];
  if (requisition) {
    comparisons = await Promise.all(
      requisition.lines.map(async (line) => ({
        lineId: line.id,
        medicine: line.medicine.productName,
        ranking: (await caller.compareQuotes({ requisitionLineId: line.id })).ranking,
      }))
    );
  }

  /** PUR-03: the stored order, costed, with freight allocated across its lines. */
  let landed: Awaited<ReturnType<typeof caller.landedCost>> | null = null;
  if (order) {
    try {
      landed = await caller.landedCost({ purchaseOrderId: order.id });
    } catch {
      landed = null;
    }
  }

  async function createRequisition(form: FormData) {
    'use server';
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const lines = readLineSlots(form);
      if (lines.length === 0) {
        throw Object.assign(
          new PurchasingValidationError('Add at least one medicine and quantity.'),
          {
            field: 'medicineId-0',
          }
        );
      }
      const created = await outcome.write(actionCaller.createRequisition)({
        reference: field(form, 'reference'),
        branchId: optionalField(form, 'branchId'),
        neededBy: optionalDateField(form, 'neededBy', 'Needed by'),
        note: optionalField(form, 'note'),
        lines,
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        { message: `Requisition ${created.reference} drafted.`, kind: 'success' },
        { req: created.id }
      );
    } catch (error) {
      next = destination(ROUTE, {
        ...outcome.failure(error, 'Could not draft the requisition.'),
        kind: 'error',
      });
    }
    return next;
  }

  async function submitRequisition(form: FormData) {
    'use server';
    const requisitionId = field(form, 'requisitionId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.submitRequisition)({ requisitionId });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        { message: 'Requisition submitted. Record quotes against it next.', kind: 'success' },
        { req: requisitionId }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not submit the requisition.'), kind: 'error' },
        { req: requisitionId }
      );
    }
    return next;
  }

  async function recordQuote(form: FormData) {
    'use server';
    const requisitionId = field(form, 'requisitionId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const lineIds = form.getAll('requisitionLineId').map(String);
      const lines = lineIds.flatMap((lineId) => {
        const price = field(form, `price:${lineId}`);
        if (!price) return [];
        return [
          {
            requisitionLineId: lineId,
            pricePerPackMinor: moneyFieldMinor(form, `price:${lineId}`, 'Price per pack'),
            schemeBuyPacks: optionalIntegerField(form, `buy:${lineId}`, 'Scheme buy', 0),
            schemeFreePacks: optionalIntegerField(form, `free:${lineId}`, 'Scheme free', 0),
            discountBps: percentToBps(form, `discount:${lineId}`, 'Discount'),
            moqPacks: optionalIntegerField(form, `moq:${lineId}`, 'Minimum order', 1),
            leadTimeDays: optionalIntegerField(form, `lead:${lineId}`, 'Lead time', 0),
            minimumExpiryDays: optionalIntegerField(form, `shelf:${lineId}`, 'Shelf life', 0),
            canonicalUnitsPerPack: integerField(form, `unitsPerPack:${lineId}`, 'Units per pack'),
          },
        ];
      });
      if (lines.length === 0) {
        throw new PurchasingValidationError('Enter a price for at least one line of this quote.');
      }
      await outcome.write(actionCaller.recordQuote)({
        requisitionId,
        supplierId: field(form, 'supplierId'),
        reference: optionalField(form, 'quoteReference'),
        quotedAt: optionalDateField(form, 'quotedAt', 'Quoted on') ?? new Date(),
        validUntil: optionalDateField(form, 'validUntil', 'Valid until') ?? new Date(),
        note: optionalField(form, 'quoteNote'),
        lines,
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        { message: 'Quote recorded. The comparison below has been re-ranked.', kind: 'success' },
        { req: requisitionId }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not record the quote.'), kind: 'error' },
        { req: requisitionId }
      );
    }
    return next;
  }

  /**
   * PUR-02: award a quote by raising the order it prices. Every line of the
   * requisition is carried across at that quote's terms, so the order the
   * operator approves is the one the comparison explained — nothing is retyped
   * and nothing can drift between the two.
   */
  async function orderFromQuote(form: FormData) {
    'use server';
    const requisitionId = field(form, 'requisitionId');
    const quoteId = field(form, 'quoteId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const source = (await actionCaller.requisitions()).find((row) => row.id === requisitionId);
      if (!source)
        throw new PurchasingValidationError('That requisition no longer exists. Reload the page.');
      const quote = source.quotes.find((row) => row.id === quoteId);
      if (!quote)
        throw new PurchasingValidationError('That quote no longer exists. Reload the page.');

      const lines = source.lines.flatMap((line) => {
        const quoted = quote.lines.find((row) => row.requisitionLineId === line.id);
        if (!quoted) return [];
        const orderedPacks = Math.max(line.quantityPacks, quoted.moqPacks);
        const bonusPacks =
          quoted.schemeBuyPacks > 0 && quoted.schemeFreePacks > 0
            ? Math.floor(orderedPacks / quoted.schemeBuyPacks) * quoted.schemeFreePacks
            : 0;
        return [
          {
            medicineId: line.medicineId,
            packLevelId: line.packLevelId,
            orderedPacks,
            bonusPacks,
            canonicalUnitsPerPack: quoted.canonicalUnitsPerPack,
            listPricePerPackMinor: quoted.pricePerPackMinor,
            discountBps: quoted.discountBps,
          },
        ];
      });
      if (lines.length === 0) {
        throw new PurchasingValidationError('That quote prices none of this requisition’s lines.');
      }
      const created = await outcome.write(actionCaller.createPurchaseOrder)({
        reference: field(form, 'reference'),
        supplierId: quote.supplierId,
        branchId: source.branchId ?? undefined,
        requisitionId: source.id,
        quoteId: quote.id,
        expectedDeliveryAt: optionalDateField(form, 'expectedDeliveryAt', 'Expected delivery'),
        freightMinor: optionalMoneyFieldMinor(form, 'freight', 'Freight', 0),
        otherChargesMinor: optionalMoneyFieldMinor(form, 'otherCharges', 'Other charges', 0),
        lines,
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: `Order ${created.reference} drafted from ${quote.supplier.name}'s quote.`,
          kind: 'success',
        },
        { req: requisitionId, po: created.id }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not raise the order.'), kind: 'error' },
        { req: requisitionId }
      );
    }
    return next;
  }

  async function createDirectOrder(form: FormData) {
    'use server';
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const lines = readOrderLineSlots(form);
      if (lines.length === 0) {
        throw Object.assign(
          new PurchasingValidationError('Add at least one medicine, quantity and price.'),
          {
            field: 'orderMedicineId-0',
          }
        );
      }
      const created = await outcome.write(actionCaller.createPurchaseOrder)({
        reference: field(form, 'reference'),
        supplierId: field(form, 'supplierId'),
        branchId: optionalField(form, 'branchId'),
        expectedDeliveryAt: optionalDateField(form, 'expectedDeliveryAt', 'Expected delivery'),
        freightMinor: optionalMoneyFieldMinor(form, 'freight', 'Freight', 0),
        otherChargesMinor: optionalMoneyFieldMinor(form, 'otherCharges', 'Other charges', 0),
        note: optionalField(form, 'note'),
        lines,
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        { message: `Order ${created.reference} drafted.`, kind: 'success' },
        { po: created.id }
      );
    } catch (error) {
      next = destination(ROUTE, {
        ...outcome.failure(error, 'Could not draft the order.'),
        kind: 'error',
      });
    }
    return next;
  }

  async function advanceOrder(form: FormData) {
    'use server';
    const purchaseOrderId = field(form, 'purchaseOrderId');
    const action = field(form, 'action');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      let message: string;
      if (action === 'submit') {
        await outcome.write(actionCaller.submitPurchaseOrder)({ purchaseOrderId });
        message = 'Order submitted for approval. A second approver or solo owner PIN is required.';
      } else if (action === 'approve' || action === 'reject') {
        await outcome.write(actionCaller.approvePurchaseOrder)({
          purchaseOrderId,
          decision: action === 'approve' ? 'APPROVED' : 'REJECTED',
          pin: optionalField(form, 'pin'),
          reason: optionalField(form, 'reason'),
        });
        message =
          action === 'approve'
            ? 'Order approved. Send it once you are ready.'
            : 'Order rejected and returned to draft. The decision is on the record.';
      } else if (action === 'send') {
        await outcome.write(actionCaller.sendPurchaseOrder)({ purchaseOrderId });
        message = 'Order sent. Receive against it on the goods-in bench.';
      } else {
        throw new PurchasingValidationError('Unknown action.');
      }
      revalidatePath(ROUTE);
      next = destination(ROUTE, { message, kind: 'success' }, { po: purchaseOrderId });
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not move the order on.'), kind: 'error' },
        { po: purchaseOrderId }
      );
    }
    return next;
  }

  if (loadError || !workspace) {
    return (
      <PurchasingOutcomeScope>
        <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
        <PurchasingTabs active={ROUTE} />
        <NoticeBanner notice={notice} />
        <PurchasingOutcomes />
        <LoadFailure
          detail="Requisitions and orders could not be read. This read failure does not confirm or undo earlier changes. Check their outcomes before retrying."
          retryHref={ROUTE}
        />
      </PurchasingOutcomeScope>
    );
  }

  const orderable = workspace.suppliers.filter((supplier) => supplier.eligibility.orderable);
  const medicinesWithPacks = workspace.medicines.filter((medicine) => medicine.packs.length > 0);

  return (
    <PurchasingOutcomeScope>
      <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
      <PurchasingTabs active={ROUTE} />
      <NoticeBanner notice={notice} />
      <PurchasingOutcomes />

      <div className="grid gap-6 sm:grid-cols-3">
        <Stat
          label="Open requisitions"
          value={requisitions.filter((r) => r.status !== 'CANCELLED').length}
          sub="Drafted or submitted"
        />
        <Stat
          label="Awaiting approval"
          value={orders.filter((o) => o.status === 'SUBMITTED').length}
          sub="Needs a second person"
        />
        <Stat
          label="Orderable suppliers"
          value={`${orderable.length} of ${workspace.suppliers.length}`}
          sub="Authorized and licensed"
        />
      </div>

      {/* ─── PUR-02 requisitions ──────────────────────────────────────────── */}
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,11fr)] xl:items-start">
        <SectionCard
          eyebrow="PUR-02"
          title={`Requisitions (${requisitions.length})`}
          titleLevel={2}
        >
          {requisitions.length === 0 ? (
            <EmptyState
              title="No requisitions yet"
              detail="A requisition states what the pharmacy needs, in packs. Draft one below, submit it, then record the quotes you were given."
            />
          ) : (
            <ul className="space-y-2">
              {requisitions.map((row) => (
                <li key={row.id}>
                  <a
                    aria-current={row.id === requisition?.id ? 'true' : undefined}
                    className={rowClass(row.id === requisition?.id)}
                    href={hrefWith(query, { req: row.id })}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-text-strong">
                        {row.reference}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {row.lines.length} line{row.lines.length === 1 ? '' : 's'} ·{' '}
                        {row.branch?.name ?? 'No branch'} · {row.quotes.length} quote
                        {row.quotes.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <StatusPill status={row.status} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="min-w-0 space-y-6">
          {requisition ? (
            <RequisitionDetailPanel
              comparisons={comparisons}
              notice={notice}
              onOrderFromQuote={orderFromQuote}
              onRecordQuote={recordQuote}
              onSubmit={submitRequisition}
              requisition={requisition}
              workspace={workspace}
            />
          ) : (
            <SectionCard title="No requisition selected" titleLevel={2}>
              <EmptyState
                title="Pick a requisition to compare its quotes"
                detail="Its lines, the quotes recorded against them and the ranked comparison open here, beside the list."
              />
            </SectionCard>
          )}

          <SectionCard eyebrow="PUR-02" title="Draft a requisition" titleLevel={2}>
            {medicinesWithPacks.length === 0 ? (
              <EmptyState
                title="No medicine has a pack conversion yet"
                detail="A requisition is stated in packs, so every line needs a medicine with an effective pack level. Add one before drafting demand."
                steps={[{ label: 'Open the medicine register', href: '/pharmacy' }]}
              />
            ) : (
              <PurchasingActionForm
                operation={{ resource: 'requisition:new', action: 'create' }}
                action={createRequisition}
                className="space-y-4"
              >
                <div className="grid gap-4 sm:grid-cols-3">
                  <TextField label="Reference" name="reference" notice={notice} required />
                  <SelectField
                    emptyHint="No active branch yet. Requisitions can still be raised without one."
                    label="Branch"
                    name="branchId"
                    notice={notice}
                    options={workspace.branches.map((branch) => ({
                      value: branch.id,
                      label: `${branch.name} — ${branch.city}`,
                    }))}
                    placeholder="Not branch-specific"
                  />
                  <TextField label="Needed by" name="neededBy" notice={notice} type="date" />
                </div>
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-text-body">
                    Lines — leave a slot empty to skip it
                  </legend>
                  {LINE_SLOTS.map((slot) => (
                    <RequisitionLineSlot
                      key={slot}
                      medicines={medicinesWithPacks}
                      notice={notice}
                      slot={slot}
                    />
                  ))}
                </fieldset>
                <TextAreaField label="Note" name="note" notice={notice} />
                <SubmitButton>Draft requisition</SubmitButton>
              </PurchasingActionForm>
            )}
          </SectionCard>
        </div>
      </div>

      {/* ─── PUR-02/03 purchase orders ────────────────────────────────────── */}
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,11fr)] xl:items-start">
        <SectionCard eyebrow="PUR-02" title={`Purchase orders (${orders.length})`} titleLevel={2}>
          {orders.length === 0 ? (
            <EmptyState
              title="No purchase orders yet"
              detail="Raise one from a quote above so the order carries the terms that were compared, or draft an ad-hoc order below."
            />
          ) : (
            <ul className="space-y-2">
              {orders.map((row) => (
                <li key={row.id}>
                  <a
                    aria-current={row.id === order?.id ? 'true' : undefined}
                    className={rowClass(row.id === order?.id)}
                    href={hrefWith(query, { po: row.id })}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-text-strong">
                        {row.reference}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {row.supplier.name} · {row.lines.length} line
                        {row.lines.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <StatusPill status={row.status} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="min-w-0 space-y-6">
          {order ? (
            <OrderDetailPanel
              actorId={ctx.session.user.id}
              soloOwner={soloOwner}
              landed={landed}
              notice={notice}
              onAdvance={advanceOrder}
              order={order}
            />
          ) : (
            <SectionCard title="No order selected" titleLevel={2}>
              <EmptyState
                title="Pick an order to cost and approve it"
                detail="Its lines, landed cost with freight allocated, approval history and the next available action open here."
              />
            </SectionCard>
          )}

          <SectionCard eyebrow="PUR-02/03" title="Draft an ad-hoc order" titleLevel={2}>
            {orderable.length === 0 ? (
              <EmptyState
                title="No supplier can be ordered from"
                detail={
                  workspace.suppliers.length === 0
                    ? 'There are no suppliers yet. Add one and file a verified licence before raising an order.'
                    : 'Every supplier is either unauthorized or without an unexpired verified licence. PUR-01 refuses an order to any of them.'
                }
                steps={[
                  {
                    label: 'Open the supplier register',
                    href: `${PURCHASING_ROUTE}/suppliers`,
                  },
                ]}
              />
            ) : medicinesWithPacks.length === 0 ? (
              <EmptyState
                title="No medicine has a pack conversion yet"
                detail="An order line is priced per pack, so it needs a medicine with an effective pack level."
                steps={[{ label: 'Open the medicine register', href: '/pharmacy' }]}
              />
            ) : (
              <PurchasingActionForm
                operation={{ resource: 'order:new', action: 'create' }}
                action={createDirectOrder}
                className="space-y-4"
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <TextField label="Reference" name="reference" notice={notice} required />
                  <SelectField
                    emptyHint="No orderable supplier — authorize one and file a licence first."
                    label="Supplier"
                    name="supplierId"
                    notice={notice}
                    options={supplierOptions(workspace.suppliers)}
                    required
                  />
                  <SelectField
                    emptyHint="No active branch yet."
                    label="Branch"
                    name="branchId"
                    notice={notice}
                    options={workspace.branches.map((branch) => ({
                      value: branch.id,
                      label: `${branch.name} — ${branch.city}`,
                    }))}
                    placeholder="Not branch-specific"
                  />
                  <TextField
                    label="Expected delivery"
                    name="expectedDeliveryAt"
                    notice={notice}
                    type="date"
                  />
                </div>
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-text-body">
                    Lines — leave a slot empty to skip it
                  </legend>
                  {LINE_SLOTS.map((slot) => (
                    <OrderLineSlot
                      key={slot}
                      medicines={medicinesWithPacks}
                      notice={notice}
                      slot={slot}
                    />
                  ))}
                </fieldset>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    inputMode="decimal"
                    label="Freight (PKR)"
                    name="freight"
                    notice={notice}
                    hint="Allocated across the lines by net value."
                  />
                  <TextField
                    inputMode="decimal"
                    label="Other charges (PKR)"
                    name="otherCharges"
                    notice={notice}
                  />
                </div>
                <TextAreaField label="Note" name="note" notice={notice} />
                <SubmitButton>Draft order</SubmitButton>
              </PurchasingActionForm>
            )}
          </SectionCard>
        </div>
      </div>
    </PurchasingOutcomeScope>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function RequisitionDetailPanel({
  requisition,
  comparisons,
  workspace,
  notice,
  onSubmit,
  onRecordQuote,
  onOrderFromQuote,
}: {
  requisition: RequisitionDetail;
  comparisons: LineComparison[];
  workspace: PurchasingWorkspace;
  notice: Notice | null;
  onSubmit: (form: FormData) => Promise<string>;
  onRecordQuote: (form: FormData) => Promise<string>;
  onOrderFromQuote: (form: FormData) => Promise<string>;
}) {
  return (
    <>
      <SectionCard
        eyebrow="PUR-02"
        title={requisition.reference}
        titleLevel={2}
        actions={<StatusPill status={requisition.status} />}
      >
        <p className="text-sm text-text-muted">
          {requisition.branch?.name ?? 'Not branch-specific'} · raised{' '}
          {dateOnly(requisition.createdAt)}
          {requisition.neededBy ? ` · needed by ${dateOnly(requisition.neededBy)}` : ''}
        </p>
        <ul className="mt-4 space-y-2">
          {requisition.lines.map((line) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border-subtle p-3"
              key={line.id}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-text-strong">
                  {line.medicine.productName}
                </span>
                <span className="block text-xs text-text-muted">
                  {line.quantityPacks} packs × {line.canonicalUnitsPerPack} ={' '}
                  {units(line.canonicalUnits)}
                </span>
              </span>
            </li>
          ))}
        </ul>
        {requisition.status === 'DRAFT' ? (
          <PurchasingActionForm
            operation={{ resource: `requisition:${requisition.id}`, action: 'submit' }}
            action={onSubmit}
            className="mt-4"
          >
            <input name="requisitionId" type="hidden" value={requisition.id} />
            <SubmitButton>Submit requisition</SubmitButton>
          </PurchasingActionForm>
        ) : null}
      </SectionCard>

      <SectionCard eyebrow="PUR-02" title="Quote comparison — ranked and explained" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Ranked by effective landed cost per unit, then lead time, then shelf life. It never
          awards: every position states its reasons and you decide.
        </p>
        {comparisons.every((comparison) => comparison.ranking.length === 0) ? (
          <EmptyState
            title="No quotes recorded yet"
            detail="Record what each distributor offered below. A quote can be entered against any line of this requisition; lines you leave blank are simply not quoted."
          />
        ) : (
          <div className="mt-4 space-y-5">
            {comparisons.map((comparison) => (
              <div key={comparison.lineId}>
                <h4 className="text-sm font-medium text-text-strong">{comparison.medicine}</h4>
                {comparison.ranking.length === 0 ? (
                  <p className="mt-1 text-sm text-text-muted">Not quoted by anybody yet.</p>
                ) : (
                  <ol className="mt-2 space-y-2">
                    {comparison.ranking.map((row) => (
                      <li
                        className={`rounded-[var(--radius-sm)] border p-3 ${
                          row.comparable
                            ? 'border-border-subtle'
                            : 'border-destructive/40 bg-destructive/5'
                        }`}
                        key={row.quoteId}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-text-strong">
                            #{row.rank} · {row.supplierName}
                          </span>
                          <span className="flex items-center gap-2">
                            <StatusPill
                              status={row.comparable ? 'Comparable' : 'Not comparable'}
                              tone={row.comparable ? 'success' : 'danger'}
                            />
                            <span className="font-mono text-sm tabular-nums text-text-strong">
                              {microMoney(row.effectiveUnitCostMicroMinor)} / unit
                            </span>
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-text-muted">
                          {row.packsForRequirement} packs
                          {row.bonusPacks > 0 ? ` + ${row.bonusPacks} free` : ''} · MOQ{' '}
                          {row.moqPacks} · lead {row.leadTimeDays}d · shelf life{' '}
                          {row.minimumExpiryDays}d
                        </p>
                        <ul className="mt-2 space-y-1">
                          {row.reasons.map((reason) => (
                            <li className="text-xs text-text-muted" key={reason}>
                              · {reason}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        )}

        {requisition.quotes.length > 0 ? (
          <div className="mt-6 border-t border-border-subtle pt-5">
            <h4 className="text-sm font-medium text-text-strong">Award a quote</h4>
            <p className="mt-1 text-sm text-text-muted">
              The order is built from this requisition&rsquo;s lines at the chosen quote&rsquo;s
              terms, so what you approve is what the comparison explained.
            </p>
            <PurchasingActionForm
              operation={{ resource: `requisition:${requisition.id}`, action: 'award-quote' }}
              action={onOrderFromQuote}
              className="mt-3 grid gap-4 sm:grid-cols-2"
            >
              <input name="requisitionId" type="hidden" value={requisition.id} />
              <SelectField
                emptyHint="No quotes recorded yet."
                label="Quote to award"
                name="quoteId"
                notice={notice}
                options={requisition.quotes.map((quote) => ({
                  value: quote.id,
                  label: `${quote.supplier.name}${quote.reference ? ` · ${quote.reference}` : ''} (valid to ${dateOnly(quote.validUntil)})`,
                }))}
                required
              />
              <TextField label="Order reference" name="reference" notice={notice} required />
              <TextField
                label="Expected delivery"
                name="expectedDeliveryAt"
                notice={notice}
                type="date"
              />
              <TextField
                inputMode="decimal"
                label="Freight (PKR)"
                name="freight"
                notice={notice}
                hint="Allocated across the lines by net value."
              />
              <div className="sm:col-span-2">
                <SubmitButton>Raise purchase order from this quote</SubmitButton>
              </div>
            </PurchasingActionForm>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard eyebrow="PUR-02" title="Record a quote" titleLevel={2}>
        <PurchasingActionForm
          operation={{ resource: `requisition:${requisition.id}`, action: 'record-quote' }}
          action={onRecordQuote}
          className="space-y-4"
        >
          <input name="requisitionId" type="hidden" value={requisition.id} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SelectField
              emptyHint="No suppliers yet — add one on the supplier page first."
              label="Supplier"
              name="supplierId"
              notice={notice}
              options={workspace.suppliers.map((supplier) => ({
                value: supplier.id,
                label: supplier.name,
              }))}
              required
              hint="A quote can be recorded from any supplier; only an orderable one can be awarded."
            />
            <TextField label="Quote reference" name="quoteReference" notice={notice} />
            <TextField label="Quoted on" name="quotedAt" notice={notice} type="date" required />
            <TextField label="Valid until" name="validUntil" notice={notice} type="date" required />
          </div>
          <div className="space-y-3">
            {requisition.lines.map((line) => (
              <fieldset
                className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={line.id}
              >
                <legend className="px-1 text-sm font-medium text-text-strong">
                  {line.medicine.productName} — {line.quantityPacks} packs needed
                </legend>
                <input name="requisitionLineId" type="hidden" value={line.id} />
                <input
                  name={`unitsPerPack:${line.id}`}
                  type="hidden"
                  value={line.canonicalUnitsPerPack}
                />
                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  <TextField
                    inputMode="decimal"
                    label="Price per pack (PKR)"
                    name={`price:${line.id}`}
                    notice={notice}
                    hint="Blank = not quoted."
                  />
                  <TextField
                    inputMode="decimal"
                    label="Discount %"
                    name={`discount:${line.id}`}
                    notice={notice}
                  />
                  <TextField
                    inputMode="numeric"
                    label="Scheme: buy"
                    min={0}
                    name={`buy:${line.id}`}
                    notice={notice}
                    type="number"
                  />
                  <TextField
                    inputMode="numeric"
                    label="Scheme: free"
                    min={0}
                    name={`free:${line.id}`}
                    notice={notice}
                    type="number"
                  />
                  <TextField
                    inputMode="numeric"
                    label="Minimum order (packs)"
                    min={1}
                    name={`moq:${line.id}`}
                    notice={notice}
                    type="number"
                  />
                  <TextField
                    inputMode="numeric"
                    label="Lead time (days)"
                    min={0}
                    name={`lead:${line.id}`}
                    notice={notice}
                    type="number"
                  />
                  <TextField
                    inputMode="numeric"
                    label="Shelf life offered (days)"
                    min={0}
                    name={`shelf:${line.id}`}
                    notice={notice}
                    type="number"
                  />
                  <Derived label="Pack" value={`${line.canonicalUnitsPerPack} units per pack`} />
                </div>
              </fieldset>
            ))}
          </div>
          <TextAreaField label="Quote note" name="quoteNote" notice={notice} />
          <SubmitButton>Record quote</SubmitButton>
        </PurchasingActionForm>
      </SectionCard>
    </>
  );
}

function OrderDetailPanel({
  order,
  landed,
  actorId,
  soloOwner,
  notice,
  onAdvance,
}: {
  order: PurchaseOrderDetail;
  landed: {
    payableMinor: number;
    landedCostMinor: number;
    taxMinor: number;
    chargesMinor: number;
    canonicalUnits: number;
    lines: readonly {
      purchaseOrderLineId: string;
      landedCostPerCanonicalUnitMicroMinor: number;
      allocatedChargeMinor: number;
      netCostMinor: number;
    }[];
  } | null;
  actorId: string;
  soloOwner: boolean;
  notice: Notice | null;
  onAdvance: (form: FormData) => Promise<string>;
}) {
  // PUR-02 segregation of duties, stated before the button is pressed rather
  // than as a refusal afterwards.
  const selfApproval =
    order.createdByUserId === actorId || order.requisition?.requestedByUserId === actorId;
  const costByLine = new Map(landed?.lines.map((line) => [line.purchaseOrderLineId, line]) ?? []);

  return (
    <SectionCard
      eyebrow="PUR-02/03"
      title={order.reference}
      titleLevel={2}
      actions={<StatusPill status={order.status} />}
    >
      <p className="text-sm text-text-muted">
        {order.supplier.name} · {order.branch?.name ?? 'Not branch-specific'}
        {order.requisition ? ` · from requisition ${order.requisition.reference}` : ''}
        {order.expectedDeliveryAt ? ` · expected ${dateOnly(order.expectedDeliveryAt)}` : ''}
      </p>

      <div className="mt-4 grid gap-6 sm:grid-cols-4">
        <Stat
          label="Payable"
          value={money(landed?.payableMinor ?? null)}
          sub="Net + tax + charges"
        />
        <Stat
          label="Landed cost"
          value={money(landed?.landedCostMinor ?? null)}
          sub="Stock value"
        />
        <Stat
          label="Tax"
          value={money(landed?.taxMinor ?? null)}
          sub="Creditable excluded from cost"
        />
        <Stat
          label="Units ordered"
          value={landed ? landed.canonicalUnits.toLocaleString('en-PK') : '—'}
          sub="Includes bonus units"
        />
      </div>

      <ul className="mt-5 space-y-2">
        {order.lines.map((line) => {
          const cost = costByLine.get(line.id);
          return (
            <li
              className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
              key={line.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-text-strong">{line.medicine.productName}</span>
                <span className="font-mono text-sm tabular-nums text-text-strong">
                  {cost ? microMoney(cost.landedCostPerCanonicalUnitMicroMinor) : '—'} / unit
                </span>
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {line.orderedPacks} {line.packLevel.level}
                {line.bonusPacks > 0 ? ` + ${line.bonusPacks} free` : ''} ×{' '}
                {line.canonicalUnitsPerPack} ={' '}
                {units(line.orderedCanonicalUnits + line.bonusCanonicalUnits)} · list{' '}
                {money(line.listPricePerPackMinor)}/pack · discount {bps(line.discountBps)} · rebate{' '}
                {bps(line.rebateBps)} · tax {bps(line.taxBps)}
                {line.taxCreditable ? ' (creditable)' : ''}
              </p>
              {cost ? (
                <p className="mt-1 text-xs text-text-muted">
                  Net {money(cost.netCostMinor)} + allocated charges{' '}
                  {money(cost.allocatedChargeMinor)}
                  {line.bonusPacks > 0
                    ? ' · bonus packs divide the same money over more units, so the unit cost falls and no revenue is created.'
                    : ''}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {order.approvals.length > 0 ? (
        <div className="mt-5">
          <h4 className="text-sm font-medium text-text-strong">Approval history</h4>
          <ul className="mt-2 space-y-1">
            {order.approvals.map((approval) => (
              <li className="text-xs text-text-muted" key={approval.id}>
                {dateTime(approval.createdAt)} · {approval.decision} ({approval.fromStatus} →{' '}
                {approval.toStatus}) under {approval.policy}
                {approval.reason ? ` · ${approval.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {order.goodsReceipts.length > 0 ? (
        <div className="mt-5">
          <h4 className="text-sm font-medium text-text-strong">Receipts</h4>
          <ul className="mt-2 space-y-1">
            {order.goodsReceipts.map((receipt) => (
              <li className="text-xs text-text-muted" key={receipt.id}>
                {receipt.reference} · {receipt.status} · {dateOnly(receipt.receivedAt)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-5">
        {order.status === 'DRAFT' ? (
          <PurchasingActionForm
            operation={{ resource: `order:${order.id}`, action: 'submit' }}
            action={onAdvance}
          >
            <input name="purchaseOrderId" type="hidden" value={order.id} />
            <input name="action" type="hidden" value="submit" />
            <SubmitButton>Submit for approval</SubmitButton>
          </PurchasingActionForm>
        ) : null}

        {order.status === 'SUBMITTED' ? (
          selfApproval && !soloOwner ? (
            <p className="text-sm text-text-muted">
              You raised this order, so you cannot approve it. That is the PUR-02 segregation of
              duties rule — ask a second person to decide.
            </p>
          ) : (
            <PurchasingActionForm
              operation={{ resource: `order:${order.id}`, action: 'decide' }}
              action={onAdvance}
              className="flex flex-wrap items-end gap-3"
            >
              <input name="purchaseOrderId" type="hidden" value={order.id} />
              {selfApproval ? (
                <TextField
                  label="Owner PIN"
                  name="pin"
                  notice={notice}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  required
                  hint="Solo owner decisions require a fresh PIN and are audited."
                />
              ) : null}
              <TextField
                className="min-w-56"
                label="Decision note"
                name="reason"
                notice={notice}
                hint="Recorded with the decision, including a rejection."
              />
              <SubmitButton name="action" value="approve">
                Approve
              </SubmitButton>
              <SubmitButton name="action" value="reject" variant="destructive">
                Reject
              </SubmitButton>
            </PurchasingActionForm>
          )
        ) : null}

        {order.status === 'APPROVED' ? (
          <PurchasingActionForm
            operation={{ resource: `order:${order.id}`, action: 'send' }}
            action={onAdvance}
          >
            <input name="purchaseOrderId" type="hidden" value={order.id} />
            <input name="action" type="hidden" value="send" />
            <SubmitButton>Send to supplier</SubmitButton>
            <p className="mt-2 text-sm text-text-muted">
              The supplier&rsquo;s authorization and licence are checked again at this moment;
              either can have lapsed since the order was drafted.
            </p>
          </PurchasingActionForm>
        ) : null}

        {order.status === 'SENT' || order.status === 'RECEIVING' ? (
          <a
            className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
            href={`${PURCHASING_ROUTE}/receiving?order=${encodeURIComponent(order.id)}${
              order.branchId ? `&branch=${encodeURIComponent(order.branchId)}` : ''
            }`}
          >
            Receive against this order
          </a>
        ) : null}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Line slots
// ---------------------------------------------------------------------------

/**
 * A medicine and a pack in one control. The pack option carries the derived
 * conversion in its own value, so `canonicalUnitsPerPack` is never typed and
 * never has to be looked up a second time on the server (UX rule 1).
 */
function packOptions(medicines: MedicineOption[]) {
  return medicines.flatMap((medicine) =>
    medicine.packs.map((pack) => ({
      value: `${medicine.id}|${pack.packLevelId}|${pack.canonicalUnitsPerPack}`,
      label: `${medicine.productName} — ${pack.level} (${pack.conversionLabel})`,
    }))
  );
}

function RequisitionLineSlot({
  slot,
  medicines,
  notice,
}: {
  slot: number;
  medicines: MedicineOption[];
  notice: Notice | null;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
      <SelectField
        emptyHint="No medicine has an effective pack level."
        label={`Line ${slot + 1} — medicine and pack`}
        name={`medicineId-${slot}`}
        notice={notice}
        options={packOptions(medicines)}
        placeholder="Skip this line"
      />
      <TextField
        inputMode="numeric"
        label="Packs"
        min={1}
        name={`quantityPacks-${slot}`}
        notice={notice}
        type="number"
      />
    </div>
  );
}

function OrderLineSlot({
  slot,
  medicines,
  notice,
}: {
  slot: number;
  medicines: MedicineOption[];
  notice: Notice | null;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      <SelectField
        className="lg:col-span-2"
        emptyHint="No medicine has an effective pack level."
        label={`Line ${slot + 1} — medicine and pack`}
        name={`orderMedicineId-${slot}`}
        notice={notice}
        options={packOptions(medicines)}
        placeholder="Skip this line"
      />
      <TextField
        inputMode="numeric"
        label="Packs"
        min={1}
        name={`orderedPacks-${slot}`}
        notice={notice}
        type="number"
      />
      <TextField
        inputMode="numeric"
        label="Free packs"
        min={0}
        name={`bonusPacks-${slot}`}
        notice={notice}
        type="number"
      />
      <TextField
        inputMode="decimal"
        label="List price / pack (PKR)"
        name={`listPrice-${slot}`}
        notice={notice}
      />
      <TextField
        inputMode="decimal"
        label="Discount %"
        name={`orderDiscount-${slot}`}
        notice={notice}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form readers
// ---------------------------------------------------------------------------

/** `medicineId|packLevelId|canonicalUnitsPerPack`, as emitted by `packOptions`. */
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

function readLineSlots(form: FormData) {
  return LINE_SLOTS.flatMap((slot) => {
    const pack = readPack(field(form, `medicineId-${slot}`));
    if (!pack) return [];
    return [
      {
        medicineId: pack.medicineId,
        packLevelId: pack.packLevelId,
        canonicalUnitsPerPack: pack.canonicalUnitsPerPack,
        quantityPacks: integerField(form, `quantityPacks-${slot}`, `Line ${slot + 1} packs`),
      },
    ];
  });
}

function readOrderLineSlots(form: FormData) {
  return LINE_SLOTS.flatMap((slot) => {
    const pack = readPack(field(form, `orderMedicineId-${slot}`));
    if (!pack) return [];
    return [
      {
        medicineId: pack.medicineId,
        packLevelId: pack.packLevelId,
        canonicalUnitsPerPack: pack.canonicalUnitsPerPack,
        orderedPacks: integerField(form, `orderedPacks-${slot}`, `Line ${slot + 1} packs`),
        bonusPacks: optionalIntegerField(
          form,
          `bonusPacks-${slot}`,
          `Line ${slot + 1} free packs`,
          0
        ),
        listPricePerPackMinor: moneyFieldMinor(
          form,
          `listPrice-${slot}`,
          `Line ${slot + 1} list price`
        ),
        discountBps: percentToBps(form, `orderDiscount-${slot}`, `Line ${slot + 1} discount`),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * UX rule 6: changing one selection keeps the other. A requisition chosen on
 * the left is still chosen after an order is picked on the right.
 */
function hrefWith(query: SearchQuery, next: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of ['req', 'po'] as const) {
    const value = param(query, key);
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(next)) params.set(key, value);
  return `${ROUTE}?${params}`;
}

function rowClass(current: boolean): string {
  return `flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 ${
    current ? 'border-primary bg-primary/5' : 'border-border-subtle hover:bg-muted'
  }`;
}
