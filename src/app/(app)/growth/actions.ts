'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';

import { karachiLocalToIso, minorFromRupees } from '@/components/growth/format';
import type { CampaignKind } from '@/lib/growth/view';

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

function campaignInput(form: FormData) {
  const discountType = text(form, 'discountType');
  const rawDiscount = text(form, 'discountValue');
  const rationale = text(form, 'rationale');
  return {
    name: text(form, 'name'),
    kind: text(form, 'kind') as CampaignKind,
    segment: { type: 'all' as const },
    sendAt: karachiLocalToIso(text(form, 'sendAt')) ?? '',
    discountType: discountType as 'percent' | 'fixed' | 'none',
    discountValue:
      discountType === 'none'
        ? null
        : discountType === 'fixed'
          ? minorFromRupees(rawDiscount)
          : (whole(form, 'discountValue') ?? null),
    budgetCapMinor: minorFromRupees(text(form, 'budgetRupees')) ?? Number.NaN,
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
  let approved = false;
  try {
    const api = await caller();
    const saved = id
      ? await api.campaigns.update({ ...input, id })
      : await api.campaigns.create(input);
    approved = saved.status === 'approved';
  } catch (error) {
    unstable_rethrow(error);
    fail('/growth', error);
  }
  if (approved) {
    done(
      '/growth?tab=scheduled',
      'Under the auto-approve amount, so it is approved. The next send tick will schedule it.'
    );
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
