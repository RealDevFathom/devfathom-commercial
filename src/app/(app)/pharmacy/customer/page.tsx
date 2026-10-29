import type { Metadata } from 'next';
import Link from 'next/link';
import { CreditCard, FileImage, Gift, History, RefreshCw } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

export const metadata: Metadata = {
  title: 'My pharmacy',
  manifest: '/pharmacy-customer.webmanifest',
};

const actions = [
  {
    title: 'Receipts',
    body: 'Find a customer and reprint an itemised receipt at the counter.',
    icon: History,
    href: '/pharmacy/counter',
  },
  {
    title: 'Request a refill',
    body: 'Ask the pharmacy team to review a previous purchase.',
    icon: RefreshCw,
    href: '/pharmacy/prescriptions',
  },
  {
    title: 'Order with a photo',
    body: 'Upload your Rx. Nothing is fulfilled until a pharmacist verifies it.',
    icon: FileImage,
    href: '/pharmacy/prescriptions',
  },
  {
    title: 'Pay khata with Raast',
    body: 'Review your balance and open your store’s verified Raast payment details.',
    icon: CreditCard,
    href: '/pharmacy/counter',
  },
  {
    title: 'Loyalty balance',
    body: 'See your points ledger and available non-drug offers.',
    icon: Gift,
    href: '/pharmacy/loyalty',
  },
];

export default function PharmacyCustomerPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Customer portal"
        heading="Customer service hub"
        description="Your private receipts, requests, payments and rewards in one installable link."
      />
      <SectionCard title="Workspace security">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status="protected" tone="success" label="Staff workspace" />
          <p className="text-sm text-text-muted">
            Customer identity must be verified in the destination workflow. This page never treats a
            staff session as a customer session.
          </p>
        </div>
      </SectionCard>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {actions.map(({ title, body, icon: Icon, href }) => (
          <SectionCard key={title} title={title}>
            <div className="flex gap-3">
              <Icon aria-hidden className="mt-0.5 size-5 text-accent-brand" />
              <p className="text-sm leading-6 text-text-muted">{body}</p>
            </div>
            <Link
              className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}
              href={href}
            >
              Open workflow
            </Link>
          </SectionCard>
        ))}
      </div>
      <SectionCard title="Pharmacist verification">
        <p className="text-sm text-text-muted">
          For urgent care or clinical advice, contact the pharmacy directly. This portal does not
          advertise drugs or provide medical advice.
        </p>
      </SectionCard>
    </div>
  );
}
