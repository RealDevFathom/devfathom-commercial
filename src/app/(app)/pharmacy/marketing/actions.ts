'use server';

import { revalidatePath } from 'next/cache';
import { TRPCError } from '@trpc/server';
import { pharmacyMarketingRouter } from '@/server/routers/pharmacy-marketing';
import { createTRPCContext } from '@/server/trpc';
import { workspaceTimezone } from '@/lib/timezone';
import { dayRangeToPeriod, localDateTimeToInstant } from './period';

// Plain outcomes for a saved insight that is not READY (DEV-591), instead of status codes.
const GROWTH_OUTCOME: Record<string, string> = {
  CONFIGURATION:
    'AI is not connected for this workspace yet. Contact DevFathom support to connect an AI provider.',
  SPARSE:
    'Not enough customer activity in these days to suggest anything; groups too small to stay anonymous are hidden. Try a longer period.',
  TIMEOUT: 'The AI service took too long to answer. Try again in a few minutes.',
  PROVIDER: 'The AI service could not be reached. Try again in a few minutes.',
  OUTPUT:
    'The AI answer did not match your saved figures, so it was not kept as advice. Try again later.',
};

const SEND_TIME_MESSAGE = 'Choose a send date and time.';

/** Advanced basket thresholds, checked here so a bad value gets a sentence, not a schema dump. */
function basketThresholds(text: (key: string) => string) {
  const read = (key: string) => (text(key).trim() === '' ? Number.NaN : Number(text(key)));
  const config = {
    minimumPairCount: read('minimumPairCount'),
    minimumSupport: read('minimumSupport'),
    minimumConfidence: read('minimumConfidence'),
    minimumLift: read('minimumLift'),
    maximumProposals: read('maximumProposals'),
  };
  const share = (value: number) => value >= 0 && value <= 1;
  return Number.isInteger(config.minimumPairCount) &&
    config.minimumPairCount >= 1 &&
    share(config.minimumSupport) &&
    share(config.minimumConfidence) &&
    config.minimumLift >= 0 &&
    Number.isInteger(config.maximumProposals) &&
    config.maximumProposals >= 1 &&
    config.maximumProposals <= 3
    ? config
    : null;
}

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
  // Days and send times arrive as wall time in the workspace zone the page names.
  const timeZone = workspaceTimezone(text('timezone'));
  const period = () => dayRangeToPeriod(text('firstDay'), text('lastDay'), timeZone);
  const sendTime = () => localDateTimeToInstant(text('scheduledAt'), timeZone);
  try {
    // Every invocation resolves the current session, tenant, license and branch.
    const caller = pharmacyMarketingRouter.createCaller(await createTRPCContext());
    const branchId = text('branchId');
    const target = { branchId, campaignId: text('campaignId') };
    let message: string;
    let savedCampaignId: string | undefined;
    switch (text('operation')) {
      case 'basket-generate': {
        const days = period();
        if (!days.ok) return { error: true, message: days.message };
        const config = basketThresholds(text);
        if (!config)
          return {
            error: true,
            message:
              'Check the Advanced settings: receipts with both products is a whole number of at least 1, support and confidence are between 0 and 1, lift is 0 or more, and at most 3 bundles.',
          };
        const result = await caller.generateBaskets({
          branchId,
          from: days.from,
          cutoff: days.cutoff,
          config,
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
        const scheduledAt = decision === 'APPROVE' ? sendTime() : null;
        if (decision === 'APPROVE' && !scheduledAt)
          return { error: true, message: SEND_TIME_MESSAGE };
        const result = await caller.reviewBasket({
          branchId,
          insightId: text('insightId'),
          recommendation: Number(text('recommendation')),
          decision,
          ...(scheduledAt ? { pinCredential: text('pin'), scheduledAt } : {}),
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
        const days = period();
        if (!days.ok) return { error: true, message: days.message };
        const result = await caller.generateGrowth({
          branchId,
          from: days.from,
          cutoff: days.cutoff,
        });
        message =
          result.status === 'READY'
            ? 'Insights saved. Review evidence before creating a draft.'
            : `${GROWTH_OUTCOME[result.failureCode ?? ''] ?? 'No insight was generated for these days.'} Manual campaigns remain available.`;
        break;
      }
      case 'growth-review': {
        if (form.get('reviewed') !== 'on')
          return { error: true, message: 'Confirm your review first.' };
        const decision = text('decision');
        if (decision !== 'EDIT' && decision !== 'APPROVE' && decision !== 'REJECT')
          return { error: true, message: 'Choose a review decision.' };
        const scheduledAt = decision === 'REJECT' ? null : sendTime();
        if (decision !== 'REJECT' && !scheduledAt)
          return { error: true, message: SEND_TIME_MESSAGE };
        const result = await caller.reviewGrowth({
          branchId,
          insightId: text('insightId'),
          recommendation: Number(text('recommendation')),
          decision,
          ...(scheduledAt
            ? { edit: { name: text('name'), templateId: text('templateId'), scheduledAt } }
            : {}),
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
        if (field !== 'receiptCount' && field !== 'daysSinceLastReceipt')
          return { error: true, message: 'Choose a supported retail field.' };
        const scheduledAt = sendTime();
        if (!scheduledAt) return { error: true, message: SEND_TIME_MESSAGE };
        const draft = await caller.createDraft({
          branchId,
          name: text('name'),
          templateId: text('templateId'),
          scheduledAt,
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
        message = `Eligible now: ${result.prepared}. Exclusions: ${exclusionsText(result.exclusions)}. Nothing saved or sent.`;
        break;
      }
      case 'capture': {
        const result = await caller.capture(target);
        message = `${result.replay ? 'Existing' : 'Saved'} prepared captures: ${result.prepared}. Exclusions: ${exclusionsText(result.exclusions)}. No messages sent.`;
        break;
      }
      case 'sandbox-due': {
        const campaignIds = form.getAll('campaignIds').map(String);
        if (!campaignIds.length || campaignIds.length > 5)
          return { error: true, message: 'Select one to five prepared campaigns.' };
        if (!text('requestKey').trim())
          return {
            error: true,
            message: 'The batch reference is empty. Reload the page to get a new one.',
          };
        const result = await caller.sandboxDue({
          branchId,
          requestKey: text('requestKey').trim(),
          campaignIds,
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
        const days = period();
        if (!days.ok) return { error: true, message: days.message };
        const result = await caller.attributeReceipts({
          branchId,
          from: days.from,
          cutoff: days.cutoff,
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
            : 'AI drafts are not available right now. Check that Ask Fathom is on in Organization settings, or write the template yourself above.',
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
