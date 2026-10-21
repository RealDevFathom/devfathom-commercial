import Link from 'next/link';

import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export function GrowthDenied({ reason }: { reason: 'flag' | 'permission' }) {
  const flagOff = reason === 'flag';
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Growth"
        eyebrowMuted
        heading={flagOff ? 'Growth is off' : 'Growth is closed'}
        description={
          flagOff
            ? '403. Growth AI is off for this shop, so these pages stay closed.'
            : '403. This page is for an owner or manager. Cashiers stay on the counter.'
        }
      />
      <SectionCard title={flagOff ? 'Turn on Growth AI' : 'Permission needed'} titleLevel={2}>
        <p className="text-sm leading-relaxed text-text-body">
          {flagOff
            ? 'An owner can enable the growth_ai module for the shop. Until then, no campaigns are proposed or sent.'
            : 'growth.manage is not on this sign-in. Ask an owner if you should be approving WhatsApp campaigns.'}
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          Back to the dashboard
        </Link>
      </SectionCard>
    </div>
  );
}

export function GrowthUnavailable() {
  return (
    <SectionCard title="Growth could not be loaded" titleLevel={2}>
      <p role="alert" className="text-sm text-text-body">
        The shop growth data did not load. Reload to try again.
      </p>
      <Link
        href="/growth"
        className="mt-4 inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
      >
        Reload growth
      </Link>
    </SectionCard>
  );
}
