import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Stat } from '@/components/ui/stat';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';
import { LoyaltyCustomerSearch } from './customer-search';

export const metadata = { title: 'Loyalty points · Pharmacy' };
const linkClass =
  'inline-flex min-h-11 items-center rounded-sm underline hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring';
const eventLabels: Record<string, string> = {
  EARN: 'Points earned',
  REDEEM: 'Points redeemed',
  REFUND: 'Redeemed points restored',
  EARN_REVERSAL: 'Earned points reversed',
};

async function loadLoyalty(text: (key: string) => string) {
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    const branches = await caller.branches();
    if (!branches.length) return { state: 'empty' as const };
    const branchId = text('branchId') || branches[0]!.id;
    if (!branches.some((branch) => branch.id === branchId))
      throw new TRPCError({ code: 'NOT_FOUND' });
    const query = text('query');
    const { customers, hasMore } = await caller.customers({ branchId, query });
    const customerId = text('customerId');
    const history = customerId
      ? await caller.history({ branchId, customerId, page: Number(text('page') || 1) })
      : null;
    return {
      state: 'ready' as const,
      branches,
      branchId,
      query,
      customers,
      hasMore,
      customerId,
      history,
    };
  } catch (error) {
    unstable_rethrow(error);
    return {
      state: 'error' as const,
      denied: error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code),
    };
  }
}

export default async function LoyaltyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const text = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const header = (
    <PageHeader
      eyebrow="Pharmacy / customers"
      heading="Loyalty points"
      description="Review points balances and the receipts behind each change."
    />
  );
  const data = await loadLoyalty(text);
  if (data.state === 'error') {
    const { denied } = data;
    return (
      <main className="min-w-0 space-y-6">
        {header}
        <SectionCard
          title={denied ? 'Loyalty access required' : 'Ledger unavailable'}
          titleLevel={2}
        >
          <p role="alert">
            {denied
              ? 'An authorized owner and Pharmacy CRM package are required.'
              : 'The ledger could not be loaded. Check the branch, customer and page selection, then retry.'}
          </p>
          <Link className={linkClass} href="/pharmacy/loyalty">
            Reset selection and retry
          </Link>
        </SectionCard>
      </main>
    );
  }
  if (data.state === 'empty')
    return (
      <main className="min-w-0 space-y-6">
        {header}
        <SectionCard title="No active branch" titleLevel={2}>
          <p>An owner must activate a pharmacy branch before its loyalty ledger can be viewed.</p>
        </SectionCard>
      </main>
    );
  const { branches, branchId, query, customers, hasMore, customerId, history } = data;
  const href = (id: string, page = 1) =>
    `/pharmacy/loyalty?${new URLSearchParams({ branchId, customerId: id, query, page: String(page) })}`;
  const branchName = branches.find((branch) => branch.id === branchId)!.name;
  async function saveReminderLanguage(formData: FormData) {
    'use server';
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    await caller.setReminderLanguage({
      branchId: String(formData.get('branchId') ?? ''),
      customerId: String(formData.get('customerId') ?? ''),
      preferredLanguage: String(formData.get('preferredLanguage') ?? '') as 'en' | 'ur',
    });
    revalidatePath('/pharmacy/loyalty');
  }
  return (
    <main className="min-w-0 space-y-6">
      {header}
      <SectionCard title="Customers" titleLevel={2}>
        <LoyaltyCustomerSearch branches={branches} branchId={branchId} query={query} />
        <p className="mt-3 text-sm text-text-muted">
          Retail customers across this workspace. Points shown only for {branchName}. Clinical
          records are excluded. Select a customer to see their points history.
        </p>
        {customers.length > 0 && (
          <div
            className="mt-4 overflow-x-auto"
            role="region"
            aria-label="Loyalty customers"
            tabIndex={0}
          >
            <table className="w-full text-sm">
              <caption className="sr-only">
                {query ? `Customers matching ${query}` : 'Loyalty customers'} at {branchName}
              </caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {['Customer', 'Phone', 'Loyalty no.', 'Points'].map((t) => (
                    <th
                      key={t}
                      scope="col"
                      className={`p-3 ${t === 'Points' ? 'text-right' : 'text-left'}`}
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-t border-border-subtle hover:bg-surface-sunken ${c.id === customerId ? 'bg-surface-sunken' : ''}`}
                  >
                    <td className="p-3">
                      <Link
                        aria-current={c.id === customerId ? 'true' : undefined}
                        className={`${linkClass} max-w-full break-words aria-[current=true]:font-semibold`}
                        href={href(c.id)}
                      >
                        {c.displayName}
                        {c.id === customerId ? ' · Selected' : ''}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {c.phoneLast4 ? `ending ${c.phoneLast4}` : 'Not recorded'}
                    </td>
                    <td className="break-all p-3 font-mono text-xs">{c.id}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{c.pointsBalance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && (
          <p role="status" className="mt-3 text-sm">
            Showing the first 50 matches. Refine the name, phone or loyalty number to find another
            account.
          </p>
        )}
        {!customers.length && (
          <p role="status" className="mt-3 text-sm">
            No matching customers. Try another name, phone or loyalty number, or link a consenting
            customer at the counter.
          </p>
        )}
      </SectionCard>
      {history ? (
        <SectionCard title={history.customer.displayName} titleLevel={2}>
          <form action={saveReminderLanguage} className="mb-5 flex flex-wrap items-end gap-3">
            <input type="hidden" name="branchId" value={branchId} />
            <input type="hidden" name="customerId" value={customerId} />
            <label className="grid w-full gap-2 text-sm sm:w-auto">
              Reminder language
              <select
                name="preferredLanguage"
                defaultValue={history.customer.preferredLanguage}
                className="min-h-11 rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <option value="en">English</option>
                <option value="ur">Urdu</option>
              </select>
            </label>
            <Button type="submit" className="min-h-11">
              Save reminder language
            </Button>
          </form>
          <p className="mb-5 text-sm text-text-muted">
            Used for approved WhatsApp Khata reminder templates. A reminder is not sent when its
            language template is not configured.
          </p>
          <Stat label="Points available" value={`${history.pointsBalance} points available`} />
          <p className="mt-2 text-sm text-text-muted">
            {branchName} · {history.total} ledger entries. All-time branch balance; newest entries
            first. Refunds and reversals remain visible.
          </p>
          {history.entries.length ? (
            <div
              className="mt-4 overflow-x-auto"
              role="region"
              aria-label="Loyalty history"
              tabIndex={0}
            >
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Points history for {history.customer.displayName} at {branchName}
                </caption>
                <thead className="font-mono text-xs uppercase">
                  <tr>
                    {['Time (UTC)', 'Event', 'Source receipt', 'Points'].map((t) => (
                      <th
                        key={t}
                        scope="col"
                        className={`p-3 ${t === 'Points' ? 'text-right' : 'text-left'}`}
                      >
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.entries.map((e) => (
                    <tr
                      key={e.id}
                      className="border-t border-border-subtle hover:bg-surface-sunken"
                    >
                      <td className="whitespace-nowrap p-3">
                        <time dateTime={e.occurredAt.toISOString()}>
                          {e.occurredAt.toISOString().replace('T', ' ').slice(0, 19)}
                        </time>
                      </td>
                      <td className="p-3">
                        {eventLabels[e.kind] ?? e.kind}
                        {e.refundId && (
                          <span className="mt-1 block break-all text-xs text-text-muted">
                            Refund: {e.refundId}
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <span>
                          {e.sale.receiptNumber !== null
                            ? `Receipt #${e.sale.receiptNumber}`
                            : 'Receipt not issued'}
                        </span>
                        {e.sale.receiptDeviceId && (
                          <span className="block break-all text-xs text-text-muted">
                            Device: {e.sale.receiptDeviceId}
                          </span>
                        )}
                        <span className="block break-all text-xs text-text-muted">
                          Sale: {e.saleId}
                        </span>
                        {e.tenderId && (
                          <span className="block break-all text-xs text-text-muted">
                            Tender: {e.tenderId}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums">
                        {e.points > 0 ? '+' : ''}
                        {e.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p role="status" className="mt-4">
              No points entries for this customer at this branch yet.
            </p>
          )}
          <nav aria-label="Points pages" className="mt-3 flex flex-wrap items-center gap-4">
            {history.page > 1 ? (
              <Link className={linkClass} href={href(customerId, history.page - 1)}>
                Previous
              </Link>
            ) : (
              <span aria-disabled="true" className="text-text-muted">
                Previous
              </span>
            )}
            <span className="text-sm tabular-nums">
              Page {history.page} of {history.pageCount}
            </span>
            {history.hasNext ? (
              <Link className={linkClass} href={href(customerId, history.page + 1)}>
                Next
              </Link>
            ) : (
              <span aria-disabled="true" className="text-text-muted">
                Next
              </span>
            )}
          </nav>
          {history.historyLimitReached && (
            <p role="status" className="mt-3 text-sm">
              This view has reached its 10,000-page limit. Older entries remain in the ledger.
            </p>
          )}
        </SectionCard>
      ) : null}
      <Link className={linkClass} href="/pharmacy/counter">
        Open counter
      </Link>
    </main>
  );
}
