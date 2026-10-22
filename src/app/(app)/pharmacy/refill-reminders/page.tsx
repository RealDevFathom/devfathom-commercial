import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/page-header';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

import { REFILL_REMINDER_COPY, refillReminderLocale } from './refill-reminder-copy';
import { UpcomingReminders } from './upcoming-reminders';

async function activeCopy() {
  const actor = await resolveTenantActor();
  const locale = refillReminderLocale(actor?.organization.locale);
  return { copy: REFILL_REMINDER_COPY[locale], locale };
}

export async function generateMetadata(): Promise<Metadata> {
  const { copy } = await activeCopy();
  return { title: copy.metadataTitle };
}

export default async function RefillRemindersPage() {
  const { copy, locale } = await activeCopy();

  return (
    <main
      className="min-w-0 space-y-6"
      lang={locale}
      dir={locale === 'ur' ? 'rtl' : 'ltr'}
    >
      <PageHeader
        eyebrow={copy.eyebrow}
        eyebrowMuted
        heading={copy.heading}
        description={copy.description}
      />
      <UpcomingReminders reminders={[]} locale={locale} />
    </main>
  );
}
