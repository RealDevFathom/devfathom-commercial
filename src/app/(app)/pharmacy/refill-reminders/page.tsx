import { PageHeader } from '@/components/ui/page-header';
import { RefillReviewQueue } from './refill-review-queue';

export const metadata = { title: 'Refill reminders · Pharmacy' };

export default function RefillRemindersPage() {
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy · G9"
        heading="Refill reminders"
        description="Capture a dispensed fill, review its due date, then approve it for mock scheduling. No external messages are sent."
      />
      <RefillReviewQueue />
    </main>
  );
}
