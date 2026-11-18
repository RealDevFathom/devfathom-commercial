import Link from 'next/link';
import { CircleDashed } from 'lucide-react';

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

/**
 * DEV-905 — the super admin's pharmacy approval queue.
 *
 * Pharmacy organizations in ONBOARDING, oldest first: those ready to approve, each with
 * "Approve pharmacy" and an optional note, then those still onboarding with the gates
 * that are not passed. Approval runs the existing lifecycle transition to ACTIVE, so the
 * server re-checks every activation gate; nothing here approves automatically.
 */
export default async function PharmacyApprovalsPage() {
  await requirePlatformRead('/platform/approvals');
  const queue = await withPlatformDb((db) => readPharmacyApprovalQueue(db));

  return (
    <div className="mx-auto max-w-[1480px] space-y-7">
      <PlatformPageHeading
        eyebrow="Organizations / pharmacy approvals"
        title="Awaiting approval"
        description="Pharmacies in onboarding, oldest first. Approve a ready pharmacy by hand; the server re-checks every activation gate before it goes live."
      />

      <SectionCard
        eyebrow="Ready to approve"
        title={`${queue.ready.length} ${queue.ready.length === 1 ? 'pharmacy' : 'pharmacies'} ready`}
        titleLevel={2}
        actions={<StatusPill status="ready" tone="success" label="All gates passed" />}
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
            No pharmacy has finished onboarding yet. Pharmacies appear here once every activation
            gate has passed.
          </p>
        )}
      </SectionCard>

      <SectionCard
        eyebrow="Still onboarding"
        title={`${queue.onboarding.length} ${queue.onboarding.length === 1 ? 'pharmacy' : 'pharmacies'} with open gates`}
        titleLevel={2}
        actions={<StatusPill status="blocked" tone="warning" label="Not ready" />}
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
                className="grid gap-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]"
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <Identity entry={entry} />
                  <PlatformStatus value="ONBOARDING" />
                </div>
                <div>
                  <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-text-muted">
                    Gates not passed
                  </p>
                  <ul className="mt-2 space-y-2">
                    {entry.openGates.map((gate) => (
                      <li
                        key={gate.key}
                        className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-body"
                      >
                        <span className="flex items-center gap-2">
                          <CircleDashed
                            className="h-3.5 w-3.5 shrink-0 text-warning"
                            aria-hidden="true"
                          />
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
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No pharmacy is still onboarding.</p>
        )}
      </SectionCard>
    </div>
  );
}
