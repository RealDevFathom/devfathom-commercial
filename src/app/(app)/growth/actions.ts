'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';

import { karachiLocalToIso, minorFromRupees } from '@/components/growth/format';
import type { GrowthSegment } from '@/lib/growth/view';

import { loadGrowthAccess } from './access';

function text(form: FormData, name: string) {
  return String(form.get(name) ?? '').trim();
}

function whole(form: FormData, name: string): number | undefined {
  const value = text(form, name);
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

function fail(path: string, error: unknown): never {
  const message = error instanceof TRPCError ? error.message : 'Growth could not save that change.';
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

async function caller() {
  const access = await loadGrowthAccess();
  if (!access.ok) {
    redirect(
      `/growth?error=${encodeURIComponent(
        access.reason === 'flag'
          ? 'Growth AI is off for this shop.'
          : 'You do not have permission for this action.'
      )}`
    );
  }
  return access.caller;
}

function done(path: string, notice: string): never {
  revalidatePath('/growth', 'layout');
  redirect(`${path}${path.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`);
}

function segmentFrom(form: FormData): GrowthSegment {
  const type = text(form, 'segmentType');
  if (type === 'churn_band') {
    const band = text(form, 'band');
    if (band !== 'low' && band !== 'medium' && band !== 'high' && band !== 'lost') {
      return { type: 'churn_band', band: 'high' };
    }
    return { type: 'churn_band', band };
  }
  if (type === 'birthday') return { type: 'birthday', month: whole(form, 'month') ?? Number.NaN };
  if (type === 'refill_due') {
    return { type: 'refill_due', withinDays: whole(form, 'withinDays') ?? Number.NaN };
  }
  if (type === 'random') return { type: 'random', pct: whole(form, 'pct') ?? Number.NaN };
  if (type === 'top_spenders')
    return { type: 'top_spenders', n: whole(form, 'topN') ?? Number.NaN };
  if (type === 'inactive_days') {
    return {
      type: 'inactive_days',
      min: whole(form, 'inactiveMin') ?? Number.NaN,
      max: whole(form, 'inactiveMax') ?? Number.NaN,
    };
  }
  return { type: 'all' };
}

function discountKind(value: string): 'percent' | 'fixed' | 'none' {
  if (value === 'fixed' || value === 'none') return value;
  return 'percent';
}

function campaignInput(form: FormData) {
  const type = discountKind(text(form, 'discountType'));
  const rawDiscount = text(form, 'discountValue');
  const discountValue =
    type === 'none'
      ? null
      : type === 'percent'
        ? (whole(form, 'discountValue') ?? null)
        : minorFromRupees(rawDiscount);
  const budgetCapMinor = minorFromRupees(text(form, 'budgetRupees'));
  const sendAt = karachiLocalToIso(text(form, 'sendAt'));
  if (budgetCapMinor == null) {
    redirect(
      '/growth?error=' + encodeURIComponent('Enter the budget in rupees, like 2000 or 2000.50.')
    );
  }
  if (!sendAt) {
    redirect('/growth?error=' + encodeURIComponent('Choose the date and time to send.'));
  }
  if (type !== 'none' && discountValue == null) {
    redirect('/growth?error=' + encodeURIComponent('Enter the discount.'));
  }
  const rationale = text(form, 'rationale');
  return {
    name: text(form, 'name'),
    kind: text(form, 'kind') as 'manual',
    segment: segmentFrom(form),
    sendAt,
    discountType: type,
    discountValue,
    budgetCapMinor,
    templateId: text(form, 'templateId'),
    rationale: rationale || null,
  };
}

export async function approveCampaign(formData: FormData) {
  try {
    await (await caller()).campaigns.approve({ id: text(formData, 'campaignId') });
  } catch (error) {
    unstable_rethrow(error);
    fail('/growth', error);
  }
  done('/growth?tab=scheduled', 'Approved. The next send tick will schedule it.');
}

export async function rejectCampaign(formData: FormData) {
  try {
    await (await caller()).campaigns.cancel({ id: text(formData, 'campaignId') });
  } catch (error) {
    unstable_rethrow(error);
    fail('/growth', error);
  }
  done('/growth?tab=all', 'Rejected. It will not send.');
}

export async function cancelCampaign(formData: FormData) {
  const id = text(formData, 'campaignId');
  try {
    await (await caller()).campaigns.cancel({ id });
  } catch (error) {
    unstable_rethrow(error);
    fail(`/growth/${id}`, error);
  }
  done(`/growth/${id}`, 'Cancelled. It will not send.');
}

export async function saveCampaign(formData: FormData) {
  const id = text(formData, 'campaignId');
  const input = campaignInput(formData);
  try {
    const api = await caller();
    if (id) await api.campaigns.update({ ...input, id });
    else await api.campaigns.create(input);
  } catch (error) {
    unstable_rethrow(error);
    fail('/growth', error);
  }
  done('/growth?tab=proposed', 'Saved. It stays a proposal until you approve it.');
}

export async function saveSettings(formData: FormData) {
  const monthlyBudgetMinor = minorFromRupees(text(formData, 'monthlyBudget'));
  const autoApproveUnderMinor = minorFromRupees(text(formData, 'autoApproveUnder'));
  if (monthlyBudgetMinor == null || autoApproveUnderMinor == null) {
    redirect(
      '/growth/settings?error=' +
        encodeURIComponent('Enter the amounts in rupees, like 15000 or 500.50.')
    );
  }
  const customDates = text(formData, 'customDates')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const url = text(formData, 'waApiUrl');
  const key = text(formData, 'waApiKey');
  try {
    await (
      await caller()
    ).settings.update({
      monthlyBudgetMinor,
      autoApproveUnderMinor,
      quietHoursStart: whole(formData, 'quietHoursStart') ?? Number.NaN,
      quietHoursEnd: whole(formData, 'quietHoursEnd') ?? Number.NaN,
      maxMsgsPerDay: whole(formData, 'maxMsgsPerDay') ?? Number.NaN,
      maxDiscountPct: whole(formData, 'maxDiscountPct') ?? Number.NaN,
      customDates,
      waInstanceName: text(formData, 'waInstanceName') || null,
      waApiUrl: url || null,
      waApiKey: key || undefined,
    });
  } catch (error) {
    unstable_rethrow(error);
    fail('/growth/settings', error);
  }
  done('/growth/settings', 'Settings saved.');
}

export async function sendTestMessage(formData: FormData) {
  try {
    await (await caller()).messages.sendTest({ toE164: text(formData, 'toE164') });
  } catch (error) {
    unstable_rethrow(error);
    fail('/growth/settings', error);
  }
  done(
    '/growth/settings',
    'Test queued. It sends when WhatsApp is paired and quiet hours allow it.'
  );
}

export async function updateTemplate(
  formData: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const access = await loadGrowthAccess();
    if (!access.ok) {
      return {
        ok: false,
        error:
          access.reason === 'flag'
            ? 'Growth AI is off for this shop.'
            : 'You do not have permission for this action.',
      };
    }
    await access.caller.templates.update({
      id: text(formData, 'templateId'),
      body: String(formData.get('body') ?? ''),
    });
    revalidatePath('/growth/settings');
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return {
      ok: false,
      error: error instanceof TRPCError ? error.message : 'The template could not be saved.',
    };
  }
}
