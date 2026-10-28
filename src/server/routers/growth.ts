import { growthWhatsAppRouter } from './growth-whatsapp';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { isGrowthEnabled } from '@/lib/growth';
import { renderTemplate, SAMPLE_TEMPLATE_VARS, templateIssues } from '@/lib/growth/template-text';
import { encryptSecret } from '@/lib/secret-crypto';
import {
  CAMPAIGN_KINDS,
  TEMPLATE_KEYS,
  campaignInTab,
  type CampaignStatus,
  type GrowthCampaign,
  type GrowthConnection,
  type GrowthRecipient,
  type GrowthSettingsView,
  type GrowthTab,
  type GrowthTemplate,
  type TemplateKey,
} from '@/lib/growth/view';
import { capabilityProcedure, router, type TRPCContext } from '@/server/trpc';

const growthProcedure = capabilityProcedure('growth.manage').use(async ({ ctx, next }) => {
  const organizationId = ctx.session?.user?.organizationId;
  if (!organizationId || !(await isGrowthEnabled(organizationId))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Growth AI is off for this shop.' });
  }
  return next();
});

const segmentSchema = z.object({ type: z.literal('all') });

const campaignWrite = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(CAMPAIGN_KINDS),
  segment: segmentSchema,
  sendAt: z.iso.datetime(),
  discountType: z.enum(['percent', 'fixed', 'none']),
  discountValue: z.number().int().nullable(),
  budgetCapMinor: z.number().int().min(0).max(100_000_000),
  templateId: z.string().min(1),
  rationale: z.string().trim().max(600).nullable(),
});

type FixtureSettings = Omit<GrowthSettingsView, 'customDates'> & {
  customDates: string[];
  waApiKeyEnc: string | null;
};

type FixtureCampaign = Omit<GrowthCampaign, 'redemptionCount'>;

type GrowthFixture = {
  organizationId: string;
  settings: FixtureSettings;
  campaigns: FixtureCampaign[];
  templates: GrowthTemplate[];
};

const stores = new Map<string, GrowthFixture>();

function bad(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

function plusDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function keyHint(key: string | null): string | null {
  if (!key) return null;
  return `••••${key.slice(-4)}`;
}

function templateBody(key: TemplateKey): string {
  const bodies: Record<TemplateKey, string> = {
    birthday_offer:
      'Salaam {{name}}! {{discount}} off at {{business}} till {{expires}}. Code {{code}}. Reply STOP to opt out.',
    refill_reminder:
      'Salaam {{name}}, your {{product}} at {{business}} is due soon. We can keep it aside. Reply STOP to opt out.',
    winback:
      'Salaam {{name}}, we have not seen you at {{business}}. {{discount}} is waiting. Code {{code}} till {{expires}}. Reply STOP to opt out.',
    slow_day:
      'Salaam {{name}}! Quiet day at {{business}}, {{discount}} if you visit today. Code {{code}}. Reply STOP to opt out.',
    holiday:
      'Eid Mubarak {{name}}! {{discount}} at {{business}} till {{expires}}. Code {{code}}. Reply STOP to opt out.',
    review_request:
      'Salaam {{name}}, shukriya for visiting {{business}}. A short review helps: {{reviewUrl}}. Reply STOP to opt out.',
    referral:
      'Salaam {{name}}! Share {{referralCode}} and you both save at {{business}}. Reply STOP to opt out.',
    generic:
      'Salaam {{name}}! {{discount}} at {{business}}. Code {{code}} till {{expires}}. Reply STOP to opt out.',
  };
  return bodies[key];
}

function seedGrowth(organizationId: string): GrowthFixture {
  return {
    organizationId,
    settings: {
      monthlyBudgetMinor: 0,
      autoApproveUnderMinor: 0,
      quietHoursStart: 21,
      quietHoursEnd: 9,
      maxMsgsPerDay: 30,
      maxDiscountPct: 25,
      customDates: [],
      waInstanceName: null,
      waApiUrl: null,
      waApiKeyHint: null,
      waApiKeyEnc: null,
    },
    campaigns: [
      {
        id: 'cmp_proposal',
        organizationId,
        kind: 'manual',
        status: 'proposed',
        name: 'Welcome back',
        rationale: 'A proposal waiting for a person to approve.',
        segment: { type: 'all' },
        sendAt: '2026-10-24T06:00:00.000Z',
        discountType: 'none',
        discountValue: null,
        codeExpiresAt: '2026-11-07T06:00:00.000Z',
        budgetCapMinor: 0,
        spentMinor: 0,
        templateId: 'tpl_generic',
        estimatedReach: 0,
        createdBy: 'ai',
        approvedBy: null,
        approvedAt: null,
      },
    ],
    templates: TEMPLATE_KEYS.map((key) => ({
      id: `tpl_${key}`,
      key,
      language: 'ur-en',
      body: templateBody(key),
    })),
  };
}

/**
 * Fixture source for the growth admin.
 * Replace this function with Prisma when the WP-G1 tables and WP-G5 engine land.
 * The procedures below keep the same inputs and outputs.
 */
export function growthStore(organizationId: string): GrowthFixture {
  const existing = stores.get(organizationId);
  if (existing) return existing;
  const seeded = seedGrowth(organizationId);
  stores.set(organizationId, seeded);
  return seeded;
}

function organizationIdOf(ctx: {
  organization: { id: string } | null;
  session: { user?: { organizationId?: string | null } | null } | null;
}): string {
  const organizationId = ctx.session?.user?.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  return organizationId;
}

function userIdOf(ctx: { session: { user?: { id?: string | null } | null } | null }): string {
  const userId = ctx.session?.user?.id;
  if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'You must be logged in.' });
  return userId;
}

function toCampaign(campaign: FixtureCampaign): GrowthCampaign {
  return { ...campaign, redemptionCount: 0 };
}

function toSettings(settings: FixtureSettings): GrowthSettingsView {
  return {
    monthlyBudgetMinor: settings.monthlyBudgetMinor,
    autoApproveUnderMinor: settings.autoApproveUnderMinor,
    quietHoursStart: settings.quietHoursStart,
    quietHoursEnd: settings.quietHoursEnd,
    maxMsgsPerDay: settings.maxMsgsPerDay,
    maxDiscountPct: settings.maxDiscountPct,
    customDates: [...settings.customDates],
    waInstanceName: settings.waInstanceName,
    waApiUrl: settings.waApiUrl,
    waApiKeyHint: settings.waApiKeyHint,
  };
}

function connectionOf(settings: FixtureSettings): GrowthConnection {
  const paired = Boolean(settings.waInstanceName && settings.waApiUrl && settings.waApiKeyEnc);
  return {
    status: paired ? 'connected' : 'needs_pairing',
    managerUrl: settings.waApiUrl,
  };
}

function assertDiscount(store: GrowthFixture, input: z.infer<typeof campaignWrite>) {
  if (input.discountType === 'none') return;
  if (input.discountValue == null) bad('Enter the discount.');
  if (input.discountType === 'percent') {
    if (input.discountValue < 1 || input.discountValue > 100) bad('Percent discount is 1 to 100.');
    if (input.discountValue > store.settings.maxDiscountPct) {
      bad(`Max discount for this shop is ${store.settings.maxDiscountPct}%.`);
    }
  }
  if (input.discountType === 'fixed') {
    if (input.discountValue < 100) bad('A fixed discount needs at least one rupee.');
    if (input.discountValue > input.budgetCapMinor) {
      bad('A fixed discount cannot be larger than the campaign budget.');
    }
  }
}

/** 0 means a person approves every campaign. A positive threshold approves a smaller cap. */
function applyAutoApprove(campaign: FixtureCampaign, userId: string, threshold: number) {
  if (threshold > 0 && campaign.budgetCapMinor < threshold) {
    campaign.status = 'approved';
    campaign.approvedBy = userId;
    campaign.approvedAt = new Date().toISOString();
    return;
  }
  campaign.status = 'proposed';
  campaign.approvedBy = null;
  campaign.approvedAt = null;
}

function requireTemplate(store: GrowthFixture, templateId: string): GrowthTemplate {
  const template = store.templates.find((item) => item.id === templateId);
  if (!template) bad('Pick a template that exists for this shop.');
  return template;
}

function requireCampaign(store: GrowthFixture, id: string): FixtureCampaign {
  const campaign = store.campaigns.find((item) => item.id === id);
  if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' });
  return campaign;
}

function previewFor(
  campaign: FixtureCampaign,
  template: GrowthTemplate | undefined
): string | null {
  if (!template || templateIssues(template.body)) return null;
  const discount =
    campaign.discountType === 'percent' && campaign.discountValue != null
      ? `${campaign.discountValue}%`
      : campaign.discountType === 'fixed' && campaign.discountValue != null
        ? `PKR ${Math.floor(campaign.discountValue / 100)}`
        : 'a visit';
  return renderTemplate(template.body, {
    ...SAMPLE_TEMPLATE_VARS,
    discount,
    code: SAMPLE_TEMPLATE_VARS.code ?? 'SEHA-DEMO1',
    expires: campaign.codeExpiresAt?.slice(0, 10) ?? 'this week',
  });
}

const tabSchema = z.enum(['proposed', 'scheduled', 'sent', 'all']);

const settingsWrite = z.object({
  monthlyBudgetMinor: z.number().int().min(0).max(100_000_000),
  autoApproveUnderMinor: z.number().int().min(0).max(100_000_000),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  maxMsgsPerDay: z.number().int().min(1).max(200),
  maxDiscountPct: z.number().int().min(0).max(25),
  customDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(30),
  waInstanceName: z.string().trim().max(80).nullable(),
  waApiUrl: z.string().trim().max(200).nullable(),
  waApiKey: z.string().max(200).optional(),
});

/** Loopback plus GROWTH_WA_URL_HOSTS. Evolution stays on a host this shop named. */
function waUrlAllowlist(): Set<string> {
  const extra = (process.env.GROWTH_WA_URL_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set(['localhost', '127.0.0.1', '::1', ...extra]);
}

function assertUrl(value: string | null) {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    bad('Enter a URL starting with http:// or https://.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    bad('Enter a URL starting with http:// or https://.');
  }
  if (url.username || url.password) bad('The Evolution URL cannot include a password.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!waUrlAllowlist().has(host)) bad('That Evolution host is not allowlisted.');
}

function assertDates(dates: string[]) {
  for (const value of dates) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== (month ?? 1) - 1 ||
      date.getUTCDate() !== day
    ) {
      bad(`${value} is not a real date. Use YYYY-MM-DD.`);
    }
  }
}

function writeCampaign(
  store: GrowthFixture,
  input: z.infer<typeof campaignWrite>,
  userId: string,
  estimatedReach: number,
  existing?: FixtureCampaign
): FixtureCampaign {
  assertDiscount(store, input);
  requireTemplate(store, input.templateId);
  const campaign: FixtureCampaign = existing ?? {
    id: `cmp_${crypto.randomUUID()}`,
    organizationId: store.organizationId,
    kind: input.kind,
    status: 'proposed',
    name: input.name,
    rationale: input.rationale,
    segment: input.segment,
    sendAt: input.sendAt,
    discountType: input.discountType,
    discountValue: input.discountType === 'none' ? null : input.discountValue,
    codeExpiresAt: plusDays(input.sendAt, 14),
    budgetCapMinor: input.budgetCapMinor,
    spentMinor: 0,
    templateId: input.templateId,
    estimatedReach,
    createdBy: userId,
    approvedBy: null,
    approvedAt: null,
  };
  if (existing) {
    Object.assign(campaign, {
      name: input.name,
      kind: input.kind,
      segment: input.segment,
      sendAt: input.sendAt,
      discountType: input.discountType,
      discountValue: input.discountType === 'none' ? null : input.discountValue,
      codeExpiresAt: plusDays(input.sendAt, 14),
      budgetCapMinor: input.budgetCapMinor,
      templateId: input.templateId,
      rationale: input.rationale,
      estimatedReach,
    });
  } else {
    store.campaigns.push(campaign);
  }
  applyAutoApprove(campaign, userId, store.settings.autoApproveUnderMinor);
  return campaign;
}

async function estimatedAudience(ctx: TRPCContext) {
  return ctx.db.growthWaCustomer.count({
    where: {
      organizationId: organizationIdOf(ctx),
      whatsappOptIn: true,
      whatsappE164: { not: null },
    },
  });
}

export const growthRouter = router({
  customers: growthWhatsAppRouter.customers,
  whatsapp: growthWhatsAppRouter.whatsapp,
  channelTemplates: growthWhatsAppRouter.templates,
  connection: router({
    status: growthProcedure.query(({ ctx }): GrowthConnection =>
      connectionOf(growthStore(organizationIdOf(ctx)).settings)
    ),
  }),
  campaigns: router({
    list: growthProcedure
      .input(z.object({ tab: tabSchema.optional() }).optional())
      .query(({ ctx, input }) => {
        const store = growthStore(organizationIdOf(ctx));
        const tab: GrowthTab = input?.tab ?? 'all';
        const campaigns = store.campaigns
          .filter((campaign) => campaignInTab(campaign.status, tab))
          .map((campaign) => toCampaign(campaign))
          .sort(
            (left, right) =>
              left.sendAt.localeCompare(right.sendAt) || left.name.localeCompare(right.name)
          );
        return { campaigns };
      }),
    get: growthProcedure.input(z.object({ id: z.string().min(1) })).query(({ ctx, input }) => {
      const store = growthStore(organizationIdOf(ctx));
      const campaign = requireCampaign(store, input.id);
      const template = store.templates.find((item) => item.id === campaign.templateId);
      const recipients: GrowthRecipient[] = [];
      return {
        campaign: toCampaign(campaign),
        recipients,
        preview: previewFor(campaign, template),
      };
    }),
    create: growthProcedure.input(campaignWrite).mutation(async ({ ctx, input }) => {
      const store = growthStore(organizationIdOf(ctx));
      return toCampaign(writeCampaign(store, input, userIdOf(ctx), await estimatedAudience(ctx)));
    }),
    update: growthProcedure
      .input(campaignWrite.extend({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const store = growthStore(organizationIdOf(ctx));
        const campaign = requireCampaign(store, input.id);
        if (campaign.status !== 'proposed') bad('Only a proposal can be edited.');
        return toCampaign(
          writeCampaign(store, input, userIdOf(ctx), await estimatedAudience(ctx), campaign)
        );
      }),
    approve: growthProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(({ ctx, input }) => {
        const store = growthStore(organizationIdOf(ctx));
        const campaign = requireCampaign(store, input.id);
        if (campaign.status !== 'proposed') bad('Only a proposal can be approved.');
        campaign.status = 'approved';
        campaign.approvedBy = userIdOf(ctx);
        campaign.approvedAt = new Date().toISOString();
        return toCampaign(campaign);
      }),
    cancel: growthProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(({ ctx, input }) => {
        const store = growthStore(organizationIdOf(ctx));
        const campaign = requireCampaign(store, input.id);
        const cancellable: CampaignStatus[] = ['proposed', 'approved', 'scheduled'];
        if (!cancellable.includes(campaign.status))
          bad('This campaign can no longer be cancelled.');
        campaign.status = 'cancelled';
        return toCampaign(campaign);
      }),
  }),
  settings: router({
    get: growthProcedure.query(({ ctx }) =>
      toSettings(growthStore(organizationIdOf(ctx)).settings)
    ),
    update: growthProcedure.input(settingsWrite).mutation(({ ctx, input }) => {
      assertUrl(input.waApiUrl);
      assertDates(input.customDates);
      const settings = growthStore(organizationIdOf(ctx)).settings;
      settings.monthlyBudgetMinor = input.monthlyBudgetMinor;
      settings.autoApproveUnderMinor = input.autoApproveUnderMinor;
      settings.quietHoursStart = input.quietHoursStart;
      settings.quietHoursEnd = input.quietHoursEnd;
      settings.maxMsgsPerDay = input.maxMsgsPerDay;
      settings.maxDiscountPct = input.maxDiscountPct;
      settings.customDates = [...input.customDates];
      settings.waInstanceName = input.waInstanceName || null;
      settings.waApiUrl = input.waApiUrl || null;
      if (input.waApiKey) {
        settings.waApiKeyEnc = encryptSecret(input.waApiKey);
        settings.waApiKeyHint = keyHint(input.waApiKey);
      }
      return toSettings(settings);
    }),
  }),
  templates: router({
    list: growthProcedure.query(({ ctx }) => ({
      templates: growthStore(organizationIdOf(ctx)).templates.map((template) => ({ ...template })),
    })),
    update: growthProcedure
      .input(z.object({ id: z.string().min(1), body: z.string().trim().min(1).max(1000) }))
      .mutation(({ ctx, input }) => {
        const issue = templateIssues(input.body);
        if (issue) bad(issue);
        const store = growthStore(organizationIdOf(ctx));
        const template = store.templates.find((item) => item.id === input.id);
        if (!template) bad('That template is not on this shop.');
        template.body = input.body;
        for (const campaign of store.campaigns) {
          if (campaign.templateId !== template.id) continue;
          if (campaign.status !== 'approved' && campaign.status !== 'scheduled') continue;
          campaign.status = 'proposed';
          campaign.approvedBy = null;
          campaign.approvedAt = null;
        }
        return { ...template };
      }),
  }),
});
