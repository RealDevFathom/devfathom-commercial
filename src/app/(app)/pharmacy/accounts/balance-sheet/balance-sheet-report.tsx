import { reportDate, reportDayStart } from '@/lib/pharmacy/report-presentation';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { classifyBalanceSheet } from '@/lib/pharmacy/accounts/balance-sheet';
import type { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';

const money = (minor: string) => {
  const value = BigInt(minor);
  const zero = BigInt(0);
  const hundred = BigInt(100);
  const absolute = value < zero ? -value : value;
  return `${value < zero ? '-' : ''}${absolute / hundred}.${String(absolute % hundred).padStart(2, '0')}`;
};

const heading: Record<string, string> = {
  assets: 'Assets',
  liabilities: 'Liabilities',
  openingEquity: 'Opening equity',
  currentResult: 'Cumulative posted current result',
  unmapped: 'Unmapped',
};

export async function BalanceSheetReport({
  caller,
  branchId,
  cutoff,
  timezone = 'UTC',
}: {
  caller: ReturnType<typeof pharmacyFinanceRouter.createCaller>;
  branchId: string;
  cutoff: string;
  timezone?: string;
}) {
  const to = reportDayStart(cutoff, timezone);
  const from = new Date(to.getTime() - 86_400_000);
  let result: Awaited<ReturnType<typeof caller.financialStatements>>;
  try {
    result = await caller.financialStatements({
      branchId,
      from: from.toISOString(),
      to: to.toISOString(),
      page: 1,
    });
  } catch (error) {
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return (
      <SectionCard title="Balance sheet unavailable">
        <p role="alert" className="text-sm text-text-muted">
          {denied
            ? 'Administrator, Pharmacy Reports, operational-report, financial-report, active tenant, and active branch access are required.'
            : 'The posted-balance source could not be read. No financial rows are shown.'}
        </p>
      </SectionCard>
    );
  }

  const sheets = classifyBalanceSheet(result.accounts);
  return (
    <div className="space-y-6">
      <SectionCard title="Report cutoff">
        <form className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="branch" value={branchId} />
          <label className="grid gap-2 text-sm">
            As of (excluded cutoff, {timezone})
            <Input type="date" name="cutoff" defaultValue={cutoff} required />
          </label>
          <Button className="min-h-11" type="submit">
            Read balance sheet
          </Button>
        </form>
        <p className="mt-4 text-sm text-text-muted">
          Posted journal balances before {reportDate(to, timezone)} ({timezone}), grouped by recorded currency. The
          one-day reader window still includes every earlier posting in each closing balance; it is
          not a selected-window earnings calculation.
        </p>
      </SectionCard>

      {!sheets.length && (
        <SectionCard title="No posted balances">
          <p className="text-sm text-text-muted">
            No matching postings is not proof of zero activity. Unposted operational activity and
            source-adapter coverage remain unknown.
          </p>
        </SectionCard>
      )}

      {sheets.map((sheet) => (
        <SectionCard key={sheet.currency} title={`${sheet.currency} classified balance sheet`}>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <StatusPill
              status={sheet.reconciled ? 'Equation reconciled' : 'Reconciliation gap'}
              tone={sheet.reconciled ? 'success' : 'warning'}
            />
            <span className="font-mono text-sm">
              Assets − liabilities − equity = {sheet.currency} {money(sheet.reconciliationGapMinor)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Classification / account</TableHead>
                  <TableHead>Normal side</TableHead>
                  <TableHead className="text-right">Raw closing (Dr−Cr)</TableHead>
                  <TableHead className="text-right">Normal-side balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheet.accounts.map((account) => (
                  <TableRow key={account.accountCode}>
                    <TableCell>
                      <span className="block text-xs text-text-muted">
                        {heading[account.section]}
                      </span>
                      {account.accountCode}
                    </TableCell>
                    <TableCell>{account.normalSide ?? 'Unknown'}</TableCell>
                    <TableCell className="text-right font-mono">
                      {money(account.closingMinor)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {money(account.normalBalanceMinor)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <dl className="mt-5 grid gap-2 text-sm sm:grid-cols-2">
            {[
              ['Assets', sheet.assetsMinor],
              ['Liabilities', sheet.liabilitiesMinor],
              ['Opening equity', sheet.openingEquityMinor],
              ['Cumulative posted current result', sheet.currentResultMinor],
              ['Liabilities and equity', sheet.liabilitiesAndEquityMinor],
              ['Reconciliation gap', sheet.reconciliationGapMinor],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex justify-between gap-4 border-b border-border-subtle py-2"
              >
                <dt>{label}</dt>
                <dd className="font-mono">
                  {sheet.currency} {money(value)}
                </dd>
              </div>
            ))}
          </dl>
          {sheet.unmappedAccountCodes.length > 0 && (
            <p role="alert" className="mt-4 text-sm text-text-muted">
              Nonzero unmapped accounts block a reconciled claim:{' '}
              {sheet.unmappedAccountCodes.join(', ')}. No customer-deposit, supplier-credit, or
              later wallet policy has been guessed.
            </p>
          )}
          <p className="mt-4 text-xs text-text-muted">
            Source: {result.source}; {result.coverage.basis}. Coverage and completeness remain{' '}
            {result.coverage.completeness}. Before unrecorded tax; not statutory or audited.
            Retrieved {reportDate(result.freshness.retrievedAt, timezone)}.
          </p>
        </SectionCard>
      ))}
    </div>
  );
}
