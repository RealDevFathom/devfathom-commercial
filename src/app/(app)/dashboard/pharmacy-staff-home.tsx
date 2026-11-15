import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { PharmacyStaffHome as PharmacyStaffHomeData } from '@/lib/pharmacy/staff-home';
import { cn } from '@/lib/utils';

function openedTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * DEV-20: the dashboard for pharmacy staff who do not run the business (cashier,
 * pharmacist, procurement, inventory). It shows only the work their own grants allow
 * and their own open shift, never the Owner command centre.
 */
export function PharmacyStaffHome({ home }: { home: PharmacyStaffHomeData }) {
  const counter = home.links.find((link) => link.key === 'counter');
  const others = home.links.filter((link) => link.key !== 'counter');
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Pharmacy workspace"
        heading="Your work today"
        description="Start from the tools your role allows. Owner reports stay with the owner and managers."
        actions={
          counter ? (
            <Link
              href={counter.href}
              className={buttonVariants({ size: 'touch', className: 'px-4' })}
            >
              {counter.label}
              <ArrowRight aria-hidden data-icon="inline-end" />
            </Link>
          ) : null
        }
      />
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <SectionCard
          eyebrow="Shift"
          title="Your shift"
          titleLevel={2}
          actions={
            <StatusPill
              status={home.shifts.length ? 'Open' : 'No open shift'}
              tone={home.shifts.length ? 'success' : 'neutral'}
            />
          }
        >
          {home.shifts.length ? (
            <ul className="divide-y divide-border-subtle">
              {home.shifts.map((shift) => (
                <li key={shift.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                  <span className="mr-auto text-sm font-medium text-text-strong">
                    {shift.branchName}
                  </span>
                  <span className="font-mono text-xs text-text-muted">
                    Business date {shift.businessDate}
                  </span>
                  <span className="font-mono text-xs text-text-muted">
                    Opened{' '}
                    <time dateTime={shift.openedAt}>
                      {openedTime(shift.openedAt, home.timeZone)}
                    </time>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm leading-6 text-text-body">
              {counter
                ? 'You have no open cash drawer. Open one from the Counter when your shift starts.'
                : 'You have no open cash drawer.'}
            </p>
          )}
        </SectionCard>
        <SectionCard eyebrow="Scope" title="Your branches" titleLevel={2}>
          {home.branches.length ? (
            <ul className="divide-y divide-border-subtle">
              {home.branches.map((branch) => (
                <li key={branch.id} className="py-3 text-sm font-medium text-text-strong">
                  {branch.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm leading-6 text-text-body">
              You are not assigned to a branch yet. Ask your owner or manager to assign you before
              you sell or dispense.
            </p>
          )}
        </SectionCard>
      </div>
      {others.length ? (
        <SectionCard eyebrow="Your tools" title="Other work" titleLevel={2}>
          <ul className="grid gap-3 sm:grid-cols-2">
            {others.map((link) => (
              <li key={link.key}>
                <Link
                  href={link.href}
                  className={cn(
                    'flex h-full min-h-11 flex-col gap-1 rounded-md border border-border-subtle bg-surface-raised p-4',
                    'transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  )}
                >
                  <span className="text-sm font-medium text-text-strong">{link.label}</span>
                  <span className="text-sm text-text-muted">{link.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      {home.links.length === 0 ? (
        <SectionCard eyebrow="Access" title="No pharmacy tools assigned" titleLevel={2}>
          <p role="status" className="text-sm leading-6 text-text-body">
            No counter, dispensing, purchasing, inventory or reports work is available to your role
            in this workspace yet. Ask your owner or manager to update your role.
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}
