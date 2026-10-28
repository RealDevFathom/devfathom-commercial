import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';

import { buttonVariants } from '@/components/ui/button';
import { GrowthDenied, GrowthUnavailable } from '@/components/growth/growth-denied';
import { GrowthInbox } from '@/components/growth/growth-inbox';
import { karachiInputValue } from '@/components/growth/format';
import { cn } from '@/lib/utils';
import type {
  GrowthCampaign,
  GrowthConnection,
  GrowthTab,
  GrowthTemplate,
} from '@/lib/growth/view';

import { approveCampaign, rejectCampaign, saveCampaign } from './actions';
import { loadGrowthAccess } from './access';
import { GrowthFrame } from './frame';

export const metadata = { title: 'Growth' };

const description =
  'Salaam. Approve what should go out on WhatsApp. Only customers who opted in at the counter or replied START / شروع are included.';

function defaultSendAt() {
  const today = karachiInputValue(new Date()).slice(0, 10);
  const next = new Date(`${today}T11:00:00+05:00`);
  next.setUTCDate(next.getUTCDate() + 1);
  return karachiInputValue(next);
}

function tabFrom(value: string | undefined): GrowthTab {
  if (value === 'scheduled' || value === 'sent' || value === 'all' || value === 'proposed')
    return value;
  return 'proposed';
}

type InboxData = {
  campaigns: GrowthCampaign[];
  connection: GrowthConnection;
  templates: GrowthTemplate[];
};

export default async function GrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string; tab?: string }>;
}) {
  const query = await searchParams;
  const access = await loadGrowthAccess();
  if (!access.ok) return <GrowthDenied reason={access.reason} />;
  const tab = tabFrom(query.tab);

  let data: InboxData | null = null;
  let denied: 'flag' | 'permission' | null = null;
  let failed = false;
  try {
    const [list, connection, templates] = await Promise.all([
      access.caller.campaigns.list({ tab: 'all' }),
      access.caller.connection.status(),
      access.caller.templates.list(),
    ]);
    data = {
      campaigns: list.campaigns,
      connection,
      templates: templates.templates,
    };
  } catch (error) {
    unstable_rethrow(error);
    failed = true;
    if (
      error instanceof TRPCError &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      denied = error.message.includes('off') ? 'flag' : 'permission';
    }
  }

  if (denied) return <GrowthDenied reason={denied} />;
  if (failed || !data) {
    return (
      <GrowthFrame current="inbox" heading="Campaigns" description={description}>
        <GrowthUnavailable />
      </GrowthFrame>
    );
  }

  return (
    <GrowthFrame
      current="inbox"
      heading="Campaigns"
      description={description}
      notice={query.notice}
      error={query.error}
      actions={
        <Link
          href="/growth/settings"
          className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11')}
        >
          Settings
        </Link>
      }
    >
      <GrowthInbox
        key={tab}
        campaigns={data.campaigns}
        templates={data.templates}
        connection={data.connection}
        defaultSendAt={defaultSendAt()}
        initialTab={tab}
        approveAction={approveCampaign}
        rejectAction={rejectCampaign}
        saveAction={saveCampaign}
      />
    </GrowthFrame>
  );
}
