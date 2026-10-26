import { TRPCError } from '@trpc/server';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { classifyBalanceSheet, type BalanceSheetLine } from '@/lib/pharmacy/accounts/balance-sheet';
import type { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';

const money = (minor: string) => {
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};

function Lines({ lines, currency }: { lines: BalanceSheetLine[]; currency: string }) {
  return (
    <ul>
      {lines.map((line) => (
        <li
          key={line.accountCode}
          className="flex flex-wrap justify-between gap-3 border-t border-border-subtle py-3 text-sm"
        >
          <span>
            {line.label}{' '}
            <span className="font-mono text-xs text-text-muted">({line.accountCode})</span>
          </span>
          <span className="font-mono tabular-nums">
            {currency} {money(line.amountMinor)}{' '}
            <span className="text-text-muted">{line.normalSide}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export async function BalanceSheetReport({
  caller,
  branchId,
  cutoff,
}: {
  caller: ReturnType<typeof pharmacyFinanceRouter.createCaller>;
  branchId: string;
  cutoff: Date;
}) {
  let result;
  try {
    // Closing is opening + movements, so even a short accepted window remains the canonical
    // all-time balance at the exclusive cutoff and never depends on paginated journal rows.
    result = await caller.financialStatements({
      branchId,
      from: new Date(cutoff.getTime() - 86_400_000).toISOString(),
      to: cutoff.toISOString(),
      page: 1,
    });
  } catch (error) {
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return (
      <SectionCard title="Balance sheet unavailable">
        <p role="alert" className="text-sm text-text-muted">
          {denied
            ? 'Owner, Pharmacy Reports, operational-report, and financial-report access are required. No financial balances were returned.'
            : 'Posted balances could not be read for this branch and cutoff.'}
        </p>
      </SectionCard>
    );
  }

  const sheets = classifyBalanceSheet(result.accounts);
  if (!sheets.length) {
    return (
      <SectionCard title="No posted balances">
        <p className="text-sm text-text-muted">
          No canonical journal balances were recorded before this cutoff. This does not prove that
          operational activity is complete or zero.
        </p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">
        Canonical posted journal balances before the exclusive UTC cutoff. Amounts are exact integer
        minor units grouped by recorded currency. Unposted operational adapters, tax, audit, and
        statutory completeness remain unknown. Retrieved{' '}
        {result.freshness.retrievedAt.toISOString()}.
      </p>
      {sheets.map((sheet) => (
        <SectionCard
          key={sheet.currency}
          title={`${sheet.currency} classified balance sheet`}
          actions={
            <StatusPill
              status={sheet.status}
              tone={
                sheet.status === 'reconciled'
                  ? 'success'
                  : sheet.status === 'gap'
                    ? 'danger'
                    : 'warning'
              }
              label={
                sheet.status === 'reconciled'
                  ? 'Equation reconciled'
                  : sheet.status === 'gap'
                    ? 'Equation gap'
                    : 'Incomplete mapping'
              }
            />
          }
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h3 className="mb-2 font-semibold">Assets</h3>
              <Lines lines={sheet.assets} currency={sheet.currency} />
              <p className="border-t border-border-default pt-3 text-right font-mono font-semibold tabular-nums">
                Total assets · {sheet.currency} {money(sheet.totals.assetsMinor)}
              </p>
            </section>
            <section className="space-y-5">
              <div>
                <h3 className="mb-2 font-semibold">Liabilities</h3>
                <Lines lines={sheet.liabilities} currency={sheet.currency} />
              </div>
              <div>
                <h3 className="mb-2 font-semibold">Equity</h3>
                <Lines lines={sheet.openingEquity} currency={sheet.currency} />
                <p className="flex justify-between border-t border-border-subtle py-3 text-sm">
                  <span>Derived cumulative posted current result</span>
                  <span className="font-mono tabular-nums">
                    {sheet.currency} {money(sheet.currentResultMinor)}
                  </span>
                </p>
                <p className="border-t border-border-default pt-3 text-right font-mono font-semibold tabular-nums">
                  Total liabilities and equity · {sheet.currency}{' '}
                  {money(sheet.totals.equityAndLiabilitiesMinor)}
                </p>
              </div>
            </section>
          </div>
          <div className="mt-6 rounded-[var(--radius-sm)] border border-border-default bg-surface-sunken p-4">
            <p className="font-mono text-sm font-semibold tabular-nums">
              Assets − liabilities − equity = {sheet.currency}{' '}
              {money(sheet.totals.reconciliationGapMinor)}
            </p>
            <p className="mt-2 text-sm text-text-muted">
              {sheet.status === 'reconciled'
                ? 'The classified posted accounts reconcile at this cutoff. This does not establish source completeness.'
                : 'The difference is shown as recorded; no balancing plug or rounding adjustment was added.'}
            </p>
          </div>
          {sheet.unmapped.length > 0 && (
            <section className="mt-6">
              <h3 className="font-semibold">Unmapped nonzero accounts</h3>
              <p className="mt-2 text-sm text-text-muted">
                These codes remain visible and prevent a complete or reconciled claim. No
                customer-deposit, supplier-credit, or wallet policy is inferred.
              </p>
              <ul className="mt-2">
                {sheet.unmapped.map((line) => (
                  <li
                    key={line.accountCode}
                    className="flex justify-between border-t border-border-subtle py-3 text-sm"
                  >
                    <span className="font-mono">{line.accountCode}</span>
                    <span className="font-mono tabular-nums">
                      {sheet.currency} {money(line.closingMinor)} Dr−Cr
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </SectionCard>
      ))}
    </div>
  );
}
