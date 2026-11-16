import { formatUtcInstant } from '@/lib/utc-instant';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyPrepaidRouter } from '../prepaid-router';
import { prepaidTierSettings } from '@/lib/pharmacy/prepaid-tiers';
import { TierSettingsForm, PrepaidPaymentForm } from './forms';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
export default async function PrepaidPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const { customerId } = await searchParams;
  const header = (
    <PageHeader
      eyebrow="Pharmacy / loyalty"
      heading="Prepaid tiers"
      description="Set tiers, receive upfront payments and review customer money held for future purchases."
    />
  );
  const data = await loadPrepaid(customerId);
  if (!data)
    return (
      <div className="space-y-6">
        {header}
        <SectionCard title="Prepaid console unavailable" titleLevel={2}>
          <p role="alert">
            An authorized owner and Pharmacy CRM access are required. Check access and retry.
          </p>
        </SectionCard>
      </div>
    );
  const current = data.versions[0];
  const settings = current
    ? prepaidTierSettings.parse({ tiers: current.tiers, refundable: current.refundable })
    : { tiers: [], refundable: false };
  return (
    <div className="min-w-0 space-y-6">
      {header}
      <Link
        href="/pharmacy/loyalty"
        className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        Loyalty points
      </Link>
      <SectionCard title="Customer money held" titleLevel={2}>
        <Stat label="Prepaid liability" value={`PKR ${formatMinor(data.liabilityMinor)}`} />
        <p className="mt-3 text-sm text-text-muted">
          Customer funds owed across all branches. Receiving an upfront payment creates a liability;
          wallet spending reduces it.
        </p>
      </SectionCard>
      <SectionCard title="Tier settings" titleLevel={2}>
        <TierSettingsForm tiers={settings.tiers} refundable={settings.refundable} />
        {current && (
          <p className="mt-4 text-sm text-text-muted">
            Version {current.version} · effective {formatUtcInstant(current.effectiveFrom)}
          </p>
        )}
        {data.versions.length > 1 && (
          <details className="mt-4">
            <summary className="cursor-pointer py-3">Dated settings history</summary>
            {data.versions.map((v) => (
              <p key={v.id} className="break-words py-2 text-sm">
                Version {v.version} · {formatUtcInstant(v.effectiveFrom)} ·{' '}
                {v.refundable ? 'Refundable' : 'Non-refundable'} ·{' '}
                {prepaidTierSettings
                  .parse({ tiers: v.tiers, refundable: v.refundable })
                  .tiers.map(
                    (t) =>
                      `${t.name}: PKR ${formatMinor(t.upfrontMinor)}, ${t.discountBasisPoints / 100}%`
                  )
                  .join('; ') || 'No tiers'}
              </p>
            ))}
          </details>
        )}
      </SectionCard>
      <SectionCard title="Receive or refund prepaid cash" titleLevel={2}>
        <PrepaidPaymentForm
          paymentReference={randomUUID()}
          drawers={data.drawers}
          customers={data.customers}
          branches={data.branches}
          customerId={customerId}
        />
      </SectionCard>
      <SectionCard title="Customer balances" titleLevel={2}>
        {!data.customers.length ? (
          <p>No matching active customer. Link a consenting customer at the counter first.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="font-mono text-xs uppercase">
                <tr>
                  <th className="p-3 text-left">Customer</th>
                  <th className="p-3 text-left">Tier</th>
                  <th className="p-3 text-right">Balance (PKR)</th>
                  <th className="p-3 text-right">Refundable (PKR)</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((c) => (
                  <tr key={c.id} className="border-t border-border-subtle hover:bg-surface-sunken">
                    <td className="p-3">
                      <Link
                        className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
                        href={`/pharmacy/loyalty/prepaid?customerId=${encodeURIComponent(c.id)}`}
                      >
                        {c.displayName}
                      </Link>
                    </td>
                    <td className="p-3">{c.prepaidAccount?.tierName ?? 'None'}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatMinor(c.prepaidAccount?.balanceMinor ?? 0)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {formatMinor(c.prepaidAccount?.refundableMinor ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-sm text-text-muted">
          Showing up to 50 customers. Open a customer from the loyalty console to view their ledger.
        </p>
      </SectionCard>
      {customerId && (
        <SectionCard title="Prepaid ledger" titleLevel={2}>
          {data.entries.length ? (
            data.entries.map((e) => (
              <div key={e.id} className="break-words border-b border-border-subtle py-3 text-sm">
                <p>
                  {formatUtcInstant(e.createdAt)} · {e.kind} · PKR {formatMinor(e.amountMinor)}
                </p>
                <p>
                  Balance: PKR {formatMinor(e.balanceAfterMinor)} · Tier: {e.tierBefore ?? 'None'} →{' '}
                  {e.tierAfter ?? 'None'}
                </p>
                {e.refundable !== null && (
                  <p>{e.refundable ? 'Refundable' : 'Non-refundable'} upfront payment</p>
                )}
                <p>Reference: {e.id}</p>
              </div>
            ))
          ) : (
            <p>No prepaid entries yet.</p>
          )}
        </SectionCard>
      )}
    </div>
  );
}
async function loadPrepaid(customerId?: string) {
  try {
    const caller = pharmacyPrepaidRouter.createCaller(await createTRPCContext());
    return await caller.overview({ customerId });
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}
