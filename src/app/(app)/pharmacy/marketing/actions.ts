'use server';

import { revalidatePath } from 'next/cache';
import { TRPCError } from '@trpc/server';
import { pharmacyMarketingRouter } from '@/server/routers/pharmacy-marketing';
import { createTRPCContext } from '@/server/trpc';
import { previewWhatsAppCost } from '@/lib/pharmacy/whatsapp/rate-card';
import { localDateTime, localDayAfter, localDayStart } from '@/lib/pharmacy/marketing-dates';
import { workspaceTimezone } from '@/lib/timezone';

function exclusionsText(exclusions: Record<string, number>) {
  return (
    Object.entries(exclusions)
      .map(([reason, count]) => `${reason.toLowerCase().replaceAll('_', ' ')}: ${count}`)
      .join(', ') || 'none'
  );
}

export async function marketingAction(
  form: FormData
): Promise<{ error: boolean; message: string; campaignId?: string }> {
  const text = (key: string) => String(form.get(key) ?? '');
  // Owners enter calendar days and local times in the workspace zone; the server still
  // validates the resulting instants (completed period, bounded length, future schedule).
  const zone = workspaceTimezone(text('timeZone'));
  const period = () => ({
    from: localDayStart(text('from'), zone),
    cutoff: form.has('lastDay')
      ? localDayAfter(text('lastDay'), zone)
      : localDayStart(text('cutoff'), zone),
  });
  const scheduledAt = () => localDateTime(text('scheduledAt'), zone);
  try {
    // Every invocation resolves the current session, tenant, license and branch.
    const caller = pharmacyMarketingRouter.createCaller(await createTRPCContext());
    const branchId = text('branchId');
    const target = { branchId, campaignId: text('campaignId') };
    let message: string;
    let savedCampaignId: string | undefined;
    switch (text('operation')) {
      case 'basket-generate': {
        const result = await caller.generateBaskets({
          branchId,
          ...period(),
          config: {
            minimumPairCount: Number(text('minimumPairCount')),
            minimumSupport: Number(text('minimumSupport')),
            minimumConfidence: Number(text('minimumConfidence')),
            minimumLift: Number(text('minimumLift')),
            maximumProposals: Number(text('maximumProposals')),
          },
        });
        message = `${result.count} bundle proposals saved for owner review.`;
        break;
      }
      case 'basket-review': {
        if (form.get('reviewed') !== 'on')
          return { error: true, message: 'Confirm your bundle review first.' };
        const decision = text('decision');
        if (decision !== 'APPROVE' && decision !== 'REJECT')
          return { error: true, message: 'Choose a bundle decision.' };
        const result = await caller.reviewBasket({
          branchId,
          insightId: text('insightId'),
          recommendation: Number(text('recommendation')),
          decision,
          ...(decision === 'APPROVE'
            ? { pinCredential: text('pin'), scheduledAt: scheduledAt() }
            : {}),
        });
        if ('blocked' in result && typeof result.blocked === 'string')
          return { error: true, message: result.blocked };
        savedCampaignId = result.campaignId ?? undefined;
        message = result.campaignId
          ? 'Bundle approved with PIN audit. Generic campaign draft saved for campaign review.'
          : 'Bundle rejected. No campaign created.';
        break;
      }
      case 'growth-generate': {
        if (!text('from') || !text('lastDay'))
          return {
            error: true,
            message: 'Choose both a first day and a last day before generating insights.',
          };
        const result = await caller.generateGrowth({
          branchId,
          ...period(),
        });
        message =
          result.status === 'READY'
            ? 'Insights saved. Review evidence before creating a draft.'
            : result.status === 'INSUFFICIENT_DATA'
              ? 'Not enough sales evidence in this period after privacy rules. Try a longer period. Manual campaigns remain available.'
              : result.failureCode === 'CONFIGURATION'
                ? "AI suggestions aren't set up yet. Contact DevFathom support to connect the AI service. Manual campaigns remain available."
                : result.status === 'UNAVAILABLE'
                  ? 'AI suggestions are not available right now. Try again later. Manual campaigns remain available.'
                  : 'No suggestion could be generated from this evidence. Manual campaigns remain available.';
        break;
      }
      case 'growth-review': {
        if (form.get('reviewed') !== 'on')
          return { error: true, message: 'Confirm your review first.' };
        const decision = text('decision');
        if (decision !== 'EDIT' && decision !== 'APPROVE' && decision !== 'REJECT')
          return { error: true, message: 'Choose a review decision.' };
        const result = await caller.reviewGrowth({
          branchId,
          insightId: text('insightId'),
          recommendation: Number(text('recommendation')),
          decision,
          ...(decision === 'REJECT'
            ? {}
            : {
                edit: {
                  name: text('name'),
                  templateId: text('templateId'),
                  scheduledAt: scheduledAt(),
                },
              }),
        });
        savedCampaignId = result.campaignId ?? undefined;
        message = result.campaignId
          ? 'Campaign draft saved with insight lineage. Open history to review and approve the campaign.'
          : result.decision === 'REJECT'
            ? 'Insight rejected. No campaign created.'
            : 'Edits saved for review. No campaign created.';
        break;
      }
      case 'template':
        if (form.get('reviewed') !== 'on')
          return { error: true, message: 'Review the full template and confirm approval.' };
        await caller.approveTemplate({
          branchId,
          name: text('name'),
          body: text('body'),
          reviewed: true,
        });
        message = 'Template approved and saved.';
        break;
      case 'draft': {
        const field = text('field');
        if (field !== 'receiptCount' && field !== 'daysSinceLastReceipt' && field !== 'churnScore')
          return { error: true, message: 'Choose a supported retail field.' };
        const draft = await caller.createDraft({
          branchId,
          name: text('name'),
          templateId: text('templateId'),
          scheduledAt: scheduledAt(),
          definition: {
            version: 1,
            all: [{ field, operator: 'gte', value: Number(text('threshold')) }],
          },
          quietHours: { startHour: Number(text('quietStart')), endHour: Number(text('quietEnd')) },
          frequencyCap: { max: Number(text('cap')), windowDays: Number(text('window')) },
          promotesRegulatedItem: false,
        });
        savedCampaignId = draft.id;
        message = 'Draft saved. Review and approve the campaign before capture.';
        break;
      }
      case 'approve':
        if (form.get('reviewed') !== 'on')
          return { error: true, message: 'Confirm you reviewed the campaign.' };
        await caller.approve(target);
        message = 'Campaign approved. Preview the audience before capture.';
        break;
      case 'preview': {
        const result = await caller.preview(target);
        const cost = previewWhatsAppCost(result.prepared, 'MARKETING');
        const costText = cost
          ? `Estimated WhatsApp cost: ${cost.recipients} recipients × ${cost.currency} ${cost.rate} (${cost.category.toLowerCase()}) = ${cost.currency} ${cost.total}.`
          : 'Estimated WhatsApp cost unavailable: configure the current marketing rate card before sending.';
        message = `Eligible now: ${result.prepared}. Exclusions: ${exclusionsText(result.exclusions)}. ${costText} Nothing saved or sent.`;
        break;
      }
      case 'capture': {
        const result = await caller.capture(target);
        message = `${result.replay ? 'Existing' : 'Saved'} prepared captures: ${result.prepared}. Exclusions: ${exclusionsText(result.exclusions)}. No messages sent.`;
        break;
      }
      case 'sandbox-due': {
        const result = await caller.sandboxDue({
          branchId,
          requestKey: text('requestKey'),
          campaignIds: form.getAll('campaignIds').map(String),
          outcome: 'DELIVERED',
        });
        message = `Sandbox only: processed ${result.results.length} due captured campaigns. ${result.hasMore ? 'More campaigns remain.' : 'End of bounded batch.'} No live messages sent; review each campaign history for outcomes.`;
        break;
      }
      case 'sandbox': {
        const outcome = text('outcome');
        if (!['DELIVERED', 'REJECTED', 'TIMEOUT', 'FAULT'].includes(outcome))
          return { error: true, message: 'Choose a sandbox outcome.' };
        const result = await caller.sandbox({
          ...target,
          requestKey: text('requestKey'),
          retry: form.get('retry') === 'on',
          outcome: outcome as 'DELIVERED' | 'REJECTED' | 'TIMEOUT' | 'FAULT',
        });
        message = `Sandbox only: ${result.attempted} attempts, ${result.accepted} accepted, ${result.delivered} delivered, ${result.failed} failed, ${result.unknown} unknown, ${result.suppressed} suppressed. No live messages sent.`;
        break;
      }
      case 'attribution': {
        const result = await caller.attributeReceipts({
          branchId,
          ...period(),
        });
        message = `Estimated receipt links: ${result.created} saved, ${result.eligible} eligible. Sandbox delivery never qualifies. Message cost is unavailable.`;
        break;
      }
      case 'assist': {
        const occasion = text('occasion');
        if (occasion !== 'WELCOME' && occasion !== 'STORE_UPDATE' && occasion !== 'RETAIL_OFFER')
          return { error: true, message: 'Choose an available occasion.' };
        const result = await caller.assist({ branchId, occasion, tone: 'FRIENDLY' });
        return {
          error: !result.available,
          message: result.available
            ? `Unapproved draft — review before saving: ${result.body}`
            : 'AI assistance unavailable. Write and review your template manually.',
        };
      }
      default:
        return { error: true, message: 'Unknown campaign action.' };
    }
    revalidatePath('/pharmacy/marketing');
    return { error: false, message, campaignId: savedCampaignId };
  } catch (error) {
    return {
      error: true,
      message:
        error instanceof TRPCError &&
        ['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
          ? error.message
          : 'Campaign action failed. Your form remains available. Reload history before retrying a capture.',
    };
  }
}
