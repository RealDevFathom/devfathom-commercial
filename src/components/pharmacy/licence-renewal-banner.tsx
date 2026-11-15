import Link from 'next/link';

import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { renewalKindLabel, type RenewalReminder } from '@/lib/pharmacy/licence-renewal';

const dayFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

const linkClass = 'font-medium text-primary underline underline-offset-4 hover:text-accent-brand';

function dueLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'Expired';
  return daysLeft === 1 ? '1 day left' : `${daysLeft} days left`;
}

/**
 * #720 — the workspace-home banner for licences and registrations inside a
 * 90/60/30/7-day renewal window, each with its renewal checklist. Renders
 * nothing when nothing is due, so it disappears once the renewal is saved.
 */
export function LicenceRenewalBanner({
  reminders,
}: {
  reminders: ReadonlyArray<Omit<RenewalReminder, 'validTo'> & { validTo: Date | string }>;
}) {
  if (reminders.length === 0) return null;
  const soonest = reminders[0]!;
  return (
    <SectionCard
      title="Licence renewals due"
      titleLevel={2}
      compact
      className="border-warning/40"
      actions={
        <StatusPill
          status={soonest.daysLeft <= 7 ? 'URGENT' : 'DUE'}
          label={dueLabel(soonest.daysLeft)}
          tone={soonest.daysLeft <= 7 ? 'danger' : 'warning'}
        />
      }
    >
      <ul className="space-y-4" aria-label="Licence renewals due">
        {reminders.map((reminder) => (
          <li
            key={`${reminder.kind}:${reminder.holder}:${reminder.reference}`}
            className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-text-body"
          >
            <p>
              <span className="font-medium">{renewalKindLabel(reminder.kind)}</span> ·{' '}
              {reminder.holder} · {reminder.reference} —{' '}
              {reminder.daysLeft <= 0 ? 'expired' : 'expires'}{' '}
              {dayFormat.format(new Date(reminder.validTo))} ({dueLabel(reminder.daysLeft)})
            </p>
            <details>
              <summary className="cursor-pointer font-medium">
                Renewal checklist · {reminder.checklist.province}
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-text-muted">
                {reminder.checklist.documents.map((document) => (
                  <li key={document}>{document}</li>
                ))}
                {reminder.checklist.fee ? <li>Fee: {reminder.checklist.fee}</li> : null}
                {reminder.checklist.inspection ? (
                  <li>The licensing authority inspects the premises before renewal</li>
                ) : null}
              </ul>
            </details>
            <Link
              className={linkClass}
              href={
                reminder.kind === 'SUPPLIER_LICENCE'
                  ? '/pharmacy/purchasing/suppliers'
                  : '/pharmacy/regulatory'
              }
            >
              {reminder.kind === 'SUPPLIER_LICENCE'
                ? 'File the renewed supplier licence'
                : 'Save the renewed licence'}
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
