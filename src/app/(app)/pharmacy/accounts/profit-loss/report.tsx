import type { projectProfitAndLoss } from '@/lib/pharmacy/accounts/profit-loss';

const money = (value: string) => {
  const n = BigInt(value);
  const absolute = n < BigInt(0) ? -n : n;
  return `${n < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
};

export function ProfitAndLossReport({
  statements,
}: {
  statements: ReturnType<typeof projectProfitAndLoss>;
}) {
  return (
    <>
      <h3 className="mt-6 font-semibold">Net P&amp;L projection</h3>
      <p className="mt-2 text-sm text-text-muted">
        Posted journal movements in this window only. Revenue is credit minus debit; discounts, cost
        of goods sold, and expenses are debit minus credit. Reversals retain their signs. Net
        revenue is revenue less discounts; gross profit subtracts cost of goods sold; net result
        subtracts posted expenses and losses. Unposted income, tax, and other costs remain unknown.
        This is not a statutory income statement or a claim of complete economic profit.
      </p>
      <p className="mt-2 text-sm text-text-muted">
        Inventory, cash/bank, receivables/payables, clearing/accrual, and opening equity are
        balance-sheet movements and are excluded. Opening balances are excluded from period results.
      </p>
      {statements.length ? (
        <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-2">
          {statements.map((statement) => (
            <section
              key={statement.currency}
              aria-label={`${statement.currency} net P&L projection`}
              className="min-w-0 rounded-[var(--radius-sm)] border border-border-default p-4"
            >
              <h4 className="font-mono text-xs uppercase text-text-muted">
                {statement.currency} · posted P&amp;L
              </h4>
              {statement.unmappedAccounts.length > 0 && (
                <div role="alert" className="mt-3 rounded-sm border border-warning p-3 text-sm">
                  <p className="font-semibold">
                    Unmapped account activity · incomplete classification
                  </p>
                  <p className="mt-1">
                    These movements are excluded from all calculated totals. Classify these accounts
                    before relying on the mapped posted result.
                  </p>
                  <ul className="mt-2 space-y-2">
                    {statement.unmappedAccounts.map((account) => (
                      <li
                        key={account.accountCode}
                        className="break-words [overflow-wrap:anywhere]"
                      >
                        {account.accountCode}: debit {money(account.debitMinor)}, credit{' '}
                        {money(account.creditMinor)}, net Dr−Cr {money(account.amountMinor)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <dl className="mt-3 space-y-2 text-sm">
                {statement.rows.map((row) => (
                  <div
                    key={row.accountCode}
                    className="flex flex-wrap justify-between gap-3 border-b border-border-subtle py-1"
                  >
                    <dt>{row.accountCode.replaceAll('_', ' ')}</dt>
                    <dd className="break-all text-right font-mono tabular-nums">
                      {money(row.amountMinor)}
                    </dd>
                  </div>
                ))}
                {[
                  ['Net revenue', statement.netRevenueMinor],
                  ['Gross profit', statement.grossProfitMinor],
                  ['Posted expenses and losses', statement.postedExpensesMinor],
                  [
                    `${statement.unmappedAccounts.length ? 'MAPPED ' : ''}NET ${BigInt(statement.netProfitMinor) < BigInt(0) ? 'LOSS' : 'PROFIT'}`,
                    statement.netProfitMinor,
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex flex-wrap justify-between gap-3 pt-2 font-semibold"
                  >
                    <dt>{label}</dt>
                    <dd className="break-all text-right font-mono tabular-nums">{money(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm">
          No posted P&amp;L movements in this window. Unposted activity and completeness remain
          unknown.
        </p>
      )}
    </>
  );
}
