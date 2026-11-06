import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyKhataListRouter } from './khata-router';

export const metadata = { title: 'Khata balances · Pharmacy' };

async function loadBalances(value: (key: string) => string) {
  try {
    const caller = pharmacyKhataListRouter.createCaller(await createTRPCContext());
    const branches = await caller.branches();
    if (!branches.length) return { state: 'empty' as const };
    const branchId = value('branchId') || branches[0]!.id;
    if (!branches.some((branch) => branch.id === branchId))
      throw new TRPCError({ code: 'NOT_FOUND' });
    const { rows, next } = await caller.accounts({ branchId, after: value('after') });
    return { state: 'ready' as const, branches, branchId, rows, next };
  } catch (error) {
    unstable_rethrow(error);
    return {
      state: 'error' as const,
      denied: error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code),
    };
  }
}

export default async function KhataPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const header = (
    <PageHeader
      eyebrow="Pharmacy / owner"
      heading="Khata balances"
      description="Review family account balances, limits and recent payments by branch."
    />
  );
  const data = await loadBalances(value);
  if (data.state === 'error') {
    const { denied } = data;
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title={denied ? 'Owner access required' : 'Balances unavailable'}>
          <p role="alert">
            {denied
              ? 'An authorized owner with pharmacy counter access is required.'
              : 'The accounts could not be loaded. Check your branch selection and try again.'}
          </p>
          <Link
            className="mt-4 inline-block underline focus-visible:outline-2 focus-visible:outline-ring"
            href="/pharmacy/khata"
          >
            Reset selection and retry
          </Link>
        </SectionCard>
      </div>
    );
  }
  if (data.state === 'empty')
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title="No active branch">
          <p>Activate a pharmacy branch to view its accounts.</p>
        </SectionCard>
      </div>
    );
  const { branches, branchId, rows, next } = data;
  return (
    <div className="min-w-0 space-y-6">
      {header}
      <SectionCard title="Family accounts" titleLevel={2}>
        <form className="mb-5 flex flex-wrap items-end gap-3" action="/pharmacy/khata">
          <div>
            <label htmlFor="branch" className="mb-1 block text-sm font-medium">
              Branch
            </label>
            <select
              id="branch"
              name="branchId"
              defaultValue={branchId}
              className="min-h-11 rounded-sm border border-border-default bg-surface-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            >
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary">
            View branch
          </Button>
        </form>
        {rows.length ? (
          <>
            <p className="mb-2 text-sm text-text-muted sm:hidden">
              Scroll the table horizontally to see all account details.
            </p>
            <div
              role="region"
              aria-label="Khata balances"
              tabIndex={0}
              className="overflow-x-auto rounded-md border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full min-w-[700px] text-sm tabular-nums">
                <thead className="bg-surface-sunken font-mono text-xs uppercase text-text-muted">
                  <tr>
                    <th className="p-3 text-left">Account</th>
                    <th className="p-3 text-left">Payer phone</th>
                    <th className="p-3 text-right">Balance</th>
                    <th className="p-3 text-right">Limit</th>
                    <th className="p-3 text-right">Last payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-surface-sunken">
                      <th scope="row" className="p-3 text-left font-medium">
                        {row.displayName}
                      </th>
                      <td className="p-3">{row.phone || 'Not recorded'}</td>
                      <td className="p-3 text-right">{formatMinor(row.balanceMinor)}</td>
                      <td className="p-3 text-right">{formatMinor(row.creditLimitMinor)}</td>
                      <td className="p-3 text-right">
                        {row.lastPayment ? (
                          <>
                            {formatMinor(row.lastPayment.amountMinor)} ·{' '}
                            {new Intl.DateTimeFormat('en-GB', {
                              dateStyle: 'medium',
                              timeZone: 'Asia/Karachi',
                            }).format(row.lastPayment.occurredAt)}
                          </>
                        ) : (
                          'No payment recorded'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p role="status">No family accounts on this page for this branch.</p>
        )}
        <div className="mt-4 flex gap-4 text-sm">
          {value('after') && (
            <Link
              className="underline focus-visible:outline-2 focus-visible:outline-ring"
              href={`/pharmacy/khata?${new URLSearchParams({ branchId })}`}
            >
              First page
            </Link>
          )}
          {next && (
            <Link
              className="underline focus-visible:outline-2 focus-visible:outline-ring"
              href={`/pharmacy/khata?${new URLSearchParams({ branchId, after: next })}`}
            >
              Next accounts
            </Link>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
