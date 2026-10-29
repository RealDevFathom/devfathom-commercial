import type { Metadata } from 'next';
import { CreditCard, FileImage, Gift, History, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

export const metadata: Metadata = {
  title: 'My pharmacy',
  manifest: '/pharmacy-customer.webmanifest',
};

const actions = [
  { title: 'Receipts', body: 'View your itemised purchase history and receipts.', icon: History },
  {
    title: 'Request a refill',
    body: 'Ask the pharmacy team to review a previous purchase.',
    icon: RefreshCw,
  },
  {
    title: 'Order with a photo',
    body: 'Upload your Rx. Nothing is fulfilled until a pharmacist verifies it.',
    icon: FileImage,
  },
  {
    title: 'Pay khata with Raast',
    body: 'Review your balance and open your store’s verified Raast payment details.',
    icon: CreditCard,
  },
  {
    title: 'Loyalty balance',
    body: 'See your points ledger and available non-drug offers.',
    icon: Gift,
  },
];

export default function PharmacyCustomerPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Customer portal"
        title="My pharmacy"
        description="Your private receipts, requests, payments and rewards in one installable link."
      />
      <SectionCard
        title="Account security"
        description="This customer view is scoped to your signed-in account."
      >
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status="verified" tone="success" label="Verified customer" />
          <p className="text-sm text-text-muted">
            WhatsApp and SMS messages contain only a secure-link update—never product or clinical
            details.
          </p>
        </div>
      </SectionCard>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {actions.map(({ title, body, icon: Icon }) => (
          <SectionCard key={title} title={title}>
            <div className="flex gap-3">
              <Icon aria-hidden className="mt-0.5 size-5 text-accent-brand" />
              <p className="text-sm leading-6 text-text-muted">{body}</p>
            </div>
          </SectionCard>
        ))}
      </div>
      <SectionCard
        title="Pharmacist verification"
        description="Photo orders remain requests until a pharmacist reviews and approves them."
      >
        <p className="text-sm text-text-muted">
          For urgent care or clinical advice, contact the pharmacy directly. This portal does not
          advertise drugs or provide medical advice.
        </p>
      </SectionCard>
    </div>
  );
}
