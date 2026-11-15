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
import { EarnRateForm } from './earn-rate-form';
import { AdjustPointsForm } from './adjust-points-form';
import {
  describeLoyaltyEarnRule,
  describeRedemptionValue,
  LOYALTY_POINT_VALUE_MINOR,
} from '@/lib/commerce/loyalty-arithmetic';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import {
  DEFAULT_MANAGER_ADJUST_LIMIT_POINTS,
  LOYALTY_EARN_PRESETS,
} from '@/lib/pharmacy/loyalty-program';

export const metadata = { title: 'Loyalty points · Pharmacy' };
const linkClass =
  'inline-flex min-h-11 items-center rounded-sm underline hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring';
const eventLabels: Record<string, string> = {
  EARN: 'Points earned',
  REDEEM: 'Points redeemed',
  REFUND: 'Redeemed points restored',
  EARN_REVERSAL: 'Earned points reversed',
  KHATA_EARN: 'Points earned on khata payment',
  ADJUSTMENT: 'Points adjusted',
  EXPIRY: 'Points expired',
  REDEMPTION_RELEASE: 'Redeemed points released (sale voided)',
};
const pkr = (minor: number) => `PKR ${formatMinor(minor)}`;
const pointValueOf = (version: { redemptionValueMinor?: number } | null) =>
  version?.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR;
const describeExpiry = (days: number | null | undefined) =>
  days ? `After ${days.toLocaleString('en-PK')} ${days === 1 ? 'day' : 'days'}` : 'Never';
const rupeesInput = (minor: number) =>
  minor % 100 === 0 ? String(minor / 100) : formatMinor(minor);

async function loadLoyalty(text: (key: string) => string) {
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    const branches = await caller.branches();
    if (!branches.length) return { state: 'empty' as const };
    const branchId = text('branchId') || branches[0]!.id;
    if (!branches.some((branch) => branch.id === branchId))
      throw new TRPCError({ code: 'NOT_FOUND' });
    const query = text('query');
    const [{ customers, hasMore }, earnRate, liability, redemptions] = await Promise.all([
      caller.customers({ branchId, query }),
      caller.earnRate(),
      caller.liability(),
      caller.redemptions({ branchId, page: Number(text('redemptionsPage') || 1) }),
    ]);
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
      earnRate,
      liability,
      redemptions,
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
  const {
    branches,
    branchId,
    query,
    customers,
    hasMore,
    customerId,
    history,
    earnRate,
    liability,
    redemptions,
  } = data;
  const href = (id: string, page = 1) =>
    `/pharmacy/loyalty?${new URLSearchParams({ branchId, customerId: id, query, page: String(page) })}`;
  const redemptionsHref = (page: number) =>
    `/pharmacy/loyalty?${new URLSearchParams({ branchId, ...(customerId ? { customerId } : {}), query, redemptionsPage: String(page) })}#redemption-history`;
  const current = earnRate.current;
  const branchLabel = (id: string) => branches.find((branch) => branch.id === id)?.name ?? id;
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
      <SectionCard title="Earning rate" titleLevel={2}>
        {current ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Current earning rate" value={describeLoyaltyEarnRule(current)} />
            <Stat label="Redemption value" value={describeRedemptionValue(pointValueOf(current))} />
            <Stat label="Points expire" value={describeExpiry(current.expiryDays)} />
            <Stat
              label="Khata purchases"
              value={current.khataEarns === false ? 'Do not earn' : 'Earn once paid off'}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-warning">
              Points are not being earned: set an earn rate below. Existing balances stay available
              to redeem.
            </p>
            <p className="text-sm text-text-body">
              First setup: choose how points are earned, what one point is worth and whether points
              expire, then save. Customers start earning on their next purchase.
            </p>
          </div>
        )}
        <p className="mt-2 mb-5 text-sm text-text-muted">
          {current
            ? `Version ${current.version}, in effect since ${current.effectiveFrom.toISOString().slice(0, 10)} (UTC). `
            : ''}
          Every purchase earns, including khata purchases once the customer pays them off when that
          is switched on. Points tenders never earn. Every save is a new dated version: it applies
          from when it is saved, and points already earned keep the rate they were earned at.
        </p>
        <EarnRateForm
          presets={LOYALTY_EARN_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
          defaults={{
            pointValue: rupeesInput(pointValueOf(current)),
            expiryDays: current?.expiryDays ?? null,
            khataEarns: current?.khataEarns ?? true,
            managerAdjustLimitPoints:
              current?.managerAdjustLimitPoints ?? DEFAULT_MANAGER_ADJUST_LIMIT_POINTS,
          }}
        />
        {earnRate.versions.length > 1 && (
          <div
            className="mt-5 overflow-x-auto"
            role="region"
            aria-label="Earning rate history"
            tabIndex={0}
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Earning rate history</caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {['Version', 'Rate', 'Point value', 'Expiry', 'Khata', 'From (UTC)'].map((t) => (
                    <th key={t} scope="col" className="p-3 text-left">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {earnRate.versions.map((version) => (
                  <tr
                    key={version.id}
                    className="border-t border-border-subtle hover:bg-surface-sunken"
                  >
                    <td className="p-3 font-mono tabular-nums">{version.version}</td>
                    <td className="p-3">{describeLoyaltyEarnRule(version)}</td>
                    <td className="whitespace-nowrap p-3">{pkr(pointValueOf(version))}</td>
                    <td className="whitespace-nowrap p-3">{describeExpiry(version.expiryDays)}</td>
                    <td className="p-3">{version.khataEarns === false ? 'Off' : 'On'}</td>
                    <td className="whitespace-nowrap p-3">
                      <time dateTime={version.effectiveFrom.toISOString()}>
                        {version.effectiveFrom.toISOString().replace('T', ' ').slice(0, 16)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Points liability" titleLevel={2}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat
            label="Unredeemed points"
            value={liability.points.toLocaleString('en-PK')}
            sub={`${liability.customers.toLocaleString('en-PK')} customer balances`}
          />
          <Stat label="Value owed" value={pkr(liability.liabilityMinor)} />
          <Stat label="At" value={describeRedemptionValue(liability.pointValueMinor)} />
        </div>
        <p className="mt-2 text-sm text-text-muted">
          What every unredeemed point across the organization would take off bills at the current
          redemption value. Expired, redeemed and removed points are not counted.
        </p>
        {liability.branches.length > 0 && (
          <div
            className="mt-4 overflow-x-auto"
            role="region"
            aria-label="Points liability by branch"
            tabIndex={0}
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Points liability by branch</caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {['Branch', 'Customers', 'Points', 'Value'].map((t) => (
                    <th
                      key={t}
                      scope="col"
                      className={`p-3 ${t === 'Branch' ? 'text-left' : 'text-right'}`}
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {liability.branches.map((row) => (
                  <tr
                    key={row.branchId}
                    className="border-t border-border-subtle hover:bg-surface-sunken"
                  >
                    <td className="p-3">{branchLabel(row.branchId)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{row.customers}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{row.points}</td>
                    <td className="whitespace-nowrap p-3 text-right font-mono tabular-nums">
                      {pkr(row.liabilityMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
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
            first. Refunds, reversals, adjustments and expiries remain visible.
          </p>
          <div className="mt-5 border-t border-border-subtle pt-5">
            <h3 className="mb-3 text-sm font-semibold text-text-strong">Adjust points</h3>
            <AdjustPointsForm branchId={branchId} customerId={customerId} />
          </div>
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
                        {e.reason && (
                          <span className="mt-1 block break-words text-xs text-text-muted">
                            Reason: {e.reason}
                          </span>
                        )}
                        {e.expiresAt && (
                          <span className="mt-1 block text-xs text-text-muted">
                            Expires {e.expiresAt.toISOString().slice(0, 10)}
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        {e.sale ? (
                          <>
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
                          </>
                        ) : (
                          <span className="text-text-muted">
                            {e.kind === 'EXPIRY' ? 'Expiry of earned points' : 'Manual adjustment'}
                          </span>
                        )}
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
      <SectionCard id="redemption-history" title="Redemption history" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Points redeemed at {branchName}, newest first, with what each redemption took off the bill
          and any points given back by a refund or a voided sale.
        </p>
        {redemptions.redemptions.length ? (
          <div
            className="mt-4 overflow-x-auto"
            role="region"
            aria-label="Redemption history"
            tabIndex={0}
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Points redemptions at {branchName}</caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {['Time (UTC)', 'Customer', 'Receipt', 'Points', 'Value', 'Returned'].map((t) => (
                    <th
                      key={t}
                      scope="col"
                      className={`p-3 ${['Points', 'Value', 'Returned'].includes(t) ? 'text-right' : 'text-left'}`}
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {redemptions.redemptions.map((r) => (
                  <tr key={r.id} className="border-t border-border-subtle hover:bg-surface-sunken">
                    <td className="whitespace-nowrap p-3">
                      <time dateTime={r.occurredAt.toISOString()}>
                        {r.occurredAt.toISOString().replace('T', ' ').slice(0, 16)}
                      </time>
                    </td>
                    <td className="p-3">
                      <Link
                        className={`${linkClass} max-w-full break-words`}
                        href={href(r.customer.id)}
                      >
                        {r.customer.displayName}
                      </Link>
                    </td>
                    <td className="p-3">
                      {r.receiptNumber !== null ? `No. ${r.receiptNumber}` : 'Not issued'}
                      {r.saleVoided && (
                        <span className="block text-xs text-text-muted">Sale voided</span>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums">{r.points}</td>
                    <td className="whitespace-nowrap p-3 text-right font-mono tabular-nums">
                      {pkr(r.amountMinor)}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums">{r.pointsReturned}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm">
            No points have been redeemed at {branchName} yet. Redemptions taken at the counter
            appear here.
          </p>
        )}
        {redemptions.pageCount > 1 && (
          <nav aria-label="Redemption pages" className="mt-3 flex flex-wrap items-center gap-4">
            {redemptions.page > 1 ? (
              <Link className={linkClass} href={redemptionsHref(redemptions.page - 1)}>
                Newer redemptions
              </Link>
            ) : null}
            <span className="text-sm tabular-nums">
              Page {redemptions.page} of {redemptions.pageCount}
            </span>
            {redemptions.page < redemptions.pageCount ? (
              <Link className={linkClass} href={redemptionsHref(redemptions.page + 1)}>
                Older redemptions
              </Link>
            ) : null}
          </nav>
        )}
      </SectionCard>
      <Link className={linkClass} href="/pharmacy/counter">
        Open counter
      </Link>
    </main>
  );
}
