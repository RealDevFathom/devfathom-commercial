import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ExpiryBoardProps } from '@/components/pharmacy/inventory/expiry-board';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  lots: vi.fn(),
  board: vi.fn(),
  assigned: vi.fn(async () => new Set(['branch_a'])),
  claim: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/routers/pharmacy-inventory', () => ({
  admittedInventoryBranchIds: mocks.assigned,
  EXPIRY_BOARD_WINDOWS: [30, 60, 90, 180],
  pharmacyInventoryRouter: {
    createCaller: () => ({ expiryBoardLots: mocks.lots, draftExpiryReturnClaim: mocks.claim }),
  },
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

it('DEV-660: explains a missing branch assignment instead of reading the board', async () => {
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
  mocks.assigned.mockResolvedValueOnce(new Set());

  const view = render(await Page({ searchParams: Promise.resolve({ branch: 'branch_a' }) }));

  expect(view.getByText('Branch assignment required')).toBeVisible();
  expect(mocks.lots).not.toHaveBeenCalled();
  expect(mocks.board).not.toHaveBeenCalled();
});

it('DEV-660: opens an assigned branch instead of an unassigned one named in the URL', async () => {
  const context = {
    session: { user: { id: 'user_a' } },
    organization: { id: 'org_a' },
    entitlements: {},
    db: {
      pharmacyBranch: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'branch_a', name: 'Main', city: 'Karachi' },
          { id: 'branch_b', name: 'Other', city: 'Lahore' },
        ]),
      },
    },
  };
  mocks.actor.mockResolvedValue(context);
  mocks.context.mockResolvedValue(context);
  mocks.lots.mockResolvedValue({
    generatedAt: new Date('2026-11-15T00:00:00.000Z'),
    riskBuckets: [],
    rows: [],
    suppliers: [],
  });

  const view = render(await Page({ searchParams: Promise.resolve({ branch: 'branch_b' }) }));

  expect(mocks.lots).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch_a', withinDays: 90 });
  expect(view.queryByRole('option', { name: /Other/ })).toBeNull();
});

it('DEV-728: drafts one distributor return claim through the server procedure', async () => {
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
  mocks.lots.mockResolvedValue({
    generatedAt: new Date('2026-11-15T00:00:00.000Z'),
    riskBuckets: [],
    rows: [],
    suppliers: [],
  });
  mocks.claim.mockResolvedValue({
    created: true,
    purchaseReturn: { id: 'ret_1', reference: 'EXPC-1', status: 'DRAFT' },
    lineCount: 2,
    skipped: 1,
  });
  render(await Page({ searchParams: Promise.resolve({ branch: 'branch_a', within: '60' }) }));
  const { action } = mocks.board.mock.calls[0]![0] as ExpiryBoardProps;

  const data = new FormData();
  data.set('action', 'claim');
  data.set('branchId', 'branch_a');
  data.set('within', '60');
  data.set('supplierId', 'supplier_a');
  data.set('reason', 'Near-expiry return claim');
  data.append('position', 'lot_1|location_1');
  data.append('position', 'lot_2|location_2');
  await action(data);

  expect(mocks.claim).toHaveBeenCalledExactlyOnceWith({
    branchId: 'branch_a',
    supplierId: 'supplier_a',
    positions: [
      { inventoryLotId: 'lot_1', stockLocationId: 'location_1' },
      { inventoryLotId: 'lot_2', stockLocationId: 'location_2' },
    ],
    reason: 'Near-expiry return claim',
  });
  const destination = new URL(String(mocks.redirect.mock.calls[0]![0]), 'https://app.invalid');
  expect(destination.searchParams.get('kind')).toBe('success');
  expect(destination.searchParams.get('within')).toBe('60');
  expect(destination.searchParams.get('notice')).toContain('Expiry claim draft EXPC-1');
  expect(destination.searchParams.get('notice')).toContain('2 lots (1 skipped');
});
