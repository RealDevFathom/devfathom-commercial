import Link from 'next/link';
import { Monitor } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { workspaceTimezone } from '@/lib/timezone';

/** One open drawer this member opened — their own shift, never anyone else's. */
export type PharmacyCashierShift = {
  id: string;
  branchLabel: string;
  openedAt: Date | string;
  openingFloatMinor: number;
};

/**
 * The pharmacy home for a member without the owner command centre (a cashier):
 * a clear way into the Counter and the shift they have open. It asks for no
 * report, branch-list or management data.
 */
export function PharmacyCashierHome({
  counterAvailable,
  shifts,
  timeZone,
  currency,
}: {
  counterAvailable: boolean;
  shifts: readonly PharmacyCashierShift[];
  timeZone: string | null | undefined;
  currency: string | null | undefined;
}) {
  const zone = workspaceTimezone(timeZone);
  const money = (minor: number) => `${currency || 'PKR'} ${formatMinor(minor)}`;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Pharmacy workspace"
        heading="Your counter"
        description="Serve customers at the counter and keep track of your own shift."
        actions={
          counterAvailable ? (
            <Link href="/pharmacy/counter" className={buttonVariants({ size: 'touch' })}>
              <Monitor aria-hidden />
              Open Counter
            </Link>
          ) : null
        }
      />
      <SectionCard eyebrow="Counter" title="Start selling" titleLevel={2}>
        {counterAvailable ? (
          <>
            <p className="max-w-2xl text-sm leading-6 text-text-body">
              Search medicines, take payment and print receipts from the Counter. Open your drawer
              there at the start of your shift.
            </p>
            <Link
              href="/pharmacy/counter"
              className={buttonVariants({ variant: 'outline', size: 'touch', className: 'mt-4' })}
            >
              Go to Counter
            </Link>
          </>
        ) : (
          <p role="status" className="max-w-2xl text-sm leading-6 text-text-body">
            The Counter is not part of your organization’s package. Ask a manager or owner for
            access.
          </p>
        )}
      </SectionCard>
      <SectionCard
        eyebrow="My shift"
        title="Your open drawer"
        titleLevel={2}
        actions={
          <StatusPill
            status={shifts.length ? 'Open' : 'No open drawer'}
            tone={shifts.length ? 'success' : 'neutral'}
          />
        }
      >
        {shifts.length ? (
          <ul className="divide-y divide-border-subtle">
            {shifts.map((shift) => (
              <li key={shift.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                <span className="mr-auto text-sm font-medium text-text-strong">
                  {shift.branchLabel}
                </span>
                <span className="font-mono text-xs text-text-muted">
                  Opened{' '}
                  {new Date(shift.openedAt).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: zone,
                  })}
                </span>
                <span className="font-mono text-xs text-text-muted">
                  Float {money(shift.openingFloatMinor)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-body">
            You have no drawer open. Open one from the Counter to start your shift.
          </p>
        )}
      </SectionCard>
    </div>
  );
}
