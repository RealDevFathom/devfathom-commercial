import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/plain-language';
import { ReportDetails } from '@/components/pharmacy/report-details';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  accountActivityBridge,
  accountActivityBridgeCsv,
  assertAccountActivityScope,
} from '@/lib/pharmacy/accounts/account-activity-bridge';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';
import { workspaceZoneLabel } from '@/lib/timezone';
import { pharmacyCalendarDayOffset, pharmacyCalendarDayRange } from '@/lib/pharmacy/business-day';
import { AccountActivityExportButton } from './export-button';

export const metadata: Metadata = { title: screenCopy.accountActivity.accountActivityBridge };

type Search = Partial<Record<'branch' | 'from' | 'to' | 'selection', string | string[]>>;
const date = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_MS = 92 * 86_400_000;
/** Rejects impossible calendar dates such as 2026-13-45 or 2026-02-30. */
const validDate = (value: string) => {
  if (!date.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const money = (value: string) => {
  const number = BigInt(value);
  const absolute = number < BigInt(0) ? -number : number;
  return `${number < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
};

export default async function AccountActivityBridgePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const query = await searchParams;
  const actor = await resolveTenantActor();
  const ctx = actor
    ? await createTRPCContext({
        session: actor.session,
        organization: actor.organization,
        support: actor.support,
      })
    : null;
  if (!ctx?.session?.user || ctx.session.user.role !== 'ADMIN')
    return (
      <State title={screenCopy.accountActivity.permissionRequired}>
        {screenCopy.accountActivity.organizationAdministratorAccessIsRequired}
      </State>
    );

  if (
    Array.isArray(query.branch) ||
    Array.isArray(query.from) ||
    Array.isArray(query.to) ||
    Array.isArray(query.selection)
  )
    return (
      <State title={screenCopy.accountActivity.invalidFilters}>
        {screenCopy.accountActivity.chooseOneValueForEachFilter}
      </State>
    );

  const organizationId = ctx.entitlements.organizationId;
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const branch =
    query.branch === undefined
      ? branches[0]
      : branches.find((candidate) => candidate.id === query.branch);
  if (query.branch !== undefined && !branch)
    return (
      <State title={screenCopy.accountActivity.branchUnavailable}>
        {screenCopy.accountActivity.chooseAnActiveBranchInThisOrganization}
      </State>
    );
  if (!branch)
    return (
      <State title={screenCopy.accountActivity.noActiveBranch}>
        {screenCopy.accountActivity.createAnActivePharmacyBranchFirst}
      </State>
    );

  const timeZone = ctx.organization?.timezone;
  const zone = workspaceZoneLabel(timeZone);
  const now = new Date();
  const fallbackTo = pharmacyCalendarDayOffset(timeZone, 1, now);
  const fallbackFrom = pharmacyCalendarDayOffset(timeZone, -30, now);
  const from = query.from ?? fallbackFrom;
  const to = query.to ?? fallbackTo;
  if (!validDate(from) || !validDate(to) || from >= to)
    return (
      <State title={screenCopy.accountActivity.invalidDateWindow}>
        {screenCopy.accountActivity.chooseAValidUtcDateWindowWithAn}
      </State>
    );
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_WINDOW_MS)
    return (
      <State title={screenCopy.accountActivity.invalidDateWindow}>
        {screenCopy.accountActivity.chooseADateWindowOfAtMost92}
      </State>
    );

  let statement;
  try {
    // The picked days are read on the organization's clock.
    const window = {
      from: pharmacyCalendarDayRange(from, from, timeZone).from,
      to: pharmacyCalendarDayRange(to, to, timeZone).from,
    };
    statement = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
      branchId: branch.id,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      page: 1,
    });
    assertAccountActivityScope(statement.scope, { organizationId, branchId: branch.id });
  } catch (error) {
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return (
      <State title={denied ? 'Permission required' : 'Account activity unavailable'}>
        {denied
          ? 'Owner financial-report permission and Pharmacy Reports access are required.'
          : 'The aggregate evidence could not be read or verified. No financial data was changed.'}
      </State>
    );
  }

  // Printable tuple values survive HTML parsing and GET form encoding unchanged.
  const choices = statement.accounts.map((row) => ({
    value: JSON.stringify([row.accountCode, row.currency]),
    accountCode: row.accountCode,
    currency: row.currency,
  }));
  const selected =
    query.selection === undefined
      ? choices[0]
      : choices.find((choice) => choice.value === query.selection);
  let bridge;
  try {
    bridge = selected ? accountActivityBridge(statement.accounts, selected) : null;
  } catch {
    bridge = null;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={screenCopy.accountActivity.pharmacyAccounts}
        heading={screenCopy.accountActivity.accountActivityBridge}
        description={screenCopy.accountActivity.isolateOnePostedAccountAndRecordedCurrencyFrom}
      />
      <SectionCard title={screenCopy.accountActivity.chooseAnAccount} titleLevel={2}>
        <form method="get" className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-5">
          <label className="grid gap-2 text-sm">
            {screenCopy.accountActivity.branch}
            <select
              name="branch"
              defaultValue={branch.id}
              className="min-h-11 rounded-sm border border-border-default bg-surface-raised px-3"
            >
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.dateWindow.from} ({zone})
            <Input name="from" type="date" defaultValue={from} required />
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.dateWindow.toExclusive} ({zone})
            <Input name="to" type="date" defaultValue={to} required />
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.accountActivity.accountCurrency}
            <select
              name="selection"
              defaultValue={selected?.value ?? ''}
              className="min-h-11 rounded-sm border border-border-default bg-surface-raised px-3"
            >
              {!selected && (
                <option value="" disabled>
                  {screenCopy.accountActivity.chooseAnAccountCurrency}
                </option>
              )}
              {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.accountCode} / {choice.currency}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="lg">
            {screenCopy.accountActivity.readBridge}
          </Button>
        </form>
      </SectionCard>
      <SectionCard title={screenCopy.accountActivity.accountTotals} titleLevel={2}>
        {!bridge ? (
          <p role="alert" className="text-sm text-text-muted">
            {screenCopy.accountActivity.noUniqueCompleteAggregateMatchesThisAccountAnd}
          </p>
        ) : (
          <>
            <ReportDetails>
              <p className="text-sm text-text-muted">
                {screenCopy.accountActivity.postedCoverageIsUnknownThisEvidenceIsNot}
              </p>
            </ReportDetails>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead className="font-mono text-xs uppercase">
                  <tr>
                    {['Account / currency', 'Opening', 'Debits', 'Credits', 'Closing'].map(
                      (heading) => (
                        <th key={heading} className="p-3 text-left">
                          {heading}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-border-subtle">
                    <td className="p-3">
                      {bridge.accountCode} / {bridge.currency}
                    </td>
                    {[
                      bridge.openingMinor,
                      bridge.debitMinor,
                      bridge.creditMinor,
                      bridge.closingMinor,
                    ].map((amount, index) => (
                      <td key={index} className="p-3 text-right font-mono">
                        {money(amount)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <ReportDetails>
              <p className="my-4 font-mono text-sm">
                {bridge.openingMinor} + {bridge.debitMinor} − {bridge.creditMinor} ={' '}
                {bridge.closingMinor}
                {screenCopy.accountActivity.minorUnits}
              </p>
            </ReportDetails>
            <AccountActivityExportButton
              csv={accountActivityBridgeCsv(bridge)}
              filename={`account-activity-${from}-to-${to}.csv`}
            />
          </>
        )}
      </SectionCard>
    </div>
  );
}

function State({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={screenCopy.accountActivity.pharmacyAccounts}
        heading={screenCopy.accountActivity.accountActivityBridge}
        description={screenCopy.accountActivity.openingBalanceMoneyInAndOutAndClosing}
      />
      <SectionCard title={title}>
        <p role="alert" className="text-sm text-text-muted">
          {children}
        </p>
      </SectionCard>
    </div>
  );
}
