import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

export type UpcomingReminder = {
  id: string;
  customerName: string;
  medicineName: string;
  reminderAt: Date;
  draftText: string;
};

export function UpcomingReminders({ reminders }: { reminders: readonly UpcomingReminder[] }) {
  return (
    <SectionCard title="Upcoming reminders" titleLevel={2}>
      <div className="mb-4 flex items-center gap-3">
        <StatusPill status="AI" label="DevFathom AI" />
        <p className="text-sm text-text-muted">
          Drafts use purchase history only. Review and approve each message before sending.
        </p>
      </div>
      {reminders.length === 0 ? (
        <p className="rounded-md border border-border-subtle bg-surface-sunken p-4 text-sm text-text-body">
          No reminders are ready for review.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle" aria-label="Upcoming AI refill reminders">
          {reminders.map((reminder) => (
            <li key={reminder.id} className="py-5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-2">
                  <p className="font-medium text-text-strong">
                    {reminder.customerName} · {reminder.medicineName}
                  </p>
                  <p className="text-xs font-mono text-text-muted">
                    Suggested {reminder.reminderAt.toLocaleDateString()}
                  </p>
                  <p className="max-w-3xl text-sm text-text-body">{reminder.draftText}</p>
                </div>
                <form className="flex gap-2">
                  <input type="hidden" name="reminderId" value={reminder.id} />
                  <Button type="submit" name="decision" value="APPROVED">
                    Approve
                  </Button>
                  <Button type="submit" name="decision" value="SKIPPED" variant="secondary">
                    Skip
                  </Button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
