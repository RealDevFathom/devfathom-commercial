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
import { AccountActivityExportButton } from './export-button';

export const metadata: Metadata = { title: 'Account activity bridge' };

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
      <State title="Permission required">Organization administrator access is required.</State>
    );

  if (
    Array.isArray(query.branch) ||
    Array.isArray(query.from) ||
    Array.isArray(query.to) ||
    Array.isArray(query.selection)
  )
    return <State title="Invalid filters">Choose one value for each filter.</State>;

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
    return <State title="Branch unavailable">Choose an active branch in this organization.</State>;
  if (!branch)
    return <State title="No active branch">Create an active pharmacy branch first.</State>;

  const now = new Date();
  const fallbackTo = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const fallbackFrom = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const from = query.from ?? fallbackFrom;
  const to = query.to ?? fallbackTo;
  if (!validDate(from) || !validDate(to) || from >= to)
    return (
      <State title="Invalid date window">
        Choose a valid UTC date window with an exclusive end.
      </State>
    );
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_WINDOW_MS)
    return (
      <State title="Invalid date window">Choose a date window of at most 92 days.</State>
    );

  let statement;
  try {
    statement = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
      branchId: branch.id,
      from: `${from}T00:00:00Z`,
      to: `${to}T00:00:00Z`,
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
    <main className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Account activity bridge"
        description="Isolate one posted account and recorded currency from financial-statement aggregates."
      />
      <SectionCard title="Select aggregate evidence" titleLevel={2}>
        <form method="get" className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-5">
          <label className="grid gap-2 text-sm">
            Branch
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
            From (UTC)
            <Input name="from" type="date" defaultValue={from} required />
          </label>
          <label className="grid gap-2 text-sm">
            To, exclusive (UTC)
            <Input name="to" type="date" defaultValue={to} required />
          </label>
          <label className="grid gap-2 text-sm">
            Account / currency
            <select
              name="selection"
              defaultValue={selected?.value ?? ''}
              className="min-h-11 rounded-sm border border-border-default bg-surface-raised px-3"
            >
              {!selected && (
                <option value="" disabled>
                  Choose an account / currency
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
            Read bridge
          </Button>
        </form>
      </SectionCard>
      <SectionCard title="Bridge evidence" titleLevel={2}>
        {!bridge ? (
          <p role="alert" className="text-sm text-text-muted">
            No unique, complete aggregate matches this account and recorded currency. Missing values
            are not treated as zero.
          </p>
        ) : (
          <>
            <p className="text-sm text-text-muted">
              Posted coverage is unknown. This evidence is not a running ledger, trial balance,
              maturity report, statement, or wallet view.
            </p>
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
            <p className="my-4 font-mono text-sm">
              {bridge.openingMinor} + {bridge.debitMinor} − {bridge.creditMinor} ={' '}
              {bridge.closingMinor} minor units
            </p>
            <AccountActivityExportButton
              csv={accountActivityBridgeCsv(bridge)}
              filename={`account-activity-${from}-to-${to}.csv`}
            />
          </>
        )}
      </SectionCard>
    </main>
  );
}

function State({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Account activity bridge"
        description="Single-account aggregate evidence."
      />
      <SectionCard title={title}>
        <p role="alert" className="text-sm text-text-muted">
          {children}
        </p>
      </SectionCard>
    </main>
  );
}
