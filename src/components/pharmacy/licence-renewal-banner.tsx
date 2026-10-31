'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { describeRenewalDue, type RenewalReminder } from '@/lib/pharmacy/licence-renewal';
import { trpc } from '@/lib/trpc';

const linkClass =
  'text-sm font-medium text-text-strong underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function stageLabel(reminder: RenewalReminder) {
  return reminder.expired ? 'Expired' : `${reminder.stage}-day reminder`;
}

function renewHref(reminder: RenewalReminder) {
  return reminder.kind === 'SUPPLIER_LICENCE'
    ? '/pharmacy/purchasing/suppliers'
    : `/pharmacy/regulatory?branch=${encodeURIComponent(reminder.branchId ?? reminder.subjectId)}`;
}

/**
 * #720 — dashboard banner for licences inside their 90-day renewal window.
 *
 * Renders nothing while loading or when nothing is due, so a workspace with
 * current licences sees no extra chrome. A failed read is said out loud rather
 * than hidden, because silence would read as "nothing to renew".
 */
export function LicenceRenewalBanner({ branchId }: { branchId?: string }) {
  const query = trpc.pharmacyReports.licenceRenewals.useQuery(branchId ? { branchId } : {}, {
    retry: false,
    // Recheck on return even while the shared 60-second cache is still fresh.
    refetchOnMount: 'always',
  });

  if (query.error) {
    const denied = ['FORBIDDEN', 'UNAUTHORIZED'].includes(query.error.data?.code ?? '');
    if (denied) return null;
    return (
      <SectionCard eyebrow="Licence renewals" title="Renewal reminders unavailable" titleLevel={2}>
        <div role="alert" className="space-y-3">
          <p className="text-sm text-text-body">
            Renewal reminders could not load. Licence dates are still on the branch regulatory
            profile and supplier records.
          </p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      </SectionCard>
    );
  }

  const reminders = query.data?.reminders ?? [];
  if (!reminders.length) return null;
  const urgent = reminders.some((reminder) => reminder.expired || reminder.daysLeft <= 7);

  return (
    <section aria-label="Licence renewals due" data-testid="licence-renewal-banner">
      <SectionCard
        eyebrow="Licence renewals"
        title={`${reminders.length} licence${reminders.length === 1 ? '' : 's'} due for renewal`}
        titleLevel={2}
        actions={
          <StatusPill
            status={urgent ? 'Renew now' : 'Renewal due'}
            tone={urgent ? 'danger' : 'warning'}
          />
        }
      >
        <p className="mb-4 max-w-2xl text-sm leading-6 text-text-body">
          Sales stop when a branch licence or qualified-person registration lapses. Start each
          renewal early: the inspection comes before the new licence.
        </p>
        <ul className="divide-y divide-border-subtle">
          {reminders.map((reminder) => (
            <li
              key={`${reminder.kind}:${reminder.subjectId}`}
              className="space-y-2 py-3 [overflow-wrap:anywhere]"
              data-renewal-kind={reminder.kind}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto min-w-0 max-w-full text-sm font-medium text-text-strong">
                  {reminder.label}{' '}
                  <span className="font-mono text-xs text-text-muted">{reminder.reference}</span>
                </span>
                <StatusPill
                  status={stageLabel(reminder)}
                  tone={reminder.expired || reminder.daysLeft <= 7 ? 'danger' : 'warning'}
                />
              </div>
              <p className="text-sm text-text-body">
                {sentence(describeRenewalDue(reminder))}
                {reminder.checklist.fee ? ` · Renewal fee ${reminder.checklist.fee}` : ''}
              </p>
              <details className="text-sm text-text-body">
                <summary className="cursor-pointer font-medium text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Renewal checklist
                  {reminder.checklist.province ? ` · ${reminder.checklist.province}` : ''}
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {reminder.checklist.documents.map((document) => (
                    <li key={document}>{document}</li>
                  ))}
                </ul>
                {reminder.checklist.provisional ? (
                  <p className="mt-2 text-xs text-text-muted">
                    Confirm current documents and fees with the district Drug Inspector before
                    applying.
                  </p>
                ) : null}
              </details>
              <Link className={linkClass} href={renewHref(reminder)}>
                {reminder.kind === 'SUPPLIER_LICENCE'
                  ? 'Record the renewed supplier licence'
                  : 'Record the renewal on the regulatory profile'}
              </Link>
            </li>
          ))}
        </ul>
      </SectionCard>
    </section>
  );
}
