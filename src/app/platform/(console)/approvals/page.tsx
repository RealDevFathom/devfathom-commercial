import Link from 'next/link';
import { ArrowRight, CircleDashed } from 'lucide-react';

import { PharmacyApprovalForm } from '@/components/platform/pharmacy-approval-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { requirePlatformRead } from '@/lib/platform/page-access';
import {
  readPharmacyApprovalQueue,
  type PharmacyApprovalQueueEntry,
} from '@/lib/platform/pharmacy-approval-queue';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

function Identity({ entry }: { entry: PharmacyApprovalQueueEntry }) {
  return (
    <div className="min-w-0">
      <Link
        href={`/platform/organizations/${entry.id}`}
        className="font-semibold text-text-strong hover:text-accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {entry.displayName}
      </Link>
      <p className="mt-1 font-mono text-[10px] text-text-muted">
        {entry.slug} · {entry.legalName} · onboarding since {dateFormat.format(entry.createdAt)}
      </p>
    </div>
  );
}

function OpenGates({ entry }: { entry: PharmacyApprovalQueueEntry }) {
  return (
    <div>
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-text-muted">
        Checks not met
      </p>
      <ul className="mt-2 space-y-2">
        {entry.openGates.map((gate) => (
          <li
            key={gate.key}
            className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-body"
          >
            <span className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
              {gate.label}
            </span>
            <Link
              href={gate.href}
              aria-label={`Review ${gate.label} for ${entry.displayName}`}
              className="font-semibold text-accent-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Review
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function plural(count: number) {
  return `${count} ${count === 1 ? 'pharmacy' : 'pharmacies'}`;
}

/**
 * DEV-905 — the super admin's pharmacy approval queue.
 *
 * Pharmacy organizations in ONBOARDING, oldest first, a page at a time: those that meet
 * every check, then those still onboarding with the checks they do not meet. Owner
 * decision (18 Nov): approval is totally manual and may be given past unmet checks, so
 * every pharmacy here can be approved; one with unmet checks only after the operator
 * confirms them by name. Nothing here approves automatically.
 */
export default async function PharmacyApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<{ after?: string | string[] }>;
}) {
  await requirePlatformRead('/platform/approvals');
  const query = (await searchParams) ?? {};
  const after = typeof query.after === 'string' && query.after ? query.after : null;
  const queue = await withPlatformDb((db) => readPharmacyApprovalQueue(db, { after }));
  const shown = queue.ready.length + queue.onboarding.length;
  const morePages = Boolean(queue.nextCursor) || queue.paged;

  return (
    <div className="mx-auto max-w-[1480px] space-y-7">
      <PlatformPageHeading
        eyebrow="Organizations / pharmacy approvals"
        title="Awaiting approval"
        description="Pharmacies in onboarding, oldest first. Approval is always a manual decision; checks that are not met are shown for you to confirm before you approve past them."
      />

      <p className="text-sm text-text-muted" data-approval-summary="">
        {queue.total === 0
          ? 'No pharmacy is waiting for approval.'
          : morePages
            ? `Showing ${shown} of ${plural(queue.total)} waiting.`
            : `${plural(queue.total)} waiting.`}
      </p>

      <SectionCard
        eyebrow="Ready to approve"
        title={`${plural(queue.ready.length)} meeting every check${morePages ? ' on this page' : ''}`}
        titleLevel={2}
        actions={<StatusPill status="ready" tone="success" label="All checks met" />}
        role="region"
        aria-label="Ready to approve"
        data-approval-group="ready"
      >
        {queue.ready.length ? (
          <ul className="divide-y divide-border-subtle">
            {queue.ready.map((entry) => (
              <li
                key={entry.id}
                data-organization-id={entry.id}
                className="grid gap-4 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]"
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <Identity entry={entry} />
                  <PlatformStatus value="ONBOARDING" />
                </div>
                <PharmacyApprovalForm
                  organizationId={entry.id}
                  organizationName={entry.displayName}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">
            {queue.nextCursor
              ? 'No pharmacy on this page meets every check yet. Later pages may hold more.'
              : 'No pharmacy meets every check yet. A pharmacy appears here once every activation and onboarding check has passed.'}
          </p>
        )}
      </SectionCard>

      <SectionCard
        eyebrow="Still onboarding"
        title={`${plural(queue.onboarding.length)} with checks not met${morePages ? ' on this page' : ''}`}
        titleLevel={2}
        actions={<StatusPill status="blocked" tone="warning" label="Checks not met" />}
        role="region"
        aria-label="Still onboarding"
        data-approval-group="onboarding"
      >
        {queue.onboarding.length ? (
          <ul className="divide-y divide-border-subtle">
            {queue.onboarding.map((entry) => (
              <li
                key={entry.id}
                data-organization-id={entry.id}
                className="grid gap-4 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]"
              >
                <div className="min-w-0 space-y-4">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                    <Identity entry={entry} />
                    <PlatformStatus value="ONBOARDING" />
                  </div>
                  <OpenGates entry={entry} />
                </div>
                <PharmacyApprovalForm
                  organizationId={entry.id}
                  organizationName={entry.displayName}
                  unmetChecks={entry.openGates.map(({ key, label }) => ({ key, label }))}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">
            {queue.nextCursor
              ? 'No pharmacy on this page is still onboarding. Later pages may hold more.'
              : 'No pharmacy is still onboarding.'}
          </p>
        )}
      </SectionCard>

      {morePages ? (
        <nav aria-label="Approval queue pages" className="flex flex-wrap justify-end gap-3">
          {queue.paged ? (
            <Link
              href="/platform/approvals"
              className="inline-flex min-h-11 items-center rounded-md border border-border-subtle px-4 text-sm font-semibold text-text-strong hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Oldest first
            </Link>
          ) : null}
          {queue.nextCursor ? (
            <Link
              href={`/platform/approvals?after=${encodeURIComponent(queue.nextCursor)}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-4 text-sm font-semibold text-text-strong hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Next page
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
