import { mkdirSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKETING_ACCESS_DENIAL,
  MARKETING_ACCESS_FALLBACK,
} from '@/lib/pharmacy/marketing-access';
const mocks = vi.hoisted(() => ({
  branches: vi.fn(),
  growthHistory: vi.fn(),
  basketHistory: vi.fn(),
  history: vi.fn(),
  review: vi.fn(),
  deliveryHistory: vi.fn(),
  growthAvailability: vi.fn(),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: async () => ({}) }));
vi.mock('@/server/routers/pharmacy-marketing', () => ({
  pharmacyMarketingRouter: { createCaller: () => mocks },
}));
vi.mock('./actions', () => ({ marketingAction: vi.fn() }));
import Page from './page';
import Loading from './loading';
const campaign = {
  id: 'campaign-a',
  name: 'Autumn store update',
  status: 'DRAFT',
  scheduledAt: new Date('2026-10-07T07:00:00Z'),
  quietHours: { startHour: 22, endHour: 8 },
  frequencyCap: { max: 1, windowDays: 7 },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.growthHistory.mockResolvedValue({ insights: [], reviews: [] });
  mocks.growthAvailability.mockResolvedValue({
    companyAiEnabled: true,
    providerReady: true,
    canManageAiSettings: true,
  });
  mocks.basketHistory.mockResolvedValue({ insights: [], reviews: [] });
  mocks.deliveryHistory.mockResolvedValue({
    accepted: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
    suppressed: 0,
    attempts: [],
  });
  mocks.branches.mockResolvedValue([{ id: 'branch-a', name: 'Main branch' }]);
  mocks.history.mockResolvedValue({ campaigns: [], templates: [], timezone: 'Asia/Karachi' });
  mocks.review.mockResolvedValue({
    campaign,
    quietHours: campaign.quietHours,
    frequencyCap: campaign.frequencyCap,
    template: { body: 'Visit our store this week. Reply STOP to opt out.' },
    rules: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
  });
});
function snapshot(name: string, content: React.ReactNode) {
  if (!process.env.MARKETING_VISUAL_OUTPUT) return;
  mkdirSync(process.env.MARKETING_VISUAL_OUTPUT, { recursive: true });
  writeFileSync(
    `${process.env.MARKETING_VISUAL_OUTPUT}/${name}.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="studio.css"><title>Marketing synthetic review</title></head><body style="padding:24px;background:var(--surface-page);color:var(--text-body)">${renderToStaticMarkup(content)}</body></html>`
  );
}
it('shows empty and disabled states with honest preparation language', async () => {
  const page = await Page({ searchParams: Promise.resolve({}) });
  snapshot('empty', page);
  render(page);
  expect(screen.getByRole('heading', { name: 'Marketing', level: 1 })).toBeInTheDocument();
  expect(screen.getByText(/No campaigns yet/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  expect(screen.getByText(/No customer messages are sent/)).toBeInTheDocument();
});
it('shows a saved draft with review before approval', async () => {
  mocks.history.mockResolvedValue({
    campaigns: [campaign],
    templates: [{ id: 'template-a', name: 'Store welcome' }],
    timezone: 'Asia/Karachi',
  });
  const page = await Page({ searchParams: Promise.resolve({ campaign: 'campaign-a' }) });
  snapshot('review', page);
  render(page);
  expect(screen.getByRole('checkbox', { name: /I reviewed the copy/ })).toBeRequired();
  expect(screen.getByRole('button', { name: 'Approve campaign' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save prepared captures' })).not.toBeInTheDocument();
});
it('shows an explicit permission-denied state', async () => {
  mocks.branches.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
  const page = await Page({ searchParams: Promise.resolve({}) });
  snapshot('denied', page);
  render(page);
  expect(screen.getByRole('alert')).toHaveTextContent(MARKETING_ACCESS_FALLBACK);
  expect(mocks.history).not.toHaveBeenCalled();
});
describe('names the missing requirement and the next step (DEV-606)', () => {
  it.each([
    ['cashier', MARKETING_ACCESS_DENIAL.OWNER, /pharmacy owner/],
    ['owner without the license', MARKETING_ACCESS_DENIAL.LICENSE, /Pharmacy CRM/],
  ])('%s', async (_, message, named) => {
    mocks.branches.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN', message }));
    render(await Page({ searchParams: Promise.resolve({}) }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(named);
    // The old message listed every requirement at once.
    expect(alert).not.toHaveTextContent(/owner account, Pharmacy CRM license and/);
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });
  it('names an inactive branch and offers the active ones', async () => {
    mocks.history.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: MARKETING_ACCESS_DENIAL.BRANCH })
    );
    render(await Page({ searchParams: Promise.resolve({ branch: 'closed-branch' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('This branch is not active');
    expect(screen.getByRole('link', { name: 'Reload marketing' })).toHaveAttribute(
      'href',
      '/pharmacy/marketing'
    );
  });
  it('explains a workspace with no active branch and who activates one', async () => {
    mocks.branches.mockResolvedValue([]);
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'No active branches' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'no active pharmacy branch yet. Contact DevFathom support'
    );
  });
});
it('shows retry guidance on data errors', async () => {
  mocks.history.mockRejectedValue(new Error('database unavailable'));
  const page = await Page({ searchParams: Promise.resolve({}) });
  snapshot('error', page);
  render(page);
  expect(screen.getByRole('link', { name: 'Reload marketing' })).toHaveAttribute(
    'href',
    '/pharmacy/marketing'
  );
});
it('exposes loading status without motion dependence', () => {
  const page = <Loading />;
  snapshot('loading', page);
  render(page);
  expect(screen.getByRole('status')).toBeInTheDocument();
});

it('offers persisted sandbox outcomes and confirmed-rejection retry with visible simulated history', async () => {
  mocks.review.mockResolvedValue({
    campaign: { ...campaign, status: 'CAPTURED' },
    quietHours: campaign.quietHours,
    frequencyCap: campaign.frequencyCap,
    template: { body: 'Store update. Reply STOP.' },
    rules: { all: [] },
  });
  mocks.deliveryHistory.mockResolvedValue({
    accepted: 0,
    delivered: 0,
    failed: 1,
    unknown: 0,
    suppressed: 0,
    attempts: [
      {
        id: 'attempt-a',
        provider: 'sandbox',
        attemptNumber: 1,
        reservedAt: new Date('2026-10-06T12:00:00Z'),
        retryable: true,
      },
    ],
  });
  render(await Page({ searchParams: Promise.resolve({ campaign: 'campaign-a' }) }));
  expect(screen.getByRole('button', { name: 'Run sandbox dispatch' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Sandbox outcome' })).toBeInTheDocument();
  expect(
    screen.getByRole('checkbox', { name: /Retry confirmed rejections only/ })
  ).toBeInTheDocument();
  expect(screen.getByText(/Confirmed rejection — retry available/)).toBeInTheDocument();
});

it('keeps manual drafts available when growth history fails', async () => {
  mocks.growthHistory.mockRejectedValue(new Error('synthetic failure'));
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('alert')).toHaveTextContent('Insight history is unavailable');
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
});
it('shows explicit unavailable model status without inventing recommendations', async () => {
  mocks.growthHistory.mockResolvedValue({
    insights: [
      {
        id: 'synthetic',
        status: 'UNAVAILABLE',
        failureCode: 'CONFIGURATION',
        provider: null,
        model: null,
        createdAt: new Date('2026-10-07'),
        snapshot: {
          current: { from: '2026-09-01T00:00:00Z', cutoff: '2026-10-01T00:00:00Z' },
          comparison: { from: '2026-08-02T00:00:00Z', cutoff: '2026-09-01T00:00:00Z' },
          currency: 'PKR',
          facts: [
            {
              ref: 'e1',
              metric: 'receipt_count',
              value: '25',
              period: 'CURRENT',
              cohortSize: 12,
              coverage: 'PARTIAL',
              freshAt: '2026-10-01T00:00:00Z',
            },
          ],
        },
        output: null,
      },
    ],
    reviews: [],
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText(/AI insight unavailable \(CONFIGURATION\)/)).toBeInTheDocument();
  expect(screen.getByText('e1: 25')).toBeInTheDocument();
  expect(screen.getByText(/Coverage: partial; cohort: 12/)).toHaveTextContent(
    'anonymous receipts excluded'
  );
  expect(screen.getByText(/Comparison:/)).toHaveTextContent('2026-08-02');
  expect(screen.queryByRole('button', { name: 'Save review decision' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
});

it('shows suppressed evidence without zero counts or invented recommendations', async () => {
  mocks.growthHistory.mockResolvedValue({
    insights: [
      {
        id: 'small',
        status: 'INSUFFICIENT_DATA',
        createdAt: new Date('2026-10-07'),
        snapshot: {
          current: { from: '2026-09-01', cutoff: '2026-10-01' },
          comparison: { from: '2026-08-02', cutoff: '2026-09-01' },
          currency: 'PKR',
          facts: [],
        },
        output: null,
      },
    ],
    reviews: [],
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText(/No publishable facts/)).toBeInTheDocument();
  expect(screen.getByText(/Comparison:/)).toHaveTextContent('unknown, not zero');
  expect(screen.queryByRole('button', { name: 'Save review decision' })).not.toBeInTheDocument();
});

it('keeps manual drafting enabled without AI when a reviewed template exists', async () => {
  mocks.growthHistory.mockRejectedValue(new Error('unavailable'));
  mocks.history.mockResolvedValue({
    campaigns: [],
    templates: [{ id: 't1', name: 'Generic' }],
    timezone: 'UTC',
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
});

it('distinguishes accepted, failed and conflicting evidence and disables unsafe retry', async () => {
  mocks.review.mockResolvedValue({
    campaign: { ...campaign, status: 'CAPTURED' },
    quietHours: campaign.quietHours,
    frequencyCap: campaign.frequencyCap,
    template: { body: 'Reply STOP.' },
    rules: { all: [] },
  });
  mocks.deliveryHistory.mockResolvedValue({
    attempted: 3,
    accepted: 2,
    delivered: 1,
    failed: 2,
    unknown: 2,
    suppressed: 0,
    attempts: [
      { id: 'a', accepted: true },
      { id: 'b', failed: true },
      { id: 'c', contradictory: true, delivered: true, failed: true },
    ].map((a) => ({
      ...a,
      provider: 'sandbox',
      attemptNumber: 1,
      reservedAt: new Date('2026-10-07'),
    })),
  });
  render(await Page({ searchParams: Promise.resolve({ campaign: 'campaign-a' }) }));
  expect(screen.getByText(/Accepted; delivery unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Failed — resend blocked/)).toBeInTheDocument();
  expect(screen.getByText(/Conflicting evidence — resend blocked/)).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Retry confirmed rejections only/ })).toBeDisabled();
  expect(screen.getByText(/Attempted: 3/)).toHaveTextContent('Simulated delivery: 1');
});

it('opens the persisted campaign after a saved insight approval without offering another decision', async () => {
  mocks.growthHistory.mockResolvedValue({
    insights: [
      {
        id: 'ready',
        status: 'READY',
        createdAt: new Date('2026-10-07'),
        snapshot: {
          current: { from: '2026-09-01', cutoff: '2026-10-01' },
          comparison: { from: '2026-08-02', cutoff: '2026-09-01' },
          currency: 'PKR',
          facts: [
            {
              ref: 'e1',
              metric: 'receipt_count',
              value: '25',
              period: 'CURRENT',
              cohortSize: 12,
              coverage: 'COMPLETE',
              freshAt: '2026-10-01',
            },
          ],
          actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' }],
        },
        output: {
          recommendations: [
            {
              evidenceRefs: ['e1'],
              actionRef: 'a1',
              hypothesis: 'REVIEW_RETAIL',
              limitations: ['OBSERVATIONAL'],
            },
          ],
        },
      },
    ],
    reviews: [{ insightId: 'ready', recommendation: 0, decision: 'APPROVE', campaignId: 'saved' }],
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('link', { name: 'Open campaign review' })).toHaveAttribute(
    'href',
    '/pharmacy/marketing?branch=branch-a&campaign=saved'
  );
  expect(screen.queryByRole('button', { name: 'Save review decision' })).not.toBeInTheDocument();
  expect(
    screen.getByText(/Message cost is unavailable; net campaign profit is unknown/)
  ).toBeInTheDocument();
});

it('shows loyalty and inventory-cost insights as review-only with workspace links', async () => {
  const fact = {
    period: 'CURRENT',
    cohortSize: 12,
    coverage: 'COMPLETE',
    freshAt: '2026-10-01T00:00:00Z',
  };
  mocks.growthHistory.mockResolvedValue({
    insights: [
      {
        id: 'ready-review',
        status: 'READY',
        createdAt: new Date('2026-10-07'),
        snapshot: {
          vertical: 'PHARMACY',
          current: { from: '2026-09-01T00:00:00Z', cutoff: '2026-10-01T00:00:00Z' },
          comparison: { from: '2026-08-02T00:00:00Z', cutoff: '2026-09-01T00:00:00Z' },
          currency: 'PKR',
          facts: [
            { ...fact, ref: 'e1', metric: 'loyalty_eligible_count', value: '14' },
            { ...fact, ref: 'e2', metric: 'wastage_minor', value: '45000' },
          ],
          actions: [
            { ref: 'a1', kind: 'RETAIL_REVIEW' },
            { ref: 'a2', kind: 'LOYALTY_REVIEW' },
            { ref: 'a3', kind: 'INVENTORY_COST_REVIEW' },
          ],
        },
        output: {
          recommendations: [
            {
              evidenceRefs: ['e1'],
              actionRef: 'a2',
              hypothesis: 'REVIEW_RETENTION',
              limitations: ['OBSERVATIONAL'],
            },
            {
              evidenceRefs: ['e2'],
              actionRef: 'a3',
              hypothesis: 'REVIEW_INVENTORY_COST',
              limitations: ['OBSERVATIONAL'],
            },
          ],
        },
      },
    ],
    reviews: [
      { insightId: 'ready-review', recommendation: 1, decision: 'REJECT', campaignId: null },
    ],
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('link', { name: 'Open loyalty review' })).toHaveAttribute(
    'href',
    '/pharmacy/loyalty?branchId=branch-a'
  );
  expect(screen.getByRole('link', { name: 'Open inventory review' })).toHaveAttribute(
    'href',
    '/pharmacy/inventory?branch=branch-a'
  );
  // Only the unresolved loyalty card offers a decision, and it can only reject.
  expect(screen.getAllByRole('button', { name: 'Reject insight' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Save review decision' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Approve insight and create draft/)).not.toBeInTheDocument();
  expect(screen.getByText('Rejected. No campaign created.')).toBeInTheDocument();
});

describe('AI growth insights explain the next step and use plain inputs (DEV-591)', () => {
  beforeEach(() => {
    // 17:00 in Karachi on 2 November 2026: 1 November is the latest day that has ended.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  const generate = () => screen.getByRole('button', { name: 'Generate AI growth insights' });

  it('links an owner to the company AI switch when AI is off', async () => {
    mocks.growthAvailability.mockResolvedValue({
      companyAiEnabled: false,
      providerReady: true,
      canManageAiSettings: true,
    });
    render(await Page({ searchParams: Promise.resolve({}) }));
    const note = document.getElementById('growth-ai-next-step')!;
    expect(note).toHaveTextContent('AI growth insights are off for now.');
    expect(note).toHaveTextContent('Turn on Ask Fathom for your company');
    expect(within(note).getByRole('link', { name: 'Open Organization settings' })).toHaveAttribute(
      'href',
      '/organization'
    );
    expect(note).not.toHaveTextContent('DevFathom support');
    expect(generate()).toBeDisabled();
    expect(
      screen.queryByText(/Requires enabled AI settings and a configured provider/)
    ).not.toBeInTheDocument();
  });

  it('names DevFathom support when the AI provider is not connected', async () => {
    mocks.growthAvailability.mockResolvedValue({
      companyAiEnabled: true,
      providerReady: false,
      canManageAiSettings: true,
    });
    render(await Page({ searchParams: Promise.resolve({}) }));
    const note = document.getElementById('growth-ai-next-step')!;
    expect(note).toHaveTextContent(
      'Contact DevFathom support and ask them to connect an AI provider for your workspace'
    );
    expect(within(note).queryByRole('link')).not.toBeInTheDocument();
  });

  it('tells someone who cannot manage AI settings who to ask', async () => {
    mocks.growthAvailability.mockResolvedValue({
      companyAiEnabled: false,
      providerReady: true,
      canManageAiSettings: false,
    });
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(document.getElementById('growth-ai-next-step')).toHaveTextContent(
      'Ask your workspace owner to turn on Ask Fathom in Organization settings'
    );
  });

  it('still names both prerequisites when AI status cannot be read', async () => {
    mocks.growthAvailability.mockRejectedValue(new Error('synthetic'));
    render(await Page({ searchParams: Promise.resolve({}) }));
    const note = document.getElementById('growth-ai-next-step')!;
    expect(within(note).getByRole('link', { name: 'Open Organization settings' })).toBeVisible();
    expect(note).toHaveTextContent('contact DevFathom support');
    expect(generate()).toBeEnabled();
  });

  it('says which dates are missing when they are cleared and Generate is clicked (DEV-597)', async () => {
    render(await Page({ searchParams: Promise.resolve({}) }));
    const form = generate().closest('form')!;
    for (const label of ['First day', 'Last day'])
      fireEvent.change(within(form).getByLabelText(label), { target: { value: '' } });
    fireEvent.click(generate());
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('First day:');
    expect(alert).toHaveTextContent('Last day:');
  });

  it('shows no blocker and enables generation when AI is ready', async () => {
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(document.getElementById('growth-ai-next-step')).toBeNull();
    expect(generate()).toBeEnabled();
  });

  it('offers plain local day pickers defaulting to the last 30 completed days', async () => {
    render(await Page({ searchParams: Promise.resolve({}) }));
    const form = generate().closest('form')!;
    expect(within(form).getByLabelText('First day')).toHaveValue('2026-10-03');
    expect(within(form).getByLabelText('Last day')).toHaveValue('2026-11-01');
    expect(within(form).getByLabelText('Last day')).toHaveAttribute('max', '2026-11-01');
    expect(form.querySelector('input[name="timezone"]')).toHaveValue('Asia/Karachi');
    expect(within(form).getByText(/Whole days in Pakistan Standard Time/)).toBeInTheDocument();
  });

  it('removes UTC, ISO and replay jargon from labels; thresholds and keys sit behind Advanced', async () => {
    mocks.history.mockResolvedValue({
      campaigns: [{ ...campaign, status: 'CAPTURED' }],
      templates: [{ id: 'template-a', name: 'Store welcome' }],
      timezone: 'Asia/Karachi',
    });
    render(await Page({ searchParams: Promise.resolve({}) }));
    for (const jargon of [
      'Period start (UTC)',
      'Exclusive cutoff (UTC)',
      'Basket period start (UTC)',
      'Batch request key (reuse for replay)',
      'Scheduled time (ISO UTC)',
      'From (UTC)',
      'Cutoff (UTC, exclusive)',
      'Minimum support (fraction of all receipts)',
      'Minimum lift',
    ])
      expect(screen.queryByLabelText(jargon)).not.toBeInTheDocument();
    expect(screen.queryAllByText(/schedules below use explicit UTC/)).toHaveLength(0);
    expect(screen.getByRole('columnheader', { name: 'Send time' })).toBeInTheDocument();

    const batch = screen.getByLabelText('Batch reference');
    expect(batch.closest('details')).toHaveTextContent('Advanced: batch reference');
    expect(batch.closest('details')).not.toHaveAttribute('open');
    expect((batch as HTMLInputElement).value).toMatch(/^[0-9a-f-]{36}$/);
    for (const threshold of [/support/, /confidence/, /lift/])
      expect(screen.getByLabelText(threshold).closest('details')).toHaveTextContent(
        'Advanced: how strong a pair must be'
      );
    expect(screen.getByLabelText('Send date and time (Pakistan Standard Time)')).toHaveValue(
      '2026-11-03T10:00'
    );
    // Saved send times read in the same zone: 07:00Z is 12:00 in Karachi.
    expect(screen.getByText('2026-10-07 12:00')).toBeInTheDocument();
  });
});
