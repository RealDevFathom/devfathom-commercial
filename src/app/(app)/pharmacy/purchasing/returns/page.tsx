import { FollowUpQueue } from './follow-up-queue';
import { supplierCreditFollowUp } from '@/lib/pharmacy/supplier-credit-follow-up';
import type { Metadata } from 'next';
import type * as React from 'react';
import { revalidatePath } from 'next/cache';
import { PurchasingActionForm } from '../_components/action-form';
import { PurchasingOutcomeScope, PurchasingOutcomes } from '../_components/action-outcomes';

import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { hasModule } from '@/lib/entitlements';
import type { PurchaseReturnDetail, PurchasingWorkspace } from '@/lib/pharmacy/purchasing-console';
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
  TextAreaField,
  TextField,
} from '../_components/form-controls';
import {
  purchasingOutcome,
  PurchasingValidationError,
  dateField,
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
  param,
  purchasingCaller,
  PURCHASING_ROUTE,
  tenantContext,
  today,
  units,
  type Notice,
  type SearchQuery,
} from '../_lib/console';

export const metadata: Metadata = { title: 'Returns & claims · Pharmacy purchasing' };

const ROUTE = `${PURCHASING_ROUTE}/returns`;
const HEADING = 'Returns & claims';
const DESCRIPTION =
  'Purchase returns and expiry claims, the supplier return window each one is racing, the debit notes they raise and the credit that has actually arrived against them.';

const RETURN_SLOTS = [0, 1, 2] as const;

/**
 * PUR-06 — returns, expiry claims, debit notes and supplier credit.
 *
 * The board leads with the window rather than the document, because the window
 * is the thing that expires: `assertReturnWindowOpen` refuses a dispatch after
 * the deadline, so a claim that is submitted but not dispatched in time becomes
 * stock nobody can sell and nobody will be credited for. Expected and received
 * credit are shown side by side and never collapsed into one figure — they come
 * from two different sources and disagreeing is the useful signal.
 */
export default async function PharmacyReturnsPage({
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

  let workspace: PurchasingWorkspace;
  try {
    workspace = await caller.workspace();
  } catch {
    return (
      <Frame notice={notice}>
        <LoadFailure detail="The returns board could not load its pickers." retryHref={ROUTE} />
      </Frame>
    );
  }

  const scope = resolveBranch(workspace.branches, param(query, 'branch'));
  if (scope.kind === 'none') {
    return (
      <Frame notice={notice}>
        <NoBranchState surface="Returns & claims" />
      </Frame>
    );
  }
  if (scope.kind === 'unchosen') {
    return (
      <Frame notice={notice}>
        <ChooseBranchState branches={scope.branches} route={ROUTE} surface="Returns & claims" />
      </Frame>
    );
  }

  const branchId = scope.branch.id;
  let returns: PurchaseReturnDetail[];
  let lots: Awaited<ReturnType<typeof caller.returnableLots>>;
  let credits: Awaited<ReturnType<typeof caller.supplierCredits>>;
  try {
    [returns, lots, credits] = await Promise.all([
      caller.purchaseReturns({ branchId }),
      caller.returnableLots({ branchId }),
      caller.supplierCredits({ branchId }),
    ]);
  } catch {
    return (
      <Frame branch={scope} notice={notice}>
        <LoadFailure
          detail="Returns for this branch could not be read. This read failure does not confirm or undo earlier changes. Check their outcomes before retrying."
          retryHref={`${ROUTE}?branch=${encodeURIComponent(branchId)}`}
        />
      </Frame>
    );
  }

  const selected = returns.find((row) => row.id === param(query, 'return')) ?? null;

  // The credit position across the branch, kept as two separately sourced
  // numbers rather than one that has been overwritten.
  const expectedMinor = returns
    .flatMap((row) => row.debitNotes)
    .reduce((total, note) => total + note.position.expectedCreditMinor, 0);
  const receivedMinor = returns
    .flatMap((row) => row.debitNotes)
    .reduce((total, note) => total + note.position.receivedCreditMinor, 0);
  const closingSoon = returns.filter(
    (row) =>
      row.status !== 'SETTLED' &&
      row.status !== 'CANCELLED' &&
      row.lines.some((line) => line.windowState !== 'OPEN')
  );

  const openDebitNotes = returns
    .flatMap((row) => row.debitNotes.map((note) => ({ note, ret: row })))
    .filter(({ note }) => note.position.outstandingMinor > 0);

  // ── actions ───────────────────────────────────────────────────────────────

  async function createReturn(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const lines = RETURN_SLOTS.flatMap((slot) => {
        const picked = field(form, `lot-${slot}`);
        if (!picked) return [];
        const [inventoryLotId, stockLocationId] = picked.split('|');
        if (!inventoryLotId || !stockLocationId) return [];
        return [
          {
            inventoryLotId,
            stockLocationId,
            quantityUnits: integerField(form, `quantityUnits-${slot}`, `Line ${slot + 1} quantity`),
            reason: field(form, `reason-${slot}`),
            returnWindowEndsAt: dateField(
              form,
              `returnWindowEndsAt-${slot}`,
              `Line ${slot + 1} return window`
            ),
            expectedCreditMinor: moneyFieldMinor(
              form,
              `expectedCredit-${slot}`,
              `Line ${slot + 1} expected credit`
            ),
          },
        ];
      });
      if (lines.length === 0) {
        throw Object.assign(new PurchasingValidationError('Choose at least one lot to return.'), {
          field: 'lot-0',
        });
      }
      const created = await outcome.write(actionCaller.createPurchaseReturn)({
        branchId: branch,
        supplierId: field(form, 'supplierId'),
        kind: field(form, 'kind') === 'EXPIRY_CLAIM' ? 'EXPIRY_CLAIM' : 'PURCHASE_RETURN',
        reference: field(form, 'reference'),
        note: optionalField(form, 'note'),
        lines,
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: `${created.reference} drafted. A draft reserves nothing, so the stock is still saleable until you submit it.`,
          kind: 'success',
        },
        { branch, return: created.id }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not draft the return.'), kind: 'error' },
        { branch }
      );
    }
    return next;
  }

  async function advanceReturn(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const purchaseReturnId = field(form, 'purchaseReturnId');
    const action = field(form, 'action');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      let message: string;
      if (action === 'submit') {
        await outcome.write(actionCaller.submitPurchaseReturn)({
          branchId: branch,
          purchaseReturnId,
        });
        message = 'Return submitted. The quantity is reserved and can no longer be sold.';
      } else if (action === 'dispatch') {
        await outcome.write(actionCaller.dispatchPurchaseReturn)({
          branchId: branch,
          purchaseReturnId,
          // The reservation is already unique per return, so the document's own
          // id is a stable idempotency key: a retried dispatch cannot post the
          // movements twice.
          idempotencyKey: `return-dispatch:${purchaseReturnId}`,
        });
        message = 'Return dispatched. The stock has left and the reservation is released.';
      } else if (action === 'debit') {
        await outcome.write(actionCaller.issueDebitNote)({
          branchId: branch,
          purchaseReturnId,
          reference: field(form, 'debitReference'),
        });
        message = 'Debit note issued. Expected credit is frozen from the return lines.';
      } else {
        throw new PurchasingValidationError('Unknown action.');
      }
      revalidatePath(ROUTE);
      next = destination(ROUTE, { message, kind: 'success' }, { branch, return: purchaseReturnId });
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not move the return on.'), kind: 'error' },
        { branch, return: purchaseReturnId }
      );
    }
    return next;
  }

  async function recordCredit(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.recordSupplierCredit)({
        branchId: branch,
        supplierId: field(form, 'supplierId'),
        reference: field(form, 'creditReference'),
        amountMinor: moneyFieldMinor(form, 'amount', 'Credit amount'),
        receivedAt: dateField(form, 'receivedAt', 'Received on'),
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: 'Credit recorded. Allocate it against a debit note to settle one.',
          kind: 'success',
        },
        { branch }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not record the credit.'), kind: 'error' },
        { branch }
      );
    }
    return next;
  }

  async function allocateCredit(form: FormData) {
    'use server';
    const branch = field(form, 'branchId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.allocateSupplierCredit)({
        branchId: branch,
        supplierCreditId: field(form, 'supplierCreditId'),
        debitNoteId: field(form, 'debitNoteId'),
        amountMinor: moneyFieldMinor(form, 'amountMinor', 'Amount'),
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        { message: 'Credit allocated. The debit note position has moved.', kind: 'success' },
        { branch, return: optionalField(form, 'purchaseReturnId') }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not allocate the credit.'), kind: 'error' },
        { branch, return: optionalField(form, 'purchaseReturnId') }
      );
    }
    return next;
  }

  return (
    <Frame branch={scope} notice={notice}>
      <div className="grid gap-6 sm:grid-cols-4">
        <Stat label="Expected credit" value={money(expectedMinor)} sub="Frozen at issue" />
        <Stat label="Received credit" value={money(receivedMinor)} sub="Allocated from suppliers" />
        <Stat
          label="Variance"
          value={money(expectedMinor - receivedMinor)}
          sub="Positive means still owed"
          deltaDirection={expectedMinor - receivedMinor > 0 ? 'down' : 'flat'}
        />
        <Stat label="Windows closing" value={closingSoon.length} sub="Within 7 days or past" />
      </div>

      <FollowUpQueue
        branchId={branchId}
        queue={supplierCreditFollowUp({
          scope: { organizationId: ctx.entitlements.organizationId, branchId },
          returns,
          credits,
          asOf: new Date(),
          // Existing server-side read projections return all rows in the authorized branch.
          coverage: 'complete',
        })}
      />

      {/* ── the near-expiry board's return windows ─────────────────────────── */}
      <SectionCard eyebrow="PUR-06" title="Return windows" titleLevel={2}>
        {closingSoon.length === 0 ? (
          <EmptyState
            title="No return window is closing"
            detail="Every open return and claim at this branch still has more than a week of its supplier window left. A window that closes before dispatch cannot be credited, so this board leads with the deadline rather than the document."
          />
        ) : (
          <ul className="space-y-2">
            {closingSoon.map((row) => (
              <li
                className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning/5 p-3"
                key={row.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <a
                    className="font-medium text-text-strong underline-offset-4 hover:underline focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                    href={linkTo(branchId, { return: row.id })}
                  >
                    {row.reference} — {row.supplier.name}
                  </a>
                  <StatusPill status={row.status} />
                </div>
                <ul className="mt-2 space-y-1">
                  {row.lines
                    .filter((line) => line.windowState !== 'OPEN')
                    .map((line) => (
                      <li className="text-xs text-text-muted" key={line.id}>
                        {line.lot.batch.medicine.productName} · batch {line.lot.batch.batchNumber} ·{' '}
                        {line.windowState === 'CLOSED'
                          ? `window closed ${Math.abs(line.daysToWindowEnd)} days ago — this line can no longer be dispatched for credit`
                          : `window closes in ${line.daysToWindowEnd} days (${dateOnly(line.returnWindowEndsAt)})`}
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,11fr)] xl:items-start">
        <SectionCard eyebrow="PUR-06" title={`Returns & claims (${returns.length})`} titleLevel={2}>
          {returns.length === 0 ? (
            <EmptyState
              title="Nothing is going back to a supplier"
              detail="Raise a purchase return for goods you are sending back, or an expiry claim for stock the supplier agreed to take on expiry. Both use the same document and the same settlement path."
            />
          ) : (
            <ul className="space-y-2">
              {returns.map((row) => (
                <li key={row.id}>
                  <a
                    aria-current={row.id === selected?.id ? 'true' : undefined}
                    className={`flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 ${
                      row.id === selected?.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border-subtle hover:bg-muted'
                    }`}
                    href={linkTo(branchId, { return: row.id })}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-text-strong">
                        {row.reference}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {row.supplier.name} ·{' '}
                        {row.kind === 'EXPIRY_CLAIM' ? 'Expiry claim' : 'Purchase return'} ·{' '}
                        {row.lines.length} line{row.lines.length === 1 ? '' : 's'}
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
          {selected ? (
            <ReturnDetail
              branchId={branchId}
              credits={credits}
              notice={notice}
              onAdvance={advanceReturn}
              onAllocate={allocateCredit}
              purchaseReturn={selected}
            />
          ) : (
            <SectionCard title="No return selected" titleLevel={2}>
              <EmptyState
                title="Pick a return to work it"
                detail="Its lines, their return windows, the debit notes it raised and the credit received against them open here, beside the list."
              />
            </SectionCard>
          )}

          <SectionCard eyebrow="PUR-06" title="Raise a return or expiry claim" titleLevel={2}>
            {lots.length === 0 ? (
              <EmptyState
                title="No available stock to return"
                detail="A return is raised against a lot that is on hand and available at this branch. Nothing here qualifies — quarantined and already-claimed quantities are deliberately not offered."
                steps={[
                  { label: 'Open the goods-in bench', href: `${PURCHASING_ROUTE}/receiving` },
                ]}
              />
            ) : (
              <PurchasingActionForm
                operation={{ resource: `return:new:${branchId}`, action: 'create' }}
                action={createReturn}
                className="space-y-4"
              >
                <input name="branchId" type="hidden" value={branchId} />
                <div className="grid gap-4 sm:grid-cols-3">
                  <TextField label="Reference" name="reference" notice={notice} required />
                  <SelectField
                    emptyHint="No suppliers yet — add one on the supplier page."
                    label="Supplier"
                    name="supplierId"
                    notice={notice}
                    options={workspace.suppliers.map((supplier) => ({
                      value: supplier.id,
                      label: supplier.name,
                    }))}
                    required
                  />
                  <SelectField
                    defaultValue="PURCHASE_RETURN"
                    emptyHint="—"
                    label="Kind"
                    name="kind"
                    notice={notice}
                    options={[
                      { value: 'PURCHASE_RETURN', label: 'Purchase return' },
                      { value: 'EXPIRY_CLAIM', label: 'Expiry claim' },
                    ]}
                  />
                </div>
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-text-body">
                    Lots — leave a slot empty to skip it
                  </legend>
                  {RETURN_SLOTS.map((slot) => (
                    <div
                      className="grid gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-3 sm:grid-cols-2 lg:grid-cols-5"
                      key={slot}
                    >
                      <SelectField
                        className="lg:col-span-2"
                        emptyHint="No available lot at this branch."
                        label={`Line ${slot + 1} — lot`}
                        name={`lot-${slot}`}
                        notice={notice}
                        options={lots.map((balance) => ({
                          value: `${balance.lot.id}|${balance.location.id}`,
                          label: `${balance.lot.batch.medicine.productName} · batch ${balance.lot.batch.batchNumber} · expires ${dateOnly(balance.lot.batch.expiresAt)} · ${balance.onHandUnits} available in ${balance.location.name}`,
                        }))}
                        placeholder="Skip this line"
                      />
                      <TextField
                        inputMode="numeric"
                        label="Units"
                        min={1}
                        name={`quantityUnits-${slot}`}
                        notice={notice}
                        type="number"
                      />
                      <TextField
                        label="Return window ends"
                        name={`returnWindowEndsAt-${slot}`}
                        notice={notice}
                        type="date"
                        hint="The supplier's deadline."
                      />
                      <TextField
                        inputMode="decimal"
                        label="Expected credit (PKR)"
                        name={`expectedCredit-${slot}`}
                        notice={notice}
                      />
                      <TextField
                        className="lg:col-span-5"
                        label="Reason"
                        name={`reason-${slot}`}
                        notice={notice}
                      />
                    </div>
                  ))}
                </fieldset>
                <TextAreaField label="Note" name="note" notice={notice} />
                <SubmitButton>Draft return</SubmitButton>
                <Derived
                  label="Hold"
                  value="A draft reserves nothing. The stock stays saleable until the return is submitted."
                />
              </PurchasingActionForm>
            )}
          </SectionCard>

          <SectionCard eyebrow="PUR-06" title="Supplier credit" titleLevel={2}>
            <PurchasingActionForm
              operation={{ resource: `credit:new:${branchId}`, action: 'record' }}
              action={recordCredit}
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            >
              <input name="branchId" type="hidden" value={branchId} />
              <SelectField
                emptyHint="No suppliers yet."
                label="Supplier"
                name="supplierId"
                notice={notice}
                options={workspace.suppliers.map((supplier) => ({
                  value: supplier.id,
                  label: supplier.name,
                }))}
                required
              />
              <TextField
                label="Credit note reference"
                name="creditReference"
                notice={notice}
                required
              />
              <TextField
                inputMode="decimal"
                label="Amount (PKR)"
                name="amount"
                notice={notice}
                required
              />
              <TextField
                defaultValue={today()}
                label="Received on"
                name="receivedAt"
                notice={notice}
                required
                type="date"
              />
              <div className="sm:col-span-2 lg:col-span-4">
                <SubmitButton>Record credit</SubmitButton>
              </div>
            </PurchasingActionForm>

            {credits.length > 0 ? (
              <ul className="mt-5 space-y-2">
                {credits.map((credit) => {
                  const allocated = credit.allocations.reduce(
                    (total, allocation) => total + allocation.amountMinor,
                    0
                  );
                  const unallocated = credit.amountMinor - allocated;
                  return (
                    <li
                      className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
                      key={credit.id}
                      id={`credit-${encodeURIComponent(credit.id)}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-text-strong">
                          {credit.reference} — {credit.supplier.name}
                        </span>
                        <span className="font-mono text-sm tabular-nums text-text-strong">
                          {money(credit.amountMinor)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        Received {dateOnly(credit.receivedAt)} · {money(allocated)} allocated ·{' '}
                        {money(unallocated)} unallocated
                      </p>
                      {unallocated > 0 && openDebitNotes.length > 0 ? (
                        <PurchasingActionForm
                          operation={{ resource: `credit:${credit.id}`, action: 'allocate' }}
                          financialOperation="supplier-credit-allocation"
                          action={allocateCredit}
                          className="mt-3 flex flex-wrap items-end gap-3"
                        >
                          <input name="branchId" type="hidden" value={branchId} />
                          <input name="supplierCreditId" type="hidden" value={credit.id} />
                          <SelectField
                            className="min-w-64"
                            emptyHint="No debit note is owed anything."
                            label="Allocate to"
                            name="debitNoteId"
                            notice={notice}
                            options={openDebitNotes.map(({ note, ret }) => ({
                              value: note.id,
                              label: `${note.reference} — ${ret.reference} · ${money(note.position.outstandingMinor)} outstanding`,
                            }))}
                            required
                          />
                          <TextField
                            inputMode="decimal"
                            label="Amount (PKR)"
                            name="amountMinor"
                            notice={notice}
                            required
                          />
                          <SubmitButton variant="secondary">Allocate</SubmitButton>
                        </PurchasingActionForm>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="mt-5">
                <EmptyState
                  title="No credit received yet"
                  detail="Record a supplier's credit note here as it arrives. What the supplier actually paid is kept separate from what a debit note expected, so the two can be compared rather than one overwriting the other."
                />
              </div>
            )}
          </SectionCard>
        </div>
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
            Returning from{' '}
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

function ReturnDetail({
  purchaseReturn,
  credits,
  branchId,
  notice,
  onAdvance,
  onAllocate,
}: {
  purchaseReturn: PurchaseReturnDetail;
  credits: {
    id: string;
    reference: string;
    amountMinor: number;
    allocations: { amountMinor: number }[];
  }[];
  branchId: string;
  notice: Notice | null;
  onAdvance: (form: FormData) => Promise<string>;
  onAllocate: (form: FormData) => Promise<string>;
}) {
  const blockedByWindow = purchaseReturn.lines.some((line) => line.windowState === 'CLOSED');
  const spendable = credits.filter(
    (credit) =>
      credit.amountMinor -
        credit.allocations.reduce((total, allocation) => total + allocation.amountMinor, 0) >
      0
  );

  return (
    <SectionCard
      eyebrow="PUR-06"
      title={purchaseReturn.reference}
      titleLevel={2}
      actions={<StatusPill status={purchaseReturn.status} />}
    >
      <p className="text-sm text-text-muted">
        {purchaseReturn.supplier.name} ·{' '}
        {purchaseReturn.kind === 'EXPIRY_CLAIM' ? 'Expiry claim' : 'Purchase return'} · raised{' '}
        {dateOnly(purchaseReturn.createdAt)}
        {purchaseReturn.dispatchedAt
          ? ` · dispatched ${dateOnly(purchaseReturn.dispatchedAt)}`
          : ''}
      </p>

      <ul className="mt-4 space-y-2">
        {purchaseReturn.lines.map((line) => (
          <li className="rounded-[var(--radius-sm)] border border-border-subtle p-3" key={line.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-text-strong">
                {line.lot.batch.medicine.productName}
              </span>
              <StatusPill
                status={line.windowState}
                tone={
                  line.windowState === 'OPEN'
                    ? 'success'
                    : line.windowState === 'CLOSING'
                      ? 'warning'
                      : 'danger'
                }
                label={
                  line.windowState === 'CLOSED'
                    ? `Window closed ${Math.abs(line.daysToWindowEnd)}d ago`
                    : `Window ${line.daysToWindowEnd}d left`
                }
              />
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Batch {line.lot.batch.batchNumber} · expires {dateOnly(line.lot.batch.expiresAt)} ·{' '}
              {units(line.quantityUnits)} from {line.location.name} · expects{' '}
              {money(line.expectedCreditMinor)} · {line.reason}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {line.supplierClaimId
                ? 'Reserved: this quantity cannot be sold or claimed a second time.'
                : 'Not reserved yet — this quantity is still saleable.'}
            </p>
          </li>
        ))}
      </ul>

      {purchaseReturn.debitNotes.length > 0 ? (
        <div className="mt-5">
          <h4 className="text-sm font-medium text-text-strong">Debit notes</h4>
          <ul className="mt-2 space-y-2">
            {purchaseReturn.debitNotes.map((note) => (
              <li
                className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={note.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-strong">{note.reference}</span>
                  <StatusPill status={note.position.status} />
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  Issued {dateTime(note.issuedAt)} · expected{' '}
                  {money(note.position.expectedCreditMinor)} · received{' '}
                  {money(note.position.receivedCreditMinor)} · outstanding{' '}
                  {money(note.position.outstandingMinor)}
                  {note.position.varianceMinor < 0
                    ? ` · over-credited by ${money(Math.abs(note.position.varianceMinor))}`
                    : ''}
                </p>
                {note.position.outstandingMinor > 0 && spendable.length > 0 ? (
                  <PurchasingActionForm
                    operation={{ resource: `debit-note:${note.id}`, action: 'allocate' }}
                    financialOperation="supplier-credit-allocation"
                    action={onAllocate}
                    className="mt-3 flex flex-wrap items-end gap-3"
                  >
                    <input name="branchId" type="hidden" value={branchId} />
                    <input name="debitNoteId" type="hidden" value={note.id} />
                    <input name="purchaseReturnId" type="hidden" value={purchaseReturn.id} />
                    <SelectField
                      className="min-w-56"
                      emptyHint="No unallocated credit."
                      label="From credit"
                      name="supplierCreditId"
                      notice={notice}
                      options={spendable.map((credit) => ({
                        value: credit.id,
                        label: `${credit.reference} · ${money(credit.amountMinor)}`,
                      }))}
                      required
                    />
                    <TextField
                      inputMode="decimal"
                      label="Amount (PKR)"
                      name="amountMinor"
                      notice={notice}
                      required
                    />
                    <SubmitButton variant="secondary">Allocate</SubmitButton>
                  </PurchasingActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-5">
        {purchaseReturn.status === 'DRAFT' ? (
          <PurchasingActionForm
            operation={{ resource: `return:${purchaseReturn.id}`, action: 'submit' }}
            action={onAdvance}
          >
            <input name="branchId" type="hidden" value={branchId} />
            <input name="purchaseReturnId" type="hidden" value={purchaseReturn.id} />
            <input name="action" type="hidden" value="submit" />
            <SubmitButton>Submit and reserve the stock</SubmitButton>
          </PurchasingActionForm>
        ) : null}

        {purchaseReturn.status === 'SUBMITTED' ? (
          blockedByWindow ? (
            <p className="text-sm text-destructive" role="alert">
              At least one line&rsquo;s return window has closed, so this return can no longer be
              dispatched for credit. Cancel it and settle with the supplier directly, or raise a new
              return for the lines whose windows are still open.
            </p>
          ) : (
            <PurchasingActionForm
              operation={{ resource: `return:${purchaseReturn.id}`, action: 'dispatch' }}
              action={onAdvance}
            >
              <input name="branchId" type="hidden" value={branchId} />
              <input name="purchaseReturnId" type="hidden" value={purchaseReturn.id} />
              <input name="action" type="hidden" value="dispatch" />
              <SubmitButton>Dispatch to supplier</SubmitButton>
            </PurchasingActionForm>
          )
        ) : null}

        {purchaseReturn.status === 'DISPATCHED' && purchaseReturn.debitNotes.length === 0 ? (
          <PurchasingActionForm
            operation={{ resource: `return:${purchaseReturn.id}`, action: 'debit' }}
            action={onAdvance}
            className="flex flex-wrap items-end gap-3"
          >
            <input name="branchId" type="hidden" value={branchId} />
            <input name="purchaseReturnId" type="hidden" value={purchaseReturn.id} />
            <input name="action" type="hidden" value="debit" />
            <TextField
              className="min-w-56"
              label="Debit note reference"
              name="debitReference"
              notice={notice}
              required
            />
            <SubmitButton>Issue debit note</SubmitButton>
          </PurchasingActionForm>
        ) : null}
      </div>
    </SectionCard>
  );
}

function linkTo(branchId: string, next: Record<string, string>): string {
  const params = new URLSearchParams({ branch: branchId });
  for (const [key, value] of Object.entries(next)) params.set(key, value);
  return `${ROUTE}?${params}`;
}
