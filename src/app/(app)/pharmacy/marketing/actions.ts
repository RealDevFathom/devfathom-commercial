'use server';

import { revalidatePath } from 'next/cache';
import { TRPCError } from '@trpc/server';
import { pharmacyMarketingRouter } from '@/server/routers/pharmacy-marketing';
import { createTRPCContext } from '@/server/trpc';

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
  try {
    // Every invocation resolves the current session, tenant, license and branch.
    const caller = pharmacyMarketingRouter.createCaller(await createTRPCContext());
    const branchId = text('branchId');
    const target = { branchId, campaignId: text('campaignId') };
    let message: string;
    let savedCampaignId: string | undefined;
    switch (text('operation')) {
      case 'growth-generate': {
        const result = await caller.generateGrowth({
          branchId,
          from: new Date(text('from')),
          cutoff: new Date(text('cutoff')),
        });
        message =
          result.status === 'READY'
            ? 'Insights saved. Review evidence before creating a draft.'
            : `Insight status: ${result.status}. ${result.failureCode ?? ''}. Manual campaigns remain available.`;
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
                  scheduledAt: new Date(text('scheduledAt')),
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
        if (field !== 'receiptCount' && field !== 'daysSinceLastReceipt')
          return { error: true, message: 'Choose a supported retail field.' };
        const draft = await caller.createDraft({
          branchId,
          name: text('name'),
          templateId: text('templateId'),
          scheduledAt: new Date(text('scheduledAt')),
          definition: {
            version: 1,
            all: [{ field, operator: 'gte', value: Number(text('threshold')) }],
          },
          quietHours: { startHour: Number(text('quietStart')), endHour: Number(text('quietEnd')) },
          frequencyCap: {
            max: Number(text('cap')),
            windowDays: Number(text('window')),
            monthlyMax: form.has('monthlyCap') ? Number(text('monthlyCap')) : 2,
          },
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
          from: new Date(text('from')),
          cutoff: new Date(text('cutoff')),
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
