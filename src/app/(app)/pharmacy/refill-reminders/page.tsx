import { PageHeader } from '@/components/ui/page-header';
import { UpcomingReminders } from './upcoming-reminders';

export const metadata = { title: 'Refill reminders · Pharmacy' };

export default function RefillRemindersPage() {
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        eyebrowMuted
        heading="Refill reminders"
        description="Review upcoming purchase-cadence reminders before any opted-in customer is contacted."
      />
      <UpcomingReminders reminders={[]} />
    </main>
  );
}
