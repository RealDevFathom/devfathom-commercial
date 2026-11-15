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
import { formatUtcInstant } from '@/lib/utc-instant';
import { ExportCsv } from './export-csv';
import { parseAgingQuery, type AgingQuery as Query } from './query';

export const metadata: Metadata = { title: 'Supplier expense invoice aging · Pharmacy accounts' };

type State =
  | { kind: 'initial' }
  | { kind: 'invalid' }
  | { kind: 'denied' }
  | { kind: 'failure' }
  | { kind: 'loaded'; branchId: string; view: ApAgingView; retrievedAt: Date };

function minor(value: number): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? '-' : ''}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function QueryForm({ branchId, asOf }: { branchId?: string; asOf: string }) {
  return (
    <SectionCard title="Branch and date" titleLevel={2}>
      <form method="get" className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="grid gap-2 text-sm">
          Branch ID
          <Input
            className="min-h-11"
            name="branch"
            defaultValue={branchId}
            maxLength={128}
            required
            aria-describedby="aging-help"
          />
        </label>
        <label className="grid gap-2 text-sm">
          As of (UTC day)
          <Input className="min-h-11" type="date" name="asOf" defaultValue={asOf} required />
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
      'Enter one branch and an as-of day to age its supplier expense invoices. Nothing has been read.',
    ],
    invalid: [
      'Request needs attention',
      'Enter one branch ID of at most 128 characters and an as-of day no later than today.',
    ],
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
        {view.complete
          ? 'Totals cover every eligible supplier expense invoice for this branch.'
          : `Only the ${AP_AGING_MAX_INVOICES} invoices due earliest were read; these totals are partial.`}{' '}
        Currencies are never added together.
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
              {['Invoice', 'Paid', 'Outstanding'].map((label) => (
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

export default async function ApAgingPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const parsed = parseAgingQuery(query, new Date());
  let state: State = parsed.invalid ? { kind: 'invalid' } : { kind: 'initial' };

  if (parsed.branchId && !parsed.invalid) {
    try {
      const actor = await resolveTenantActor();
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
          .aging({ branchId: parsed.branchId, asOf: parsed.asOf });
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
      }
    } catch (error) {
      state =
        error instanceof TRPCError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
          ? { kind: 'denied' }
          : { kind: 'failure' };
    }
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Supplier expense invoice aging"
        description="Outstanding non-stock supplier expense invoices for one branch, aged by due date as of one day."
        actions={
          state.kind === 'loaded' && state.view.rows.length ? (
            <ExportCsv
              csv={apAgingCsv(state.view, state.branchId)}
              fileName={`supplier-expense-aging-${state.view.asOf}.csv`}
            />
          ) : undefined
        }
      />
      <QueryForm
        branchId={typeof query.branch === 'string' ? query.branch : undefined}
        asOf={parsed.asOf}
      />
      {state.kind === 'loaded' ? (
        <>
          <SectionCard title="View limits" titleLevel={2}>
            <p role="status" className="text-sm text-text-muted">
              As of the end of {state.view.asOf} (UTC). Retrieved{' '}
              {formatUtcInstant(state.retrievedAt)}. Only supplier expense invoices recorded here
              and payments made against them count; other money movements never settle them.{' '}
              {state.view.complete
                ? `${state.view.scannedInvoices} invoices read.`
                : `Read capped at ${AP_AGING_MAX_INVOICES} invoices; this view is incomplete.`}
            </p>
          </SectionCard>
          {state.view.rows.length === 0 ? (
            state.view.complete ? (
              <SectionCard title="Nothing outstanding" titleLevel={2}>
                <p className="text-sm text-text-muted">
                  No supplier expense invoice for this branch was open at the end of{' '}
                  {state.view.asOf}.
                </p>
              </SectionCard>
            ) : (
              <SectionCard title="Nothing outstanding in the invoices read" titleLevel={2}>
                <p role="alert" className="text-sm text-text-muted">
                  None of the {state.view.scannedInvoices} invoices read was open at the end of{' '}
                  {state.view.asOf}, but the read was capped, so later-due invoices may still be
                  outstanding. This does not show the branch as clear.
                </p>
              </SectionCard>
            )
          ) : (
            <>
              <Totals view={state.view} />
              <Rows view={state.view} />
            </>
          )}
        </>
      ) : (
        <Notice state={state} />
      )}
    </main>
  );
}
