import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ExpiryBoardProps } from '@/components/pharmacy/inventory/expiry-board';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  lots: vi.fn(),
  board: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/routers/pharmacy-inventory', () => ({
  EXPIRY_BOARD_WINDOWS: [30, 60, 90, 180],
  pharmacyInventoryRouter: { createCaller: () => ({ expiryBoardLots: mocks.lots }) },
}));
vi.mock('@/components/pharmacy/inventory/expiry-board', () => ({
  ExpiryBoard: (props: ExpiryBoardProps) => {
    mocks.board(props);
    return null;
  },
}));

import Page from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('passes serialized return calendars and cumulative risk from the server page to the board', async () => {
  const context = {
    session: { user: { id: 'user_a' } },
    organization: { id: 'org_a' },
    entitlements: {},
    db: {
      pharmacyBranch: {
        findMany: vi.fn().mockResolvedValue([{ id: 'branch_a', name: 'Main', city: 'Karachi' }]),
      },
    },
  };
  mocks.actor.mockResolvedValue(context);
  mocks.context.mockResolvedValue(context);
  const expiresAt = new Date('2026-12-31T00:00:00.000Z');
  const opensAt = new Date('2026-12-01T00:00:00.000Z');
  const generatedAt = new Date('2026-11-15T00:00:00.000Z');
  const riskBuckets = [30, 60, 90].map((days) => ({ days, valueAtRiskMinor: days * 100 }));
  mocks.lots.mockResolvedValue({
    generatedAt,
    riskBuckets,
    rows: [
      { expiresAt, returnWindowOpensAt: opensAt, returnDeadlineAt: expiresAt, markdown: null },
      { expiresAt, returnWindowOpensAt: null, returnDeadlineAt: null, markdown: null },
    ],
    suppliers: [{ id: 'supplier_a', name: 'Distributor' }],
  });

  render(await Page({ searchParams: Promise.resolve({ branch: 'branch_a', within: '30' }) }));

  expect(mocks.lots).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch_a', withinDays: 30 });
  expect(mocks.board).toHaveBeenCalledWith(
    expect.objectContaining({
      branchId: 'branch_a',
      withinDays: 30,
      generatedAt: generatedAt.toISOString(),
      riskBuckets,
      rows: [
        expect.objectContaining({
          expiresAt: expiresAt.toISOString(),
          returnWindowOpensAt: opensAt.toISOString(),
          returnDeadlineAt: expiresAt.toISOString(),
        }),
        expect.objectContaining({
          expiresAt: expiresAt.toISOString(),
          returnWindowOpensAt: null,
          returnDeadlineAt: null,
        }),
      ],
    })
  );
});

function contextWith(branches: Array<{ id: string; name: string; city: string }>) {
  const context = {
    session: { user: { id: 'user_a' } },
    organization: { id: 'org_a' },
    entitlements: {},
    db: { pharmacyBranch: { findMany: vi.fn().mockResolvedValue(branches) } },
  };
  mocks.actor.mockResolvedValue(context);
  mocks.context.mockResolvedValue(context);
  mocks.lots.mockResolvedValue({
    generatedAt: new Date('2026-11-15T00:00:00.000Z'),
    riskBuckets: [],
    rows: [],
    suppliers: [],
  });
}

const main = { id: 'branch_a', name: 'Main', city: 'Karachi' };
const north = { id: 'branch_b', name: 'North', city: 'Lahore' };

it.each(['30', '60', '90', '180'])('opens the %s-day drill-through window', async (within) => {
  contextWith([main, north]);
  render(await Page({ searchParams: Promise.resolve({ branch: 'branch_b', within }) }));
  expect(mocks.lots).toHaveBeenCalledExactlyOnceWith({
    branchId: 'branch_b',
    withinDays: Number(within),
  });
  expect(mocks.board).toHaveBeenCalledWith(
    expect.objectContaining({ withinDays: Number(within), branchId: 'branch_b' })
  );
  expect(screen.getByRole('combobox', { name: 'Expiring within' })).toHaveValue(within);
  expect(screen.getByText(new RegExp(`expires within ${within} days`))).toBeVisible();
});

it('defaults to the first branch when the link carries no branch', async () => {
  contextWith([main, north]);
  render(await Page({ searchParams: Promise.resolve({ within: '180' }) }));
  expect(mocks.lots).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch_a', withinDays: 180 });
});

it('defaults to the first branch when the given branch is not one of the caller’s', async () => {
  contextWith([main]);
  render(await Page({ searchParams: Promise.resolve({ branch: 'other_org', within: '60' }) }));
  expect(mocks.lots).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch_a', withinDays: 60 });
});

it('falls back to 90 days for an unsupported window', async () => {
  contextWith([main]);
  render(await Page({ searchParams: Promise.resolve({ within: '45' }) }));
  expect(mocks.lots).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch_a', withinDays: 90 });
});

it('shows a visible Show stock button and a single branch as text', async () => {
  contextWith([main]);
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('button', { name: 'Show stock' })).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'Branch' })).toBeNull();
  expect(screen.getByText('Main · Karachi')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Back to inventory' })).toHaveAttribute(
    'href',
    '/pharmacy/inventory?branch=branch_a'
  );
});
