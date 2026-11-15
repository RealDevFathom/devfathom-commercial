import type { Metadata } from 'next';
import type * as React from 'react';
import { revalidatePath } from 'next/cache';
import { PurchasingActionForm } from '../_components/action-form';
import { PurchasingOutcomeScope, PurchasingOutcomes } from '../_components/action-outcomes';

import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { hasModule } from '@/lib/entitlements';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import type { PurchasingWorkspace } from '@/lib/pharmacy/purchasing-console';
import {
  confirmedReorderLines,
  ReorderConfirmationError,
  REORDER_DEFAULT_COVER_DAYS,
  REORDER_DEFAULT_WINDOW_DAYS,
  REORDER_MAX_PACKS,
  type ReorderPlan,
} from '@/lib/pharmacy/reorder-drafts';
import {
  BranchPicker,
  ChooseBranchState,
  NoBranchState,
  resolveBranch,
  UnassignedBranchState,
} from '../_components/branch-scope';
import {
  AccessState,
  EmptyState,
  LoadFailure,
  NoticeBanner,
  PurchasingHeader,
  PurchasingTabs,
} from '../_components/console-chrome';
import { CONTROL, fieldInvalid, SubmitButton, TextField } from '../_components/form-controls';
import {
  purchasingOutcome,
  PurchasingValidationError,
  destination,
  field,
  integerField,
  money,
  noticeFrom,
  NO_ACTOR,
  param,
  purchasingCaller,
  PURCHASING_ROUTE,
  tenantContext,
  type Notice,
  type SearchQuery,
} from '../_lib/console';

export const metadata: Metadata = { title: 'Reorder · Pharmacy purchasing' };

const ROUTE = `${PURCHASING_ROUTE}/reorder`;
const ORDERS_ROUTE = `${PURCHASING_ROUTE}/orders`;
const HEADING = 'Reorder';
const DESCRIPTION =
  'Suggested orders worked out from recorded sales, stock and distributor lead times, one draft per distributor. Nothing is ordered or sent until you confirm it.';

const LEAD_TIME_LABEL = {
  LAST_ORDER_TERMS: 'Last order terms',
  OBSERVED_DELIVERIES: 'Past deliveries',
  DEFAULT: 'Default',
} as const;

/** A whole number from the URL inside [min, max], or the default. */
function boundedDays(raw: string | undefined, min: number, max: number, fallback: number) {
  if (!raw || !/^\d{1,3}$/.test(raw)) return fallback;
  const value = Number(raw);
  return value >= min && value <= max ? value : fallback;
}

function suggestedReference(index: number, at: Date) {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `RO-${stamp}-${index + 1}`.slice(0, 100);
}

/**
 * DEV-678 — draft reorder → distributor purchase order. The board reads one
 * server-computed plan; confirming a distributor's draft re-reads that plan on
 * the server, takes only the packs from the form, and raises an ordinary DRAFT
 * purchase order. Submitting, approving and sending (WhatsApp or PDF) stay on
 * the orders board, each a separate person-confirmed step.
 */
export default async function PharmacyReorderPage({
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
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled />;
  }

  let workspace: PurchasingWorkspace & { reachableBranchIds?: readonly string[] };
  try {
    workspace = await caller.workspace();
  } catch {
    return (
      <Frame notice={notice}>
        <LoadFailure detail="The reorder board could not load its pickers." retryHref={ROUTE} />
      </Frame>
    );
  }
  const reachable = workspace.reachableBranchIds;
  const branches = reachable
    ? workspace.branches.filter((branch) => reachable.includes(branch.id))
    : workspace.branches;
  if (workspace.branches.length > 0 && branches.length === 0) {
    return (
      <Frame notice={notice}>
        <UnassignedBranchState surface="Reorder" />
      </Frame>
    );
  }
  const scope = resolveBranch(branches, param(query, 'branch'));
  if (scope.kind === 'none') {
    return (
      <Frame notice={notice}>
        <NoBranchState surface="Reorder" />
      </Frame>
    );
  }
  if (scope.kind === 'unchosen') {
    return (
      <Frame notice={notice}>
        <ChooseBranchState branches={scope.branches} route={ROUTE} surface="Reorder" />
      </Frame>
    );
  }

  const branchId = scope.branch.id;
  const windowDays = boundedDays(param(query, 'days'), 1, 90, REORDER_DEFAULT_WINDOW_DAYS);
  const coverDays = boundedDays(param(query, 'cover'), 0, 90, REORDER_DEFAULT_COVER_DAYS);
  const keep = { branch: branchId, days: String(windowDays), cover: String(coverDays) };
  const assignedOnly = branches.length < workspace.branches.length;

  let plan: ReorderPlan;
  try {
    plan = await caller.reorderDrafts({ branchId, windowDays, coverDays });
  } catch {
    return (
      <Frame assignedOnly={assignedOnly} branch={scope} notice={notice}>
        <LoadFailure
          detail="Reorder suggestions for this branch could not be read. Nothing was ordered."
          retryHref={`${ROUTE}?${new URLSearchParams(keep)}`}
        />
      </Frame>
    );
  }

  /**
   * Server Function: reachable by direct POST, so it re-resolves the actor and
   * re-reads the plan. Only the pack counts and the reference come from the
   * form; medicine, pack level and purchase terms come from the server's draft,
   * and `createPurchaseOrder` applies every supplier, branch and money check.
   */
  async function confirmDraft(form: FormData) {
    'use server';
    const outcome = purchasingOutcome();
    const branch = field(form, 'branchId');
    const supplierId = field(form, 'supplierId');
    const days = boundedDays(field(form, 'days'), 1, 90, REORDER_DEFAULT_WINDOW_DAYS);
    const cover = boundedDays(field(form, 'cover'), 0, 90, REORDER_DEFAULT_COVER_DAYS);
    const back = { branch, days: String(days), cover: String(cover) };
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const current = await actionCaller.reorderDrafts({
        branchId: branch,
        windowDays: days,
        coverDays: cover,
      });
      const draft = current.drafts.find((row) => row.supplierId === supplierId);
      if (!draft)
        throw new PurchasingValidationError(
          'This distributor no longer has a reorder suggestion. The board has been refreshed.'
        );
      const packs = new Map<string, number>();
      for (const line of draft.lines) {
        const name = `packs-${line.medicineId}`;
        if (form.has(name))
          packs.set(line.medicineId, integerField(form, name, `Packs of ${line.medicineName}`));
      }
      let lines;
      try {
        lines = confirmedReorderLines(draft, packs);
      } catch (error) {
        if (error instanceof ReorderConfirmationError)
          throw Object.assign(new PurchasingValidationError(error.message), {
            field: error.field,
          });
        throw error;
      }
      const reference = field(form, 'reference');
      if (!reference)
        throw Object.assign(new PurchasingValidationError('Reference: enter a reference.'), {
          field: 'reference',
        });
      const created = await outcome.write(actionCaller.createPurchaseOrder)({
        reference,
        supplierId: draft.supplierId,
        branchId: branch,
        note: `Drafted from reorder suggestions: ${days} days of sales, ${cover} days of cover. Confirmed by staff.`,
        lines,
      });
      revalidatePath(ROUTE);
      revalidatePath(ORDERS_ROUTE);
      next = destination(
        ORDERS_ROUTE,
        {
          message: `Order ${created.reference} drafted for ${draft.supplierName}. Submit it for approval; send it by WhatsApp or PDF once approved.`,
          kind: 'success',
        },
        { po: created.id }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not draft the order.'), kind: 'error' },
        back
      );
    }
    return next;
  }

  const lineCount = plan.drafts.reduce((total, draft) => total + draft.lines.length, 0);
  const now = new Date();

  return (
    <Frame assignedOnly={assignedOnly} branch={scope} keep={keep} notice={notice}>
      <SectionCard eyebrow="How it is worked out" title="Reorder settings" titleLevel={2}>
        <form action={ROUTE} className="flex flex-wrap items-end gap-3" method="get">
          <input name="branch" type="hidden" value={branchId} />
          <label className="min-w-0 text-sm font-medium text-text-body" htmlFor="reorder-days">
            Days of sales history
            <input
              className={`${CONTROL} mt-1 w-32`}
              defaultValue={windowDays}
              id="reorder-days"
              inputMode="numeric"
              max={90}
              min={1}
              name="days"
              type="number"
            />
          </label>
          <label className="min-w-0 text-sm font-medium text-text-body" htmlFor="reorder-cover">
            Days of cover after delivery
            <input
              className={`${CONTROL} mt-1 w-32`}
              defaultValue={coverDays}
              id="reorder-cover"
              inputMode="numeric"
              max={90}
              min={0}
              name="cover"
              type="number"
            />
          </label>
          <button
            className="min-h-11 rounded-[var(--radius-sm)] border border-border-default px-4 text-sm font-medium text-text-strong hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
            type="submit"
          >
            Recalculate
          </button>
        </form>
        <p className="mt-3 max-w-3xl text-sm text-text-muted">
          For each medicine sold here: units needed = units sold ÷ {windowDays} days × (distributor
          lead time + {coverDays} days), less available stock and units already on order, rounded up
          to whole packs. Purchase prices are the distributor&rsquo;s last approved order; selling
          prices are never changed.
        </p>
      </SectionCard>

      <div className="grid gap-6 sm:grid-cols-3">
        <Stat label="Distributor drafts" value={plan.drafts.length} sub="One per distributor" />
        <Stat label="Lines to review" value={lineCount} sub="Edit packs before confirming" />
        <Stat
          label="No distributor on record"
          value={plan.unassigned.length}
          sub="Short, but not drafted"
        />
      </div>

      {plan.drafts.length === 0 ? (
        <SectionCard title="Nothing to reorder" titleLevel={2}>
          <EmptyState
            title="No medicine is running short"
            detail={`Stock and open orders cover the last ${windowDays} days of sales for ${coverDays} days beyond each distributor's lead time.${plan.unassigned.length ? ' Medicines with no distributor on record are listed below.' : ''}`}
            steps={[{ label: 'Open requisitions & orders', href: ORDERS_ROUTE }]}
          />
        </SectionCard>
      ) : (
        plan.drafts.map((draft, index) => (
          <SectionCard
            eyebrow="Draft · not sent"
            key={draft.supplierId}
            title={draft.supplierName}
            titleLevel={2}
          >
            <PurchasingActionForm
              action={confirmDraft}
              className="space-y-4"
              operation={{ resource: `reorder:${draft.supplierId}`, action: 'create' }}
            >
              <input name="branchId" type="hidden" value={branchId} />
              <input name="supplierId" type="hidden" value={draft.supplierId} />
              <input name="days" type="hidden" value={windowDays} />
              <input name="cover" type="hidden" value={coverDays} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <caption className="sr-only">Suggested lines for {draft.supplierName}</caption>
                  <thead>
                    <tr className="border-b border-border-subtle text-left font-mono text-xs uppercase text-text-muted">
                      <th className="py-2 pr-3 font-medium" scope="col">
                        Medicine
                      </th>
                      <th className="py-2 pr-3 text-right font-medium" scope="col">
                        Sold
                      </th>
                      <th className="py-2 pr-3 text-right font-medium" scope="col">
                        Available
                      </th>
                      <th className="py-2 pr-3 text-right font-medium" scope="col">
                        On order
                      </th>
                      <th className="py-2 pr-3 text-right font-medium" scope="col">
                        Lead time
                      </th>
                      <th className="py-2 pr-3 text-right font-medium" scope="col">
                        Price / pack
                      </th>
                      <th className="py-2 text-right font-medium" scope="col">
                        Packs
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.lines.map((line) => {
                      const name = `packs-${line.medicineId}`;
                      const invalid = fieldInvalid(notice, name);
                      return (
                        <tr
                          className="border-b border-border-subtle align-top last:border-0 hover:bg-muted/40"
                          key={line.medicineId}
                        >
                          <td className="py-3 pr-3">
                            <span className="block font-medium text-text-strong">
                              {line.medicineName}
                            </span>
                            <span className="mt-1 block max-w-md text-xs text-text-muted">
                              {line.explanation}
                            </span>
                            {invalid ? (
                              <span
                                className="mt-1 block text-sm text-destructive"
                                id={`${name}-error`}
                              >
                                {notice!.message}
                              </span>
                            ) : null}
                          </td>
                          <td className="py-3 pr-3 text-right tabular-nums">{line.soldUnits}</td>
                          <td className="py-3 pr-3 text-right tabular-nums">{line.onHandUnits}</td>
                          <td className="py-3 pr-3 text-right tabular-nums">{line.inboundUnits}</td>
                          <td className="py-3 pr-3 text-right">
                            <span className="block tabular-nums">{line.leadTimeDays} d</span>
                            <span className="block text-xs text-text-muted">
                              {LEAD_TIME_LABEL[line.leadTimeSource]}
                            </span>
                          </td>
                          <td className="py-3 pr-3 text-right tabular-nums">
                            {money(line.listPricePerPackMinor)}
                          </td>
                          <td className="py-3 text-right">
                            <label className="sr-only" htmlFor={`field-${name}`}>
                              Packs of {line.medicineName} (pack of {line.canonicalUnitsPerPack})
                            </label>
                            <input
                              aria-describedby={invalid ? `${name}-error` : undefined}
                              aria-invalid={invalid}
                              autoFocus={invalid}
                              className={`${CONTROL} w-24 text-right tabular-nums`}
                              defaultValue={line.suggestedPacks}
                              id={`field-${name}`}
                              inputMode="numeric"
                              max={REORDER_MAX_PACKS}
                              min={0}
                              name={name}
                              type="number"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <TextField
                  className="w-full sm:max-w-xs"
                  defaultValue={suggestedReference(index, now)}
                  label="Reference"
                  name="reference"
                  notice={notice}
                  required
                />
                <p className="text-sm text-text-muted">
                  Suggested list value{' '}
                  <span className="font-medium text-text-strong tabular-nums">
                    {money(draft.listValueMinor)}
                  </span>{' '}
                  before discount and tax. Set packs to 0 to leave a line out.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <SubmitButton>Confirm draft order</SubmitButton>
                <span className="text-sm text-text-muted">
                  Saves a draft purchase order. It is not submitted, approved or sent.
                </span>
              </div>
            </PurchasingActionForm>
          </SectionCard>
        ))
      )}

      {plan.unassigned.length > 0 ? (
        <SectionCard
          eyebrow="Needs a distributor"
          title="Short, with no distributor on record"
          titleLevel={2}
        >
          <p className="text-sm text-text-muted">
            These medicines are running short, but no approved order from an active distributor
            records their pack and price. Draft an ad-hoc order for them once.
          </p>
          <ul className="mt-4 space-y-2">
            {plan.unassigned.map((row) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={row.medicineId}
              >
                <span className="min-w-0">
                  <span className="block font-medium text-text-strong">{row.medicineName}</span>
                  <span className="block text-xs text-text-muted">
                    Short {row.shortfallUnits} units
                  </span>
                </span>
                <StatusPill
                  status={
                    row.reason === 'SUPPLIER_INACTIVE' ? 'Distributor inactive' : 'No distributor'
                  }
                  tone="warning"
                />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </Frame>
  );
}

function Frame({
  assignedOnly = false,
  branch,
  keep,
  notice,
  children,
}: {
  assignedOnly?: boolean;
  branch?: ReturnType<typeof resolveBranch>;
  keep?: Record<string, string | undefined>;
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
            Reordering for{' '}
            <span className="font-medium text-text-strong">{branch.branch.name}</span>
            {branch.implicit
              ? assignedOnly
                ? ' — the only branch you are assigned to.'
                : ' — the only active branch in this workspace.'
              : '.'}
          </p>
          <BranchPicker
            branches={branch.branches}
            keep={{ days: keep?.days, cover: keep?.cover }}
            route={ROUTE}
            selected={branch.branch.id}
          />
        </div>
      ) : null}
      <NoticeBanner notice={notice} />
      <PurchasingOutcomes />
      {children}
    </PurchasingOutcomeScope>
  );
}
