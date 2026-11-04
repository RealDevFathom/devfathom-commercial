import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  receive: vi.fn(),
  form: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/routers/pharmacy-inventory', () => ({
  pharmacyInventoryRouter: { createCaller: mocks.caller },
}));
vi.mock('@/components/pharmacy/inventory/transfers/transfer-card', () => ({
  TransferCard: (props: unknown) => {
    mocks.form(props);
    return null;
  },
}));

import PharmacyTransfersPage from './page';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  const ctx = {
    session: { user: { id: 'receiver' } },
    organization: { id: 'org' },
    db: {
      pharmacyBranch: {
        findMany: vi.fn().mockResolvedValue([{ id: 'destination', name: 'Main' }]),
      },
      pharmacyStockBalance: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
  mocks.actor.mockResolvedValue(ctx);
  mocks.context.mockResolvedValue(ctx);
  mocks.caller.mockReturnValue({
    transferBoard: vi
      .fn()
      .mockResolvedValue([
        { id: 'transfer', direction: 'INBOUND', status: 'DISPATCHED', lines: [] },
      ]),
    receiveTransferWithVariance: mocks.receive,
  });
});

it.each([
  ['PARTIALLY_RECEIVED', 'Partial receipt recorded. Outstanding stock remains in transit.'],
  ['RECEIVED', 'Transfer received and closed.'],
])('reports the returned %s receipt status', async (status, notice) => {
  mocks.receive.mockResolvedValue({ transfer: { status }, variances: [] });
  render(await PharmacyTransfersPage({ searchParams: Promise.resolve({ branch: 'destination' }) }));
  const action = mocks.form.mock.calls[0]![0].action as (data: FormData) => Promise<string>;
  const data = new FormData();
  for (const [key, value] of Object.entries({
    action: 'receive',
    branchId: 'destination',
    transferId: 'transfer',
    receiptKey: 'd091789c-a82a-4fd9-a51b-86b60830dc6c',
    'received:line': '4',
  }))
    data.set(key, value);
  const destination = new URL(await action(data), 'http://localhost');
  expect(mocks.receive).toHaveBeenCalledOnce();
  expect(destination.searchParams.get('kind')).toBe('success');
  expect(destination.searchParams.get('notice')).toBe(notice);
});
