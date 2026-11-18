import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  InvalidLiquidityKpiSourceError,
  LIQUIDITY_KPI_COVERAGE,
  liquidityKpiCsv,
  projectLiquidityKpi,
  type LiquidityKpi,
  type LiquidityKpiCurrency,
  type LiquidityKpiFlag,
} from '@/lib/pharmacy/accounts/liquidity-kpi';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';
import { formatWorkspaceDateTime, workspaceDateRange, workspaceZoneLabel } from '@/lib/timezone';
import { ExportCsv } from './export-csv';

export const metadata: Metadata = { title: 'Posted cash coverage · Pharmacy accounts' };

type Query = { branch?: string | string[]; cutoff?: string | string[] };
type Controls = { branchId: string; cutoff: string };
type State =
  | { kind: 'initial' }
  | { kind: 'invalid'; message: string }
  | { kind: 'denied' }
  | { kind: 'failure' }
  | {
      kind: 'loaded';
      kpi: LiquidityKpi;
      branchId: string;
      cutoff: Date;
      retrievedAt: Date;
    };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

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
  const values = [query.branch, query.cutoff];
  if (values.every((value) => value === undefined)) return {};
  if (values.some((value) => typeof value !== 'string')) {
    return { error: 'Choose one branch and one cutoff date.' };
  }
  const [branchValue, cutoffValue] = values as [string, string];
  const branchId = branchValue.trim();
  if (!branchId || branchId.length > 128 || !day(cutoffValue)) {
    return { error: 'Choose a valid branch and a valid cutoff date.' };
  }
  return { controls: { branchId, cutoff: cutoffValue } };
}

function minor(value: string): string {
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const FLAG_LABEL: Record<LiquidityKpiFlag, string> = {
  NEGATIVE_CASH: 'Negative cash',
  NEGATIVE_BANK: 'Negative bank',
  DEBIT_ACCOUNTS_PAYABLE: 'Debit payables',
  DEBIT_GOODS_RECEIVED_ACCRUAL: 'Debit goods-received accrual',
};

function ControlForm({
  controls,
  timeZone,
}: {
  controls?: Partial<Controls>;
  timeZone?: string | null;
}) {
  const zone = timeZone ? workspaceZoneLabel(timeZone) : 'workspace timezone';
  return (
    <SectionCard title="Report controls" titleLevel={2}>
      <form method="get" className="grid gap-4 md:grid-cols-3 md:items-end">
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
          Cutoff, exclusive ({zone})
          <Input
            className="min-h-11"
            name="cutoff"
            type="date"
            defaultValue={controls?.cutoff}
            required
          />
        </label>
        <Button type="submit" className="min-h-11">
          Read coverage
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
      'Select one branch and a cutoff date in your workspace timezone. No financial source has been read.',
    ],
    invalid: ['Report controls need attention', state.kind === 'invalid' ? state.message : ''],
    denied: [
      'Posted cash coverage unavailable',
      'Your authenticated tenant, active branch, Pharmacy Reports licence and owner report permissions must all allow this read.',
    ],
    failure: [
      'Posted-ledger source unavailable',
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

function Status({ row }: { row: LiquidityKpiCurrency }) {
  if (row.unavailableReason === 'NO_RECORDED_LIABILITIES') {
    return <StatusPill status="unavailable" tone="neutral" label="Unavailable: no liabilities" />;
  }
  if (row.unavailableReason === 'NONPOSITIVE_LIABILITIES') {
    return <StatusPill status="unavailable" tone="warning" label="Unavailable: liabilities ≤ 0" />;
  }
  return <StatusPill status="calculated" tone="info" label="Calculated" />;
}

function Results({
  state,
  timeZone,
}: {
  state: Extract<State, { kind: 'loaded' }>;
  timeZone?: string | null;
}) {
  const { kpi } = state;
  const csv = liquidityKpiCsv(kpi, {
    branchId: state.branchId,
    cutoff: state.cutoff.toISOString(),
    retrievedAt: state.retrievedAt.toISOString(),
  });
  return (
    <SectionCard
      title={kpi.empty ? 'No posted cash or liability balances' : 'Coverage by recorded currency'}
      titleLevel={2}
      actions={kpi.empty ? undefined : <ExportCsv csv={csv} />}
    >
      <p className="text-sm text-text-muted">
        Closing balances posted before {formatWorkspaceDateTime(state.cutoff, timeZone)}. Source:
        posted accounts. Retrieved {formatWorkspaceDateTime(state.retrievedAt, timeZone)}.{' '}
        {LIQUIDITY_KPI_COVERAGE}
      </p>
      <p className="mt-2 text-sm text-text-muted">
        Coverage = (CASH + BANK) ÷ (accounts payable + goods-received accrual), each currency
        separately. This is a posted-ledger indicator, not a solvency, current or quick ratio, and
        currencies are never converted or combined.
      </p>
      {kpi.empty ? (
        <p className="mt-4 text-sm">
          No posted CASH, BANK, accounts payable or goods-received accrual rows were returned; this
          does not prove zero balances.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-4 w-full min-w-max text-sm tabular-nums">
            <thead className="font-mono text-xs uppercase">
              <tr>
                {[
                  'Currency',
                  'Cash',
                  'Bank',
                  'Accounts payable',
                  'Goods-received accrual',
                  'Cash and bank vs bills owed',
                  'Coverage',
                  'Status',
                  'Flags',
                ].map((label) => (
                  <th key={label} scope="col" className="p-3 text-right first:text-left">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kpi.currencies.map((row) => (
                <tr key={row.currency} className="border-t border-border-subtle hover:bg-muted/40">
                  <th scope="row" className="p-3 text-left font-medium">
                    {row.currency}
                  </th>
                  {[
                    row.cashMinor,
                    row.bankMinor,
                    row.accountsPayableMinor,
                    row.goodsReceivedAccrualMinor,
                  ].map((value, index) => (
                    <td key={index} className="p-3 text-right font-mono">
                      {minor(value)}
                    </td>
                  ))}
                  <td className="p-3 text-right font-mono">
                    {minor(row.numeratorMinor)} / {minor(row.denominatorMinor)}
                  </td>
                  <td className="p-3 text-right font-mono">{row.ratioDecimal ?? '—'}</td>
                  <td className="p-3 text-right">
                    <Status row={row} />
                  </td>
                  <td className="p-3 text-right">
                    {row.flags.length === 0 ? (
                      <span className="text-text-muted">None</span>
                    ) : (
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        {row.flags.map((flag) => (
                          <StatusPill
                            key={flag}
                            status={flag}
                            tone="warning"
                            label={FLAG_LABEL[flag]}
                          />
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

export default async function LiquidityKpiPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const parsed = parseQuery(query);
  const formControls = {
    branchId: typeof query.branch === 'string' ? query.branch : undefined,
    cutoff: typeof query.cutoff === 'string' ? query.cutoff : undefined,
  };
  let state: State = parsed.error
    ? { kind: 'invalid', message: parsed.error }
    : { kind: 'initial' };
  // The organization zone is known only after the actor resolves; before any read the
  // form names it generically.
  let timeZone: string | null | undefined;

  if (parsed.controls) {
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
        const caller = pharmacyFinanceRouter.createCaller(ctx);
        // The cutoff is the start of the picked day on the organization's clock. Closing
        // balances include every posting before it, so a one-day window suffices.
        const zoneName = timeZone;
        const cutoff = workspaceDateRange(
          parsed.controls.cutoff,
          parsed.controls.cutoff,
          zoneName
        ).from;
        const previousDay = new Date(Date.parse(`${parsed.controls.cutoff}T00:00:00.000Z`) - DAY_MS)
          .toISOString()
          .slice(0, 10);
        const from = workspaceDateRange(previousDay, previousDay, zoneName).from;
        const report = await caller.financialStatements({
          branchId: parsed.controls.branchId,
          from: from.toISOString(),
          to: cutoff.toISOString(),
          page: 1,
        });
        if (
          report.scope.organizationId !== actor.organization.id ||
          report.scope.branchId !== parsed.controls.branchId ||
          !isValidDate(report.to) ||
          !isValidDate(report.freshness?.retrievedAt) ||
          report.to.getTime() !== cutoff.getTime()
        ) {
          throw new InvalidLiquidityKpiSourceError();
        }
        state = {
          kind: 'loaded',
          kpi: projectLiquidityKpi(report.accounts),
          branchId: report.scope.branchId,
          cutoff: report.to,
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
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Posted cash coverage"
        description="Compare posted cash and bank balances with posted payables and goods-received accruals, per recorded currency."
      />
      <ControlForm controls={formControls} timeZone={timeZone} />
      {state.kind === 'loaded' ? (
        <Results state={state} timeZone={timeZone} />
      ) : (
        <Notice state={state} />
      )}
    </div>
  );
}
