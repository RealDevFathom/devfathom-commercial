import Link from 'next/link';
import type * as React from 'react';

import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { PURCHASING_TABS, type Notice } from '../_lib/console';

/**
 * The chrome every PH-PUR surface shares: one header, one tab rail, one place a
 * notice appears. Kept here rather than in a route `layout.tsx` because the tab
 * rail has to know which surface is active and a layout does not receive the
 * page's own state.
 */

export function PurchasingHeader({
  heading,
  description,
  actions,
}: {
  heading: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <PageHeader
      eyebrow="Pharmacy procurement"
      heading={heading}
      description={description}
      actions={actions}
    />
  );
}

/**
 * UX rule 3: the active tab stays a control. It remains a link, keeps its focus
 * ring, and says it is current with `aria-current` — rendering it as inert text
 * is what made a working selection look dead twice before.
 */
export function PurchasingTabs({ active }: { active: string }) {
  return (
    <nav aria-label="Purchasing surfaces" className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max items-center gap-1 px-1">
        {PURCHASING_TABS.map((tab) => {
          const current = tab.href === active;
          return (
            <li key={tab.href}>
              <Link
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] px-3 text-sm font-medium whitespace-nowrap transition-colors',
                  'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
                  current
                    ? 'bg-primary text-primary-foreground'
                    : 'text-text-muted hover:bg-muted hover:text-text-strong'
                )}
                href={tab.href}
              >
                {tab.label}
                <span className="font-mono text-[0.625rem]">{tab.requirement}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * UX rule 9 / rule 11: the outcome of the last action, in words, at the top of
 * the surface — and `role="alert"` so a screen reader hears it without hunting.
 */
export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const error = notice.kind === 'error';
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-[var(--radius-sm)] border p-3 text-sm',
        error
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-success/40 bg-success/10 text-success'
      )}
      role={error ? 'alert' : 'status'}
    >
      <StatusPill
        status={error ? 'Failed' : 'Done'}
        tone={error ? 'danger' : 'success'}
        className="mt-0.5"
      />
      <p className="min-w-0 flex-1 text-text-body">{notice.message}</p>
    </div>
  );
}

/**
 * UX rule 7: "not licensed" and "not permitted" are different sentences with
 * different next steps, and neither is "no data".
 */
export function AccessState({
  moduleEnabled,
  heading,
  description,
  requirement,
}: {
  moduleEnabled: boolean;
  heading: string;
  description: string;
  /** Names the missing permission when it is not the procurement capability. */
  requirement?: string;
}) {
  return (
    <div className="min-w-0 space-y-6">
      <PurchasingHeader heading={heading} description={description} />
      <SectionCard
        title={
          moduleEnabled
            ? 'You do not have purchasing access'
            : 'Pharmacy Procurement is not licensed'
        }
        titleLevel={2}
      >
        <p className="text-sm text-text-muted">
          {moduleEnabled
            ? (requirement ??
              'Purchasing and receiving are restricted to users with the procurement capability. Ask a workspace administrator to add it to your role.')
            : 'This workspace does not include the Pharmacy Procurement module, so suppliers, orders and goods-in are unavailable. A workspace administrator can add it to the plan.'}
        </p>
        <p className="mt-3 text-sm text-text-muted">
          {moduleEnabled
            ? 'Nothing on this page has been hidden because of missing data — the surface itself is closed to your role.'
            : 'This is a licensing limit, not a usage limit: no allowance has been consumed.'}
        </p>
      </SectionCard>
    </div>
  );
}

/** UX rule 9: an error state says what failed and what to do about it. */
export function LoadFailure({ detail, retryHref }: { detail: string; retryHref: string }) {
  return (
    <SectionCard title="This surface could not load" titleLevel={2}>
      <p className="text-sm text-text-muted">{detail}</p>
      <p className="mt-2 text-sm text-text-muted">No data was changed.</p>
      <Link
        className="mt-4 inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border border-border-default px-4 text-sm font-medium text-text-strong hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
        href={retryHref}
      >
        Try again
      </Link>
    </SectionCard>
  );
}

/**
 * UX rule 9: an empty state says how to populate it. UX rule 12 and 13: when a
 * prerequisite is missing it is a checklist with links, not a sentence.
 */
export function EmptyState({
  title,
  detail,
  steps,
}: {
  title: string;
  detail: string;
  steps?: { label: string; href: string }[];
}) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-dashed border-border-default p-6">
      <h3 className="font-medium text-text-strong">{title}</h3>
      <p className="mt-2 text-sm text-text-muted">{detail}</p>
      {steps?.length ? (
        <ul className="mt-4 space-y-2">
          {steps.map((step) => (
            <li key={step.href}>
              <Link
                className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                href={step.href}
              >
                <span aria-hidden>→</span>
                {step.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
