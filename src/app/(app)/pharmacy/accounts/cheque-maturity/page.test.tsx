import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tenantContext: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  branches: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock('../../purchasing/_lib/console', () => ({ tenantContext: mocks.tenantContext }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: () => ({ workspace: mocks.workspace }) },
}));

import Page from './page';

const context = () => ({
  session: { user: { id: 'owner', role: 'ADMIN' } },
  entitlements: { organizationId: 'org-1' },
  organization: { id: 'org-1' },
  requestMeta: { ip: null },
  db: { pharmacyBranch: { findMany: mocks.branches } },
});
const cheque = (index: number) => ({
  id: `tx-${index}`,
  kind: 'CHEQUE',
  reference: `CH-${index}`,
  status: 'POSTED',
  chequeStatus: 'PDC',
  chequeDueAt: new Date('2026-10-28T23:59:59Z'),
  amountMinor: 100,
  currency: 'PKR',
});
const show = async (branch: string | string[] | undefined = 'branch-1') =>
  render(await Page({ searchParams: Promise.resolve({ branch }) }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenantContext.mockResolvedValue(context());
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  mocks.branches.mockResolvedValue([{ id: 'branch-1', name: 'Main' }]);
  mocks.workspace.mockResolvedValue({ transactions: [] });
});
afterEach(cleanup);

describe('cheque maturity accounts page', () => {
  it.each(['session', 'capability', 'module'])(
    'denies missing %s before workspace reads',
    async (reason) => {
      if (reason === 'session') mocks.tenantContext.mockResolvedValue(null);
      if (reason === 'capability') mocks.can.mockResolvedValue(false);
      if (reason === 'module') mocks.hasModule.mockReturnValue(false);
      await show();
      expect(
        screen.getByRole('heading', { name: 'Financial report access required' })
      ).toBeVisible();
      expect(mocks.workspace).not.toHaveBeenCalled();
    }
  );

  it('labels empty and exact-cap live reads without claiming completeness', async () => {
    const view = await show();
    expect(screen.getByText(/contained no safe cheque evidence/i)).toBeVisible();
    expect(screen.getByText(/full branch coverage unknown/i)).toBeVisible();
    view.unmount();
    mocks.workspace.mockResolvedValue({
      transactions: Array.from({ length: 50 }, (_, index) => cheque(index)),
    });
    await show();
    expect(screen.getByText(/exactly 50 means the read cap was reached/i)).toBeVisible();
    expect(screen.getAllByText('PDC')).toHaveLength(50);
  });

  it('rejects foreign branch input and contains reader errors without writes or leaked details', async () => {
    const view = await show(['branch-1', 'foreign']);
    expect(screen.getByText(/Select an authorized active branch/)).toBeVisible();
    expect(mocks.workspace).not.toHaveBeenCalled();
    view.unmount();
    mocks.workspace.mockRejectedValue(new Error('secret database detail'));
    await show();
    expect(
      screen.getByText(/No cached data is shown and no financial record was changed/)
    ).toBeVisible();
    expect(screen.queryByText(/secret database detail/)).toBeNull();
  });
});
