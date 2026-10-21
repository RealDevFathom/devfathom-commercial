import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { isGrowthEnabled } from '@/lib/growth';
import { renderTemplate, SAMPLE_TEMPLATE_VARS, templateIssues } from '@/lib/growth/template-text';
import {
  CAMPAIGN_KINDS,
  TEMPLATE_KEYS,
  campaignInTab,
  type CampaignStatus,
  type GrowthCampaign,
  type GrowthConnection,
  type GrowthMessage,
  type GrowthRecipient,
  type GrowthSegment,
  type GrowthSettingsView,
  type GrowthSummary,
  type GrowthTab,
  type GrowthTemplate,
  type TemplateKey,
} from '@/lib/growth/view';
import { capabilityProcedure, router } from '@/server/trpc';

const growthProcedure = capabilityProcedure('growth.manage').use(async ({ ctx, next }) => {
  const organizationId = ctx.organization?.id ?? ctx.session?.user?.organizationId;
  if (!organizationId || !(await isGrowthEnabled(organizationId))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Growth AI is off for this shop.' });
  }
  return next();
});

const segmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({
    type: z.literal('churn_band'),
    band: z.enum(['low', 'medium', 'high', 'lost']),
  }),
  z.object({
    type: z.literal('birthday'),
    month: z.number().int().min(1).max(12),
    dayWindow: z.number().int().min(0).max(31).optional(),
  }),
  z.object({ type: z.literal('refill_due'), withinDays: z.number().int().min(1).max(30) }),
  z.object({
    type: z.literal('random'),
    pct: z.number().int().min(1).max(100),
    seed: z.number().int().optional(),
  }),
  z.object({ type: z.literal('top_spenders'), n: z.number().int().min(1).max(500) }),
  z.object({
    type: z.literal('inactive_days'),
    min: z.number().int().min(1),
    max: z.number().int().min(1),
  }),
]);

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

type FixtureRecipient = Omit<GrowthRecipient, 'phoneMasked'> & { phone: string };

type FixtureSettings = Omit<GrowthSettingsView, 'waApiKeyHint' | 'customDates'> & {
  customDates: string[];
  minSecondsBetweenMsgs: number;
  churnThreshold: number;
  waApiKeyEnc: string | null;
};

type FixtureCampaign = Omit<GrowthCampaign, 'redemptionCount'>;

type GrowthFixture = {
  organizationId: string;
  optedInCustomers: number;
  highChurnCustomers: number;
  settings: FixtureSettings;
  campaigns: FixtureCampaign[];
  recipients: FixtureRecipient[];
  templates: GrowthTemplate[];
  messages: GrowthMessage[];
};

const stores = new Map<string, GrowthFixture>();

function bad(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

function utcDay(day: number, hour = 8): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, 0, 0)).toISOString();
}

function plusDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function maskPhone(phone: string): string {
  return `•••• ${phone.replace(/\D/g, '').slice(-4)}`;
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
  const templates: GrowthTemplate[] = TEMPLATE_KEYS.map((key) => ({
    id: `tpl_${key}`,
    key,
    language: 'ur-en',
    body: templateBody(key),
  }));
  const sentAt = utcDay(10, 6);
  const campaigns: FixtureCampaign[] = [
    {
      id: 'cmp_winback',
      organizationId,
      kind: 'winback',
      status: 'proposed',
      name: 'Wapas aao',
      rationale:
        'Seventeen customers have not come back since their usual gap. A small 10% code usually brings a few of them in without spending the month cap. Salaam first, discount second.',
      segment: { type: 'churn_band', band: 'high' },
      sendAt: '2026-10-24T06:00:00.000Z',
      discountType: 'percent',
      discountValue: 10,
      codeExpiresAt: '2026-11-07T06:00:00.000Z',
      budgetCapMinor: 800_000,
      spentMinor: 0,
      templateId: 'tpl_winback',
      estimatedReach: 17,
      createdBy: 'ai',
      approvedBy: null,
      approvedAt: null,
    },
    {
      id: 'cmp_birthday',
      organizationId,
      kind: 'birthday',
      status: 'proposed',
      name: 'November birthdays',
      rationale:
        'Six birthdays fall in the next two weeks. A greeting with a small code is enough.',
      segment: { type: 'birthday', month: 11, dayWindow: 14 },
      sendAt: '2026-11-02T06:00:00.000Z',
      discountType: 'percent',
      discountValue: 10,
      codeExpiresAt: '2026-11-16T06:00:00.000Z',
      budgetCapMinor: 300_000,
      spentMinor: 0,
      templateId: 'tpl_birthday_offer',
      estimatedReach: 6,
      createdBy: 'ai',
      approvedBy: null,
      approvedAt: null,
    },
    {
      id: 'cmp_tuesday',
      organizationId,
      kind: 'slow_day',
      status: 'scheduled',
      name: 'Tuesday quiet counter',
      rationale: 'Tuesdays are under the weekly mean. A same-day code fills the quiet hour.',
      segment: { type: 'random', pct: 10, seed: 4 },
      sendAt: '2026-10-22T06:00:00.000Z',
      discountType: 'fixed',
      discountValue: 20_000,
      codeExpiresAt: '2026-10-23T06:00:00.000Z',
      budgetCapMinor: 500_000,
      spentMinor: 0,
      templateId: 'tpl_slow_day',
      estimatedReach: 13,
      createdBy: 'ai',
      approvedBy: 'user_owner',
      approvedAt: '2026-10-20T08:00:00.000Z',
    },
    {
      id: 'cmp_eid',
      organizationId,
      kind: 'holiday',
      status: 'sent',
      name: 'Eid offer',
      rationale: 'Eid week is the busy one. The cap stopped the offer once the discount was used.',
      segment: { type: 'all' },
      sendAt: sentAt,
      discountType: 'percent',
      discountValue: 10,
      codeExpiresAt: plusDays(sentAt, 14),
      budgetCapMinor: 500_000,
      spentMinor: 180_000,
      templateId: 'tpl_holiday',
      estimatedReach: 40,
      createdBy: 'ai',
      approvedBy: 'user_owner',
      approvedAt: plusDays(sentAt, -1),
    },
  ];
  const recipients: FixtureRecipient[] = [
    {
      id: 'rcp_ayesha',
      campaignId: 'cmp_eid',
      customerId: 'cus_ayesha',
      name: 'Ayesha Khan',
      phone: '+923001112233',
      code: 'SEHA-EID001',
      status: 'redeemed',
      sentAt,
      redeemedAt: utcDay(12, 9),
      saleId: 'sale_eid_1842',
      error: null,
    },
    {
      id: 'rcp_bilal',
      campaignId: 'cmp_eid',
      customerId: 'cus_bilal',
      name: 'Bilal Ahmed',
      phone: '+923214445566',
      code: 'SEHA-EID002',
      status: 'redeemed',
      sentAt,
      redeemedAt: utcDay(14, 11),
      saleId: 'sale_eid_1901',
      error: null,
    },
    {
      id: 'rcp_sana',
      campaignId: 'cmp_eid',
      customerId: 'cus_sana',
      name: 'Sana Iqbal',
      phone: '+923335557788',
      code: 'SEHA-EID003',
      status: 'delivered',
      sentAt,
      redeemedAt: null,
      saleId: null,
      error: null,
    },
    {
      id: 'rcp_farah',
      campaignId: 'cmp_eid',
      customerId: 'cus_farah',
      name: 'Farah Noor',
      phone: '+923009990011',
      code: 'SEHA-EID004',
      status: 'failed',
      sentAt: null,
      redeemedAt: null,
      saleId: null,
      error: 'Number not on WhatsApp',
    },
  ];
  return {
    organizationId,
    optedInCustomers: 128,
    highChurnCustomers: 17,
    settings: {
      monthlyBudgetMinor: 1_500_000,
      autoApproveUnderMinor: 50_000,
      quietHoursStart: 21,
      quietHoursEnd: 9,
      maxMsgsPerDay: 200,
      maxDiscountPct: 25,
      customDates: ['2026-11-09'],
      minSecondsBetweenMsgs: 4,
      churnThreshold: 60,
      waInstanceName: 'sehat-pharmacy',
      waApiUrl: 'http://127.0.0.1:8080',
      waApiKeyEnc: 'fixture-key-9f3a',
    },
    campaigns,
    recipients,
    templates,
    messages: [
      {
        id: 'msg_eid_out',
        customerId: 'cus_ayesha',
        direction: 'out',
        body: 'Salaam Ayesha Khan! 10% at Sehat Pharmacy till this week. Code SEHA-EID001. Reply STOP to opt out.',
        status: 'delivered',
        campaignId: 'cmp_eid',
        error: null,
        createdAt: sentAt,
      },
      {
        id: 'msg_eid_fail',
        customerId: 'cus_farah',
        direction: 'out',
        body: 'Salaam Farah Noor! 10% at Sehat Pharmacy. Code SEHA-EID004. Reply STOP to opt out.',
        status: 'failed',
        campaignId: 'cmp_eid',
        error: 'Number not on WhatsApp',
        createdAt: sentAt,
      },
      {
        id: 'msg_haan',
        customerId: 'cus_sana',
        direction: 'in',
        body: 'haan',
        status: 'received',
        campaignId: null,
        error: null,
        createdAt: utcDay(15, 9),
      },
    ],
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
  const organizationId = ctx.organization?.id ?? ctx.session?.user?.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  return organizationId;
}

function userIdOf(ctx: { session: { user?: { id?: string | null } | null } | null }): string {
  const userId = ctx.session?.user?.id;
  if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'You must be logged in.' });
  return userId;
}

function toCampaign(store: GrowthFixture, campaign: FixtureCampaign): GrowthCampaign {
  return {
    ...campaign,
    redemptionCount: store.recipients.filter(
      (recipient) => recipient.campaignId === campaign.id && recipient.status === 'redeemed'
    ).length,
  };
}

function toRecipient(recipient: FixtureRecipient): GrowthRecipient {
  return {
    id: recipient.id,
    campaignId: recipient.campaignId,
    customerId: recipient.customerId,
    name: recipient.name,
    phoneMasked: maskPhone(recipient.phone),
    code: recipient.code,
    status: recipient.status,
    sentAt: recipient.sentAt,
    redeemedAt: recipient.redeemedAt,
    saleId: recipient.saleId,
    error: recipient.error,
  };
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
    waApiKeyHint: keyHint(settings.waApiKeyEnc),
  };
}

function summaryOf(store: GrowthFixture): GrowthSummary {
  const month = new Date().toISOString().slice(0, 7);
  return {
    optedInCustomers: store.optedInCustomers,
    highChurnCustomers: store.highChurnCustomers,
    monthSpendMinor: store.campaigns
      .filter((campaign) => campaign.sendAt.slice(0, 7) === month)
      .reduce((sum, campaign) => sum + campaign.spentMinor, 0),
    monthlyBudgetMinor: store.settings.monthlyBudgetMinor,
    redemptionsThisMonth: store.recipients.filter((recipient) =>
      recipient.redeemedAt?.startsWith(month)
    ).length,
  };
}

function connectionOf(settings: FixtureSettings): GrowthConnection {
  const paired = Boolean(settings.waInstanceName && settings.waApiUrl && settings.waApiKeyEnc);
  let managerUrl: string | null = null;
  if (settings.waApiUrl) {
    try {
      const url = new URL(settings.waApiUrl);
      url.pathname = '/manager';
      url.search = '';
      url.hash = '';
      managerUrl = url.toString();
    } catch {
      managerUrl = null;
    }
  }
  return { status: paired ? 'connected' : 'needs_pairing', managerUrl };
}

function estimateReach(segment: GrowthSegment, optedIn: number): number {
  switch (segment.type) {
    case 'all':
      return optedIn;
    case 'churn_band':
      if (segment.band === 'high') return Math.min(17, optedIn);
      if (segment.band === 'medium') return Math.min(24, optedIn);
      if (segment.band === 'lost') return Math.min(9, optedIn);
      return Math.min(40, optedIn);
    case 'birthday':
      return Math.min(6, optedIn);
    case 'refill_due':
      return Math.min(4, optedIn);
    case 'random':
      return Math.max(1, Math.min(optedIn, Math.round((optedIn * segment.pct) / 100)));
    case 'top_spenders':
      return Math.min(segment.n, optedIn);
    case 'inactive_days':
      return Math.min(11, optedIn);
  }
}

function assertDiscount(store: GrowthFixture, input: z.infer<typeof campaignWrite>) {
  if (input.segment.type === 'inactive_days' && input.segment.min >= input.segment.max) {
    bad('Inactive days need a shorter start than the end.');
  }
  if (input.discountType === 'none') return;
  if (input.discountValue == null) bad('Enter the discount.');
  if (input.discountType === 'percent') {
    if (input.discountValue < 1 || input.discountValue > 100) bad('Percent discount is 1 to 100.');
    if (input.discountValue > store.settings.maxDiscountPct) {
      bad(`Max discount for this shop is ${store.settings.maxDiscountPct}%.`);
    }
  }
  if (input.discountType === 'fixed' && input.discountValue < 100) {
    bad('A fixed discount needs at least one rupee.');
  }
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
  template: GrowthTemplate | undefined,
  recipient: FixtureRecipient | undefined
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
    name: recipient?.name ?? SAMPLE_TEMPLATE_VARS.name ?? 'Ayesha',
    discount,
    code: recipient?.code ?? SAMPLE_TEMPLATE_VARS.code ?? 'SEHA-DEMO1',
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

export const growthRouter = router({
  metrics: router({
    summary: growthProcedure.query(({ ctx }): GrowthSummary =>
      summaryOf(growthStore(organizationIdOf(ctx)))
    ),
  }),
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
          .map((campaign) => toCampaign(store, campaign))
          .sort(
            (left, right) =>
              left.sendAt.localeCompare(right.sendAt) || left.name.localeCompare(right.name)
          );
        return { campaigns };
      }),
    get: growthProcedure.input(z.object({ id: z.string().min(1) })).query(({ ctx, input }) => {
      const store = growthStore(organizationIdOf(ctx));
      const campaign = requireCampaign(store, input.id);
      const recipients = store.recipients.filter(
        (recipient) => recipient.campaignId === campaign.id
      );
      const template = store.templates.find((item) => item.id === campaign.templateId);
      return {
        campaign: toCampaign(store, campaign),
        recipients: recipients.map(toRecipient),
        messages: store.messages.filter((message) => message.campaignId === campaign.id),
        preview: previewFor(campaign, template, recipients[0]),
      };
    }),
    create: growthProcedure.input(campaignWrite).mutation(({ ctx, input }) => {
      const store = growthStore(organizationIdOf(ctx));
      assertDiscount(store, input);
      requireTemplate(store, input.templateId);
      const campaign: FixtureCampaign = {
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
        estimatedReach: estimateReach(input.segment, store.optedInCustomers),
        createdBy: userIdOf(ctx),
        approvedBy: null,
        approvedAt: null,
      };
      store.campaigns.push(campaign);
      return toCampaign(store, campaign);
    }),
    update: growthProcedure
      .input(campaignWrite.extend({ id: z.string().min(1) }))
      .mutation(({ ctx, input }) => {
        const store = growthStore(organizationIdOf(ctx));
        const campaign = requireCampaign(store, input.id);
        if (campaign.status !== 'proposed') bad('Only a proposal can be edited.');
        assertDiscount(store, input);
        requireTemplate(store, input.templateId);
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
          estimatedReach: estimateReach(input.segment, store.optedInCustomers),
        });
        return toCampaign(store, campaign);
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
        return toCampaign(store, campaign);
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
        return toCampaign(store, campaign);
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
      if (input.waApiKey) settings.waApiKeyEnc = input.waApiKey;
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
        const template = growthStore(organizationIdOf(ctx)).templates.find(
          (item) => item.id === input.id
        );
        if (!template) bad('That template is not on this shop.');
        template.body = input.body;
        return { ...template };
      }),
  }),
  messages: router({
    list: growthProcedure
      .input(z.object({ campaignId: z.string().min(1).optional() }).optional())
      .query(({ ctx, input }) => {
        const messages = growthStore(organizationIdOf(ctx))
          .messages.filter(
            (message) => !input?.campaignId || message.campaignId === input.campaignId
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        return { messages };
      }),
    sendTest: growthProcedure
      .input(
        z.object({
          toE164: z.string().regex(/^\+[1-9]\d{8,14}$/, 'Use a full number like +923001234567.'),
        })
      )
      .mutation(({ ctx }) => {
        const store = growthStore(organizationIdOf(ctx));
        const template =
          store.templates.find((item) => item.key === 'generic') ?? store.templates[0];
        if (!template || templateIssues(template.body)) {
          bad('The generic template needs a valid body with STOP before a test can be queued.');
        }
        const first = ctx.session?.user?.name?.split(' ')[0];
        const message: GrowthMessage = {
          id: `msg_${crypto.randomUUID()}`,
          customerId: null,
          direction: 'out',
          body: renderTemplate(template.body, {
            ...SAMPLE_TEMPLATE_VARS,
            name: first || SAMPLE_TEMPLATE_VARS.name || 'there',
          }),
          status: 'queued',
          campaignId: null,
          error: null,
          createdAt: new Date().toISOString(),
        };
        store.messages.push(message);
        return message;
      }),
  }),
});
