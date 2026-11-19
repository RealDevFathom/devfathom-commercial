import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  AP_AGING_BUCKET_LABELS,
  AP_AGING_BUCKETS,
  AP_AGING_MAX_INVOICES,
  apAgingCsv,
  type ApAgingView,
} from '@/lib/pharmacy/accounts/ap-aging';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyApInvoicesRouter } from '@/server/routers/pharmacy-ap-invoices';
import { createTRPCContext } from '@/server/trpc';
import {
  formatWorkspaceDateTime,
  workspaceMinuteInput,
  workspaceToday,
  workspaceZoneLabel,
} from '@/lib/timezone';
import { parseMajorToMinor } from '@/lib/pharmacy/khata-payment-slip';
import type { ApReversalCursor } from '@/lib/pharmacy/accounts/ap-invoices-schema';
import { PayApInvoiceForm, RecordApInvoiceForm } from './ap-entry-forms';
import { ExportCsv } from './export-csv';
import {
  CreditSetOff,
  DueBillReminders,
  minor,
  PaymentDraft,
  type PayablesDrafts,
  type PendingSetOffs,
} from './payables-panels';
import { BranchSelect, loadBranchOptions, type BranchOption } from '../branch-picker';
import { parseAgingQuery, parseReversalSearch, type AgingQuery as Query } from './query';
import { ReversalPanel, type ReversalAccess, type ReversibleInvoices } from './reversal-panel';

export const metadata: Metadata = { title: 'Supplier expense invoice aging · Pharmacy accounts' };

type State =
  | { kind: 'initial' }
  | { kind: 'invalid' }
  | { kind: 'denied' }
  | { kind: 'failure' }
  | { kind: 'loaded'; branchId: string; view: ApAgingView; retrievedAt: Date };

/** DEV-103: the reversal list loads separately too; its failure never hides the aging. */
type Reversals =
  | { kind: 'none' }
  | { kind: 'failure' }
  | {
      kind: 'loaded';
      invoices: ReversibleInvoices;
      older: ApReversalCursor | null;
      newer: ApReversalCursor | null;
      access: ReversalAccess;
    };

/** DEV-694: the payables drafts load separately, so their failure never hides the aging. */
type Payables =
  | { kind: 'none' }
  | { kind: 'failure' }
  | { kind: 'loaded'; drafts: PayablesDrafts; pending: PendingSetOffs; approved: PendingSetOffs };

/** DEV-694: the optional payment-draft request (payee, currency, budget in major units). */
function paymentDraftQuery(query: Query) {
  const single = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);
  const payee = single(query.payee);
  const currency = single(query.currency) === 'USD' ? 'USD' : 'PKR';
  const budget = single(query.budget);
  const budgetMinor = budget ? parseMajorToMinor(budget) : 0;
  if (!payee || payee.length > 200 || budgetMinor <= 0 || budgetMinor > 2_000_000_000) {
    return { currency, payee, budget };
  }
  return { currency, payee, budget, request: { name: payee, currency, budgetMinor } };
}

/** DEV-694: the optional one-payee filter that narrows a view above the ceiling. */
function payeeFilterQuery(query: Query) {
  const value = typeof query.payeeFilter === 'string' ? query.payeeFilter.trim() : '';
  return value && value.length <= 160 ? value : undefined;
}

function QueryForm({
  branchId,
  branches,
  asOf,
  zone,
  payeeFilter,
}: {
  branchId?: string;
  branches: BranchOption[];
  asOf: string;
  zone: string;
  payeeFilter?: string;
}) {
  return (
    <SectionCard title="Branch and date" titleLevel={2}>
      <form method="get" className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <label className="grid gap-2 text-sm">
          Branch
          <BranchSelect branchId={branchId} branches={branches} describedBy="aging-help" />
        </label>
        <label className="grid gap-2 text-sm">
          As of ({zone} day)
          <Input className="min-h-11" type="date" name="asOf" defaultValue={asOf} required />
        </label>
        <label className="grid gap-2 text-sm">
          Payee (optional)
          <Input
            className="min-h-11"
            name="payeeFilter"
            defaultValue={payeeFilter}
            maxLength={160}
          />
        </label>
        <Button type="submit" className="min-h-11">
          Show aging
        </Button>
      </form>
      <p id="aging-help" className="mt-3 text-sm text-text-muted">
        The branch selection narrows the request; it does not grant access to that branch.
      </p>
    </SectionCard>
  );
}

function Notice({ state }: { state: Exclude<State, { kind: 'loaded' }> }) {
  const content = {
    initial: [
      'Choose a branch',
      'Choose one branch and an as-of day to age its supplier expense invoices. Nothing has been read.',
    ],
    invalid: ['Request needs attention', 'Choose one branch and an as-of day no later than today.'],
    denied: [
      'Aging unavailable',
      'Your authenticated tenant, active branch, Pharmacy Finance licence and owner finance permissions must all allow this read.',
    ],
    failure: [
      'Aging could not be loaded',
      'The supplier expense invoices could not be read. No stale data is shown; retry the request.',
    ],
  }[state.kind];
  return (
    <SectionCard title={content[0]} titleLevel={2}>
      <p role={state.kind === 'initial' ? undefined : 'alert'} className="text-sm text-text-muted">
        {content[1]}
      </p>
    </SectionCard>
  );
}

function Totals({ view }: { view: ApAgingView }) {
  return (
    <SectionCard title="Outstanding by age" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Totals cover every eligible supplier expense invoice in this view. Currencies are never
        added together.
      </p>
      <div className="overflow-x-auto">
        <table className="mt-3 w-full min-w-max text-sm tabular-nums">
          <thead className="font-mono text-xs uppercase">
            <tr>
              <th scope="col" className="p-3 text-left">
                Currency
              </th>
              {AP_AGING_BUCKETS.map((bucket) => (
                <th key={bucket} scope="col" className="p-3 text-right">
                  {AP_AGING_BUCKET_LABELS[bucket]}
                </th>
              ))}
              <th scope="col" className="p-3 text-right">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {view.totals.map((total) => (
              <tr key={total.currency} className="border-t border-border-subtle hover:bg-muted/40">
                <th scope="row" className="p-3 text-left font-medium">
                  {total.currency}
                </th>
                {AP_AGING_BUCKETS.map((bucket) => (
                  <td key={bucket} className="p-3 text-right font-mono">
                    {minor(total[bucket])}
                  </td>
                ))}
                <td className="p-3 text-right font-mono font-semibold">{minor(total.TOTAL)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function Rows({ view }: { view: ApAgingView }) {
  return (
    <SectionCard title="Open invoices" titleLevel={2}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-sm tabular-nums">
          <thead className="font-mono text-xs uppercase">
            <tr>
              {['Reference', 'Payee', 'Supplier invoice', 'Invoice date', 'Due date', 'Age'].map(
                (label) => (
                  <th key={label} scope="col" className="p-3 text-left">
                    {label}
                  </th>
                )
              )}
              {['Invoice', 'Paid', 'Credit set off', 'Outstanding'].map((label) => (
                <th key={label} scope="col" className="p-3 text-right">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.invoiceId} className="border-t border-border-subtle hover:bg-muted/40">
                <th scope="row" className="p-3 text-left font-medium">
                  {row.reference}
                </th>
                <td className="p-3">{row.payeeName}</td>
                <td className="p-3">{row.supplierInvoiceRef}</td>
                <td className="p-3">{row.invoiceDate}</td>
                <td className="p-3">{row.dueDate}</td>
                <td className="p-3">
                  <StatusPill
                    status={row.bucket}
                    tone={row.bucket === 'CURRENT' ? 'neutral' : 'warning'}
                    label={AP_AGING_BUCKET_LABELS[row.bucket]}
                  />
                </td>
                <td className="p-3 text-right font-mono">
                  {row.currency} {minor(row.amountMinor)}
                </td>
                <td className="p-3 text-right font-mono">{minor(row.paidMinor)}</td>
                <td className="p-3 text-right font-mono">{minor(row.setOffMinor)}</td>
                <td className="p-3 text-right font-mono font-semibold">
                  {minor(row.outstandingMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

/**
 * DEV-103: the entry forms appear only after the router has authorized and read
 * this branch. They send to the same router, which authorizes and validates
 * every command again; the forms grant nothing.
 */
function EntryForms({
  branchId,
  view,
  timeZone,
}: {
  branchId: string;
  view: ApAgingView;
  timeZone: string | null | undefined;
}) {
  const now = new Date();
  // An incomplete view never offers a partial list of bills.
  const payable = (view.complete ? view.rows : [])
    .filter((row) => row.outstandingMinor > 0)
    .map((row) => ({
      invoiceId: row.invoiceId,
      reference: row.reference,
      payeeName: row.payeeName,
      supplierInvoiceRef: row.supplierInvoiceRef,
      currency: row.currency,
      outstanding: minor(row.outstandingMinor),
    }));
  return (
    <>
      <SectionCard title="Record a supplier expense invoice" titleLevel={2}>
        <RecordApInvoiceForm
          branchId={branchId}
          initialKey={`ap-invoice:${randomUUID()}`}
          today={workspaceToday(timeZone, now)}
        />
      </SectionCard>
      <SectionCard title="Record a payment" titleLevel={2}>
        {payable.length ? (
          <PayApInvoiceForm
            branchId={branchId}
            initialKey={`ap-payment:${randomUUID()}`}
            now={workspaceMinuteInput(now, timeZone)}
            invoices={payable}
          />
        ) : (
          <p className="text-sm text-text-muted">
            Payments are made against an open invoice shown in this view. Record the invoice first,
            or show a day on which it was outstanding.
          </p>
        )}
      </SectionCard>
    </>
  );
}

export default async function ApAgingPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  // The organization zone is known only after the actor resolves; before any read the
  // form names it generically.
  let timeZone: string | null | undefined;
  // The pre-read check uses the UTC day; the router checks again on the organization's day.
  const parsed = parseAgingQuery(query, new Date());
  let state: State = parsed.invalid ? { kind: 'invalid' } : { kind: 'initial' };
  let payables: Payables = { kind: 'none' };
  let reversals: Reversals = { kind: 'none' };
  const draftQuery = paymentDraftQuery(query);
  const payeeFilter = payeeFilterQuery(query);
  const narrow = payeeFilter ? { payeeFilter } : {};
  const reversalSearch = parseReversalSearch(query);

  // The picker lists only active branches of the signed-in organization. A branch typed into
  // the URL that is not listed is still sent to the router, which refuses it.
  const branches = await loadBranchOptions();

  if (parsed.branchId && !parsed.invalid) {
    try {
      const actor = await resolveTenantActor();
      timeZone = actor?.organization?.timezone ?? 'UTC';
      if (!actor) {
        state = { kind: 'denied' };
      } else {
        const ctx = await createTRPCContext({
          session: actor.session,
          organization: actor.organization,
          support: actor.support,
        });
        const result = await pharmacyApInvoicesRouter
          .createCaller(ctx)
          .aging({ branchId: parsed.branchId, asOf: parsed.asOf, ...narrow });
        if (
          result.scope.organizationId !== actor.organization.id ||
          result.scope.branchId !== parsed.branchId
        ) {
          throw new Error('Aging scope mismatch.');
        }
        state = {
          kind: 'loaded',
          branchId: result.scope.branchId,
          view: result.view,
          retrievedAt: result.retrievedAt,
        };
        try {
          const caller = pharmacyApInvoicesRouter.createCaller(ctx);
          const [drafts, setOffs, approvedSetOffs] = await Promise.all([
            caller.payablesDrafts({
              branchId: parsed.branchId,
              asOf: parsed.asOf,
              ...narrow,
              ...(draftQuery.request ? { payee: draftQuery.request } : {}),
            }),
            caller.creditSetOffs({ branchId: parsed.branchId, status: 'PENDING' }),
            caller.creditSetOffs({ branchId: parsed.branchId, status: 'APPROVED' }),
          ]);
          if (
            drafts.scope.organizationId !== actor.organization.id ||
            drafts.scope.branchId !== parsed.branchId ||
            setOffs.scope.organizationId !== actor.organization.id ||
            setOffs.scope.branchId !== parsed.branchId ||
            approvedSetOffs.scope.organizationId !== actor.organization.id ||
            approvedSetOffs.scope.branchId !== parsed.branchId
          ) {
            throw new Error('Payables scope mismatch.');
          }
          payables = {
            kind: 'loaded',
            drafts,
            pending: setOffs.setOffs,
            approved: approvedSetOffs.setOffs,
          };
        } catch {
          payables = { kind: 'failure' };
        }
        try {
          const caller = pharmacyApInvoicesRouter.createCaller(ctx);
          // A search with an invalid field reads nothing; the panel names the field instead.
          const [list, access] = await Promise.all([
            reversalSearch.search
              ? caller.reversalSearch({ branchId: parsed.branchId, ...reversalSearch.search })
              : Promise.resolve({
                  scope: { organizationId: actor.organization.id, branchId: parsed.branchId },
                  invoices: [] as ReversibleInvoices,
                  older: null,
                  newer: null,
                }),
            caller.reversalAccess({ branchId: parsed.branchId }),
          ]);
          if (
            list.scope.organizationId !== actor.organization.id ||
            list.scope.branchId !== parsed.branchId ||
            access.scope.organizationId !== actor.organization.id ||
            access.scope.branchId !== parsed.branchId
          ) {
            throw new Error('Reversal scope mismatch.');
          }
          reversals = {
            kind: 'loaded',
            invoices: list.invoices,
            older: list.older ?? null,
            newer: list.newer ?? null,
            access,
          };
        } catch {
          reversals = { kind: 'failure' };
        }
      }
    } catch (error) {
      state =
        error instanceof TRPCError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
          ? { kind: 'denied' }
          : { kind: 'failure' };
    }
  }

  const zone = timeZone ? workspaceZoneLabel(timeZone) : 'workspace timezone';
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Supplier expense invoice aging"
        description="Record non-stock supplier expense invoices and their payments, reverse one entered by mistake, and age what is outstanding for one branch by due date as of one day."
        actions={
          state.kind === 'loaded' && state.view.complete && state.view.rows.length ? (
            <ExportCsv
              csv={apAgingCsv(state.view, state.branchId)}
              fileName={`supplier-expense-aging-${state.view.asOf}.csv`}
            />
          ) : undefined
        }
      />
      <QueryForm
        branchId={typeof query.branch === 'string' ? query.branch : undefined}
        branches={branches}
        asOf={parsed.asOf}
        zone={zone}
        payeeFilter={payeeFilter}
      />
      {state.kind === 'loaded' ? (
        <>
          <SectionCard title="View limits" titleLevel={2}>
            <p role="status" className="text-sm text-text-muted">
              As of the end of {state.view.asOf} ({zone}). Retrieved{' '}
              {formatWorkspaceDateTime(state.retrievedAt, timeZone)}. Only supplier expense invoices
              recorded here and payments made against them count; other money movements never settle
              them. {payeeFilter ? `Showing payee ${payeeFilter} only. ` : ''}
              {state.view.complete ? `${state.view.scannedInvoices} invoices read.` : ''}
            </p>
          </SectionCard>
          {!state.view.complete ? (
            <SectionCard title="Too many invoices to total" titleLevel={2}>
              <p role="alert" className="text-sm text-text-muted">
                More than {AP_AGING_MAX_INVOICES.toLocaleString('en-US')} supplier expense invoices
                are in this view, so no total is shown rather than a partial one. Enter one payee
                above, or choose an earlier as-of day, to narrow it.
              </p>
            </SectionCard>
          ) : state.view.rows.length === 0 ? (
            <SectionCard title="Nothing outstanding" titleLevel={2}>
              <p className="text-sm text-text-muted">
                No supplier expense invoice {payeeFilter ? 'for this payee ' : 'for this branch '}
                was open at the end of {state.view.asOf}.
              </p>
            </SectionCard>
          ) : (
            <>
              <Totals view={state.view} />
              <Rows view={state.view} />
            </>
          )}
          {!state.view.complete ? null : payables.kind === 'loaded' ? (
            <>
              <DueBillReminders drafts={payables.drafts} />
              {state.view.rows.length ? (
                <PaymentDraft
                  drafts={payables.drafts}
                  branchId={state.branchId}
                  asOf={state.view.asOf}
                  payees={[...new Set(state.view.rows.map((row) => row.payeeName))].sort()}
                  payee={draftQuery.payee}
                  currency={draftQuery.currency}
                  budget={draftQuery.budget}
                />
              ) : null}
              <CreditSetOff
                drafts={payables.drafts}
                pending={payables.pending}
                approved={payables.approved}
                branchId={state.branchId}
                bills={state.view.rows.filter((row) => row.currency === 'PKR')}
              />
            </>
          ) : payables.kind === 'failure' ? (
            <SectionCard title="Reminders and drafts could not be loaded" titleLevel={2}>
              <p role="alert" className="text-sm text-text-muted">
                Due-bill reminders, the payment draft and credit-note set-offs could not be read.
                The aging above is unaffected; retry the request.
              </p>
            </SectionCard>
          ) : null}
          <EntryForms branchId={state.branchId} view={state.view} timeZone={timeZone} />
          {reversals.kind === 'loaded' ? (
            <ReversalPanel
              branchId={state.branchId}
              invoices={reversals.invoices}
              access={reversals.access}
              timeZone={timeZone}
              context={{ branchId: state.branchId, asOf: state.view.asOf, payeeFilter }}
              search={reversalSearch}
              older={reversals.older}
              newer={reversals.newer}
              zone={zone}
            />
          ) : reversals.kind === 'failure' ? (
            <SectionCard title="Reversals could not be loaded" titleLevel={2}>
              <p role="alert" className="text-sm text-text-muted">
                The invoices and payments that can be reversed could not be read. Nothing was
                changed and the aging above is unaffected; retry the request.
              </p>
            </SectionCard>
          ) : null}
        </>
      ) : (
        <Notice state={state} />
      )}
    </div>
  );
}
