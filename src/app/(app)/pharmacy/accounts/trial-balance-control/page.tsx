import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  InvalidTrialBalanceError,
  projectTrialBalanceControl,
  type TrialBalanceControl,
} from '@/lib/pharmacy/accounts/trial-balance-control';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';
import { financeAccountLabel } from '@/lib/finance/account-labels';

export const metadata: Metadata = { title: 'Trial-balance control · Pharmacy accounts' };

type Query = { branch?: string | string[]; from?: string | string[]; to?: string | string[] };
type Controls = { branchId: string; from: string; to: string };
type State =
  | { kind: 'initial' }
  | { kind: 'invalid'; message: string }
  | { kind: 'denied' }
  | { kind: 'failure' }
  | {
      kind: 'loaded';
      controls: TrialBalanceControl;
      scope: { branchId: string };
      from: Date;
      to: Date;
      retrievedAt: Date;
    };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function day(value: string): Date | null {
  if (!DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function parseQuery(query: Query): { controls?: Controls; error?: string } {
  const values = [query.branch, query.from, query.to];
  if (values.every((value) => value === undefined)) return {};
  if (values.some((value) => typeof value !== 'string')) {
    return { error: 'Choose one branch and provide both UTC dates.' };
  }
  const [branchValue, fromValue, toValue] = values as [string, string, string];
  const branchId = branchValue.trim();
  const from = day(fromValue);
  const to = day(toValue);
  if (!branchId || branchId.length > 128 || !from || !to) {
    return { error: 'Choose a valid branch and two valid UTC dates.' };
  }
  const duration = to.getTime() - from.getTime();
  if (duration <= 0 || duration > 92 * 86_400_000) {
    return { error: 'Choose a UTC date window greater than zero and no longer than 92 days.' };
  }
  return { controls: { branchId, from: fromValue, to: toValue } };
}

function minor(value: bigint): string {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
}

function ControlForm({ controls }: { controls?: Partial<Controls> }) {
  return (
    <SectionCard title="Report controls" titleLevel={2}>
      <form method="get" className="grid gap-4 md:grid-cols-4 md:items-end">
        <label className="grid gap-2 text-sm">
          Branch ID
          <Input
            className="min-h-11"
            name="branch"
            defaultValue={controls?.branchId}
            maxLength={128}
            required
            aria-describedby="branch-help"
          />
        </label>
        <label className="grid gap-2 text-sm">
          From (UTC)
          <Input className="min-h-11" name="from" type="date" defaultValue={controls?.from} required />
        </label>
        <label className="grid gap-2 text-sm">
          To, exclusive (UTC)
          <Input className="min-h-11" name="to" type="date" defaultValue={controls?.to} required />
        </label>
        <Button type="submit" className="min-h-11">
          Read control
        </Button>
      </form>
      <p id="branch-help" className="mt-3 text-sm text-text-muted">
        The branch selection narrows the request; it does not grant access to that branch.
      </p>
    </SectionCard>
  );
}

function Notice({ state }: { state: Exclude<State, { kind: 'loaded' }> }) {
  const content = {
    initial: [
      'Choose a report scope',
      'Select one branch and a UTC half-open date window. No financial source has been read.',
    ],
    invalid: ['Report controls need attention', state.kind === 'invalid' ? state.message : ''],
    denied: [
      'Trial-balance control unavailable',
      'Your authenticated tenant, active branch, Pharmacy Reports licence and owner report permissions must all allow this read.',
    ],
    failure: [
      'Trial-balance source unavailable',
      'The posted-ledger source could not be read or returned an invalid response. No stale financial data is shown; retry the report.',
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

function Results({ state }: { state: Extract<State, { kind: 'loaded' }> }) {
  const { controls } = state;
  const status = controls.empty
    ? 'No matching posted account rows'
    : controls.inconsistent
      ? 'Source algebra is inconsistent'
      : controls.allZero
        ? 'All supplied account values are zero'
        : 'Account controls calculated';
  return (
    <SectionCard title={status} titleLevel={2}>
      <p className="text-sm text-text-muted">
        Branch {state.scope.branchId}. Posted branch journal lines only; coverage and completeness
        remain unknown. UTC window [{state.from.toISOString()}, {state.to.toISOString()}). Source:
        finance_journal_lines. Retrieved {state.retrievedAt.toISOString()}.
      </p>
      <p className="mt-2 text-sm text-text-muted">
        A nonzero control may be legitimate for an interbranch scope. Zero is not evidence of
        completeness, statutory compliance, reconciliation or an adapter pass. Row and bridge
        differences are source-algebra consistency checks, not independent checks.
      </p>
      {controls.empty ? (
        <p className="mt-4 text-sm">
          No matching postings were returned; this does not prove zero activity.
        </p>
      ) : (
        <>
          <h3 className="mt-6 font-semibold">Per-currency controls</h3>
          <div className="overflow-x-auto">
            <table className="mt-3 w-full min-w-max text-sm tabular-nums">
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {[
                    'Currency',
                    'Opening debit',
                    'Opening credit',
                    'Opening difference',
                    'Movement debit',
                    'Movement credit',
                    'Movement difference',
                    'Closing debit',
                    'Closing credit',
                    'Closing difference',
                    'Bridge difference',
                  ].map((label) => (
                    <th key={label} scope="col" className="p-3 text-right first:text-left">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {controls.currencies.map((control) => (
                  <tr key={control.currency} className="border-t border-border-subtle">
                    <th scope="row" className="p-3 text-left font-medium">
                      {control.currency}
                    </th>
                    {[
                      control.openingDebit,
                      control.openingCredit,
                      control.openingDifference,
                      control.movementDebit,
                      control.movementCredit,
                      control.movementDifference,
                      control.closingDebit,
                      control.closingCredit,
                      control.closingDifference,
                      control.bridgeDifference,
                    ].map((value, index) => (
                      <td key={index} className="p-3 text-right font-mono">
                        {minor(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="mt-6 font-semibold">All account rows</h3>
          <div className="overflow-x-auto">
            <table className="mt-3 w-full min-w-max text-sm tabular-nums">
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {[
                    'Account',
                    'Currency',
                    'Opening',
                    'Debit',
                    'Credit',
                    'Supplied closing',
                    'Row difference',
                  ].map((label) => (
                    <th key={label} scope="col" className="p-3 text-right first:text-left">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {controls.rows.map((row) => (
                  <tr
                    key={`${row.accountCode.length}:${row.accountCode}${row.currency}`}
                    className="border-t border-border-subtle"
                  >
                    <th scope="row" className="p-3 text-left font-medium" title={row.accountCode}>
                      {financeAccountLabel(row.accountCode)}
                    </th>
                    <td className="p-3 text-right">{row.currency}</td>
                    {[row.opening, row.debit, row.credit, row.closing, row.rowDifference].map(
                      (value, index) => (
                        <td key={index} className="p-3 text-right font-mono">
                          {minor(value)}
                        </td>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

export default async function TrialBalanceControlPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const parsed = parseQuery(query);
  const formControls = {
    branchId: typeof query.branch === 'string' ? query.branch : undefined,
    from: typeof query.from === 'string' ? query.from : undefined,
    to: typeof query.to === 'string' ? query.to : undefined,
  };
  let state: State = parsed.error
    ? { kind: 'invalid', message: parsed.error }
    : { kind: 'initial' };

  if (parsed.controls) {
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
        const caller = pharmacyFinanceRouter.createCaller(ctx);
        const requestedFrom = new Date(`${parsed.controls.from}T00:00:00.000Z`);
        const requestedTo = new Date(`${parsed.controls.to}T00:00:00.000Z`);
        const report = await caller.financialStatements({
          branchId: parsed.controls.branchId,
          from: requestedFrom.toISOString(),
          to: requestedTo.toISOString(),
          page: 1,
        });
        if (
          report.scope.organizationId !== actor.organization.id ||
          report.scope.branchId !== parsed.controls.branchId ||
          !isValidDate(report.from) ||
          !isValidDate(report.to) ||
          !isValidDate(report.freshness?.retrievedAt) ||
          report.from.getTime() !== requestedFrom.getTime() ||
          report.to.getTime() !== requestedTo.getTime()
        ) {
          throw new InvalidTrialBalanceError();
        }
        state = {
          kind: 'loaded',
          controls: projectTrialBalanceControl(report.accounts),
          scope: { branchId: report.scope.branchId },
          from: report.from,
          to: report.to,
          retrievedAt: report.freshness.retrievedAt,
        };
      }
    } catch (error) {
      state =
        error instanceof TRPCError &&
        ['UNAUTHORIZED', 'FORBIDDEN'].includes((error as { code: string }).code)
          ? { kind: 'denied' }
          : { kind: 'failure' };
    }
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Trial-balance control"
        description="Review every returned account code through per-currency opening, movement and supplied-closing controls."
      />
      <ControlForm controls={formControls} />
      {state.kind === 'loaded' ? <Results state={state} /> : <Notice state={state} />}
    </main>
  );
}
