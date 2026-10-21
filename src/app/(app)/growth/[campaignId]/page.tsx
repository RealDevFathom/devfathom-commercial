import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';

import { CampaignDetail } from '@/components/growth/campaign-detail';
import { GrowthDenied, GrowthUnavailable } from '@/components/growth/growth-denied';
import { SectionCard } from '@/components/ui/section-card';
import type { GrowthCampaign, GrowthMessage, GrowthRecipient } from '@/lib/growth/view';

import { cancelCampaign } from '../actions';
import { loadGrowthAccess } from '../access';
import { GrowthFrame } from '../frame';

export const metadata = { title: 'Campaign · Growth' };

type DetailData = {
  campaign: GrowthCampaign;
  recipients: GrowthRecipient[];
  messages: GrowthMessage[];
  preview: string | null;
};

export default async function GrowthCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { campaignId } = await params;
  const query = await searchParams;
  const access = await loadGrowthAccess();
  if (!access.ok) return <GrowthDenied reason={access.reason} />;

  let data: DetailData | null = null;
  let missing = false;
  let denied: 'flag' | 'permission' | null = null;
  let failed = false;
  try {
    const detail = await access.caller.campaigns.get({ id: campaignId });
    data = {
      campaign: detail.campaign,
      recipients: detail.recipients,
      messages: detail.messages,
      preview: detail.preview,
    };
  } catch (error) {
    unstable_rethrow(error);
    failed = true;
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      missing = true;
    } else if (
      error instanceof TRPCError &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      denied = error.message.includes('off') ? 'flag' : 'permission';
    }
  }

  if (denied) return <GrowthDenied reason={denied} />;
  if (missing) {
    return (
      <GrowthFrame
        current="detail"
        heading="Campaign"
        description="This campaign is not on the shop."
      >
        <SectionCard title="Campaign not found" titleLevel={2}>
          <p className="text-sm text-text-body">
            It may belong to another shop, or the link is out of date.
          </p>
        </SectionCard>
      </GrowthFrame>
    );
  }
  if (failed || !data) {
    return (
      <GrowthFrame
        current="detail"
        heading="Campaign"
        description="The campaign could not be opened."
      >
        <GrowthUnavailable />
      </GrowthFrame>
    );
  }

  return (
    <GrowthFrame
      current="detail"
      heading={data.campaign.name}
      description="Reach, spend against the cap, and who redeemed the code."
      notice={query.notice}
      error={query.error}
    >
      <CampaignDetail
        campaign={data.campaign}
        recipients={data.recipients}
        messages={data.messages}
        preview={data.preview}
        cancelAction={cancelCampaign}
      />
    </GrowthFrame>
  );
}
