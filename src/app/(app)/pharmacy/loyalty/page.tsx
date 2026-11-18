import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';
import { formatWorkspaceDate, formatWorkspaceDateTime } from '@/lib/timezone';
import { LoyaltyCustomerSearch } from './customer-search';
import { EarnRateForm } from './earn-rate-form';
import { AdjustPointsForm } from './adjust-points-form';
import { LoyaltyCardPanel } from './loyalty-card-panel';
import { MembershipForm } from './membership-form';
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
    const ctx = await createTRPCContext();
    const caller = pharmacyLoyaltyRouter.createCaller(ctx);
    // Times show on the organisation's clock (UTC when it has no zone).
    const timeZone = ctx.organization?.timezone ?? null;
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
    const [history, card] = customerId
      ? await Promise.all([
          caller.history({ branchId, customerId, page: Number(text('page') || 1) }),
          caller.card({ branchId, customerId }),
        ])
      : [null, null];
    return {
      state: 'ready' as const,
      branches,
      branchId,
      query,
      customers,
      hasMore,
      customerId,
      history,
      card,
      earnRate,
      liability,
      redemptions,
      timeZone,
    };
  } catch (error) {
    unstable_rethrow(error);
    return {
      state: 'error' as const,
      denied: error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code),
    };
  }
}

function MembershipPill({ active }: { active: boolean }) {
  return active ? (
    <StatusPill status="active" label="Member" />
  ) : (
    <StatusPill status="deactivated" tone="neutral" label="Deactivated" />
  );
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
      <div className="min-w-0 space-y-6">
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
      </div>
    );
  }
  if (data.state === 'empty')
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title="No active branch" titleLevel={2}>
          <p>An owner must activate a pharmacy branch before its loyalty ledger can be viewed.</p>
        </SectionCard>
      </div>
    );
  const {
    branches,
    branchId,
    query,
    customers,
    hasMore,
    customerId,
    history,
    card,
    earnRate,
    liability,
    redemptions,
    timeZone,
  } = data;
  const shopTime = (value: Date) => formatWorkspaceDateTime(value, timeZone);
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
    <div className="min-w-0 space-y-6">
      {header}
      <Link className={linkClass} href="/pharmacy/loyalty/prepaid">
        Manage prepaid tiers
      </Link>
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
            ? `Version ${current.version}, in effect since ${formatWorkspaceDate(current.effectiveFrom, timeZone)}. `
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
                  {['Version', 'Rate', 'Point value', 'Expiry', 'Khata', 'From'].map((t) => (
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
                        {shopTime(version.effectiveFrom)}
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
          redemption value. Expired, redeemed and removed points are not counted. Each customer has
          one balance across all branches. By branch: points earned or added there, less points
          spent or expired there, so a branch whose customers redeem points earned elsewhere can be
          below zero.
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
          Retail customers across this workspace. Each customer has one points balance across all
          branches. Clinical records are excluded. Select a customer to see their points history.
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
                {query ? `Customers matching ${query}` : 'Loyalty customers'}
              </caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {['Customer', 'Phone', 'Loyalty no.', 'Membership', 'Points'].map((t) => (
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
                    <td className="p-3">
                      <MembershipPill active={c.loyaltyActive !== false} />
                    </td>
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
          <Link
            className={linkClass}
            href={`/pharmacy/loyalty/prepaid?customerId=${encodeURIComponent(customerId)}`}
          >
            Prepaid balance and ledger
          </Link>
          <Stat label="Points available" value={`${history.pointsBalance} points available`} />
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <MembershipPill active={history.customer.loyaltyActive !== false} />
            {history.customer.loyaltyStatusChangedAt && (
              <span className="text-text-muted">
                {history.customer.loyaltyActive !== false ? 'Re-enrolled' : 'Deactivated'}{' '}
                <time dateTime={history.customer.loyaltyStatusChangedAt.toISOString()}>
                  {shopTime(history.customer.loyaltyStatusChangedAt)}
                </time>
                {history.customer.loyaltyStatusReason
                  ? ` · ${history.customer.loyaltyStatusReason}`
                  : ''}
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-text-muted">
            {history.total} ledger entries. One balance across all branches, all time; newest
            entries first, each with the branch it was recorded at. Refunds, reversals, adjustments
            and expiries remain visible.
          </p>
          {history.reconciliation.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold text-text-strong">
                Branch balances merged
              </h3>
              <p className="mb-2 text-sm text-text-muted">
                This customer held points at more than one branch before balances became one. These
                were the branch balances on{' '}
                <time dateTime={history.reconciliation[0]!.reconciledAt.toISOString()}>
                  {shopTime(history.reconciliation[0]!.reconciledAt)}
                </time>
                ; together they make the balance above. Nothing was added or removed.
              </p>
              <div
                className="overflow-x-auto"
                role="region"
                aria-label="Branch balances merged"
                tabIndex={0}
              >
                <table className="w-full text-sm">
                  <caption className="sr-only">Branch balances merged into one balance</caption>
                  <thead className="font-mono text-xs uppercase">
                    <tr>
                      {['Branch', 'Entries', 'Points'].map((t) => (
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
                    {history.reconciliation.map((row) => (
                      <tr
                        key={row.branchId}
                        className="border-t border-border-subtle hover:bg-surface-sunken"
                      >
                        <td className="p-3">{branchLabel(row.branchId)}</td>
                        <td className="p-3 text-right font-mono tabular-nums">{row.entries}</td>
                        <td className="p-3 text-right font-mono tabular-nums">{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div className="mt-5 border-t border-border-subtle pt-5">
            <h3 className="mb-3 text-sm font-semibold text-text-strong">Membership</h3>
            <MembershipForm
              key={String(history.customer.loyaltyActive !== false)}
              branchId={branchId}
              customerId={customerId}
              loyaltyActive={history.customer.loyaltyActive !== false}
            />
          </div>
          <div className="mt-5 border-t border-border-subtle pt-5">
            <h3 className="mb-3 text-sm font-semibold text-text-strong">Adjust points</h3>
            {history.customer.loyaltyActive !== false ? (
              <AdjustPointsForm branchId={branchId} customerId={customerId} />
            ) : (
              <p className="text-sm text-text-muted">
                Points cannot be adjusted while the member is deactivated. Re-enrol them first.
              </p>
            )}
          </div>
          <div className="mt-5 border-t border-border-subtle pt-5">
            <h3 className="mb-3 text-sm font-semibold text-text-strong">Loyalty card</h3>
            <LoyaltyCardPanel
              key={customerId}
              branchId={branchId}
              customerId={customerId}
              activeCard={card ? { issuedAt: card.issuedAt.toISOString() } : null}
              timeZone={timeZone}
            />
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
                  Points history for {history.customer.displayName}
                </caption>
                <thead className="font-mono text-xs uppercase">
                  <tr>
                    {['Time', 'Event', 'Branch', 'Source receipt', 'Points'].map((t) => (
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
                        <time dateTime={e.occurredAt.toISOString()}>{shopTime(e.occurredAt)}</time>
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
                            Expires {formatWorkspaceDate(e.expiresAt, timeZone)}
                          </span>
                        )}
                      </td>
                      <td className="p-3">{branchLabel(e.branchId)}</td>
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
              No points entries for this customer yet.
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
                  {['Time', 'Customer', 'Receipt', 'Points', 'Value', 'Returned'].map((t) => (
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
                      <time dateTime={r.occurredAt.toISOString()}>{shopTime(r.occurredAt)}</time>
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
    </div>
  );
}
