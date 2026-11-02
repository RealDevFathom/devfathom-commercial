import { mkdirSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
