import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tenantContext: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  readFiscalExceptions: vi.fn(),
}));
vi.mock('@/app/(app)/pharmacy/purchasing/_lib/console', () => ({
  tenantContext: mocks.tenantContext,
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/lib/pharmacy/accounts/fiscal-exceptions.reader', () => ({
  readFiscalExceptions: mocks.readFiscalExceptions,
}));

import Page from './page';
import Loading from './loading';

const db = {
  pharmacyBranch: {
    findMany: vi.fn().mockResolvedValue([{ id: 'branch-1', name: 'Main' }]),
  },
};
const context = {
  session: { user: { id: 'user-1', role: 'ADMIN' } },
  organization: { id: 'org-1' },
  entitlements: { organizationId: 'org-1' },
  requestMeta: { ip: null },
  db,
};
const query = { branch: 'branch-1', from: '2026-10-01', to: '2026-11-01' };

beforeEach(() => {
  mocks.tenantContext.mockResolvedValue(context);
  mocks.hasModule.mockReturnValue(true);
  mocks.can.mockResolvedValue(true);
  mocks.readFiscalExceptions.mockResolvedValue({
    branch: { id: 'branch-1', name: 'Main' },
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    observedAt: '2026-10-25T00:00:00.000Z',
    page: 1,
    pageSize: 50,
    coverage: 'CURRENT_READ_COMPLETE',
    hasMore: false,
    rows: [],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('fiscal exception evidence page', () => {
  it('denies missing capability before branch or fiscal data reads', async () => {
    mocks.can.mockResolvedValueOnce(false);
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(screen.getByRole('alert')).toHaveTextContent(/both operational and financial/);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(mocks.readFiscalExceptions).not.toHaveBeenCalled();
  });

  it('denies missing Reports entitlement before data reads', async () => {
    mocks.hasModule.mockReturnValue(false);
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(mocks.readFiscalExceptions).not.toHaveBeenCalled();
  });

  it('does not fall back when the explicit branch is invalid', async () => {
    render(await Page({ searchParams: Promise.resolve({ ...query, branch: 'foreign' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent(/explicitly requested branch/);
    expect(mocks.readFiscalExceptions).not.toHaveBeenCalled();
  });

  it('rejects overlong windows and duplicate inputs before fiscal data reads', async () => {
    render(await Page({ searchParams: Promise.resolve({ ...query, to: '2027-02-01' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent(/no longer than 92 days/);
    expect(mocks.readFiscalExceptions).not.toHaveBeenCalled();
    cleanup();
    render(
      await Page({ searchParams: Promise.resolve({ ...query, branch: ['branch-1', 'foreign'] }) })
    );
    expect(mocks.readFiscalExceptions).not.toHaveBeenCalled();
  });

  it('renders honest coverage, empty state, mode warning and safe CSV export', async () => {
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(mocks.can).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'reports:operational',
      undefined,
      expect.anything()
    );
    expect(mocks.can).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'reports:financial',
      undefined,
      expect.anything()
    );
    expect(screen.getByText(/All matching current rows/)).toBeInTheDocument();
    expect(
      screen.getByText(/SANDBOX outcomes are operational test evidence only/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download safe CSV' })).toHaveAttribute('download');
  });

  it('suppresses results and raw errors when the reader fails', async () => {
    mocks.readFiscalExceptions.mockRejectedValue(new Error('provider secret payload'));
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(screen.getByRole('alert')).toHaveTextContent(/current-state evidence read failed/);
    expect(screen.queryByText(/provider secret payload/)).not.toBeInTheDocument();
    expect(screen.queryByText('Exception register')).not.toBeInTheDocument();
  });

  it('has a meaningful loading state', () => {
    render(<Loading />);
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/Verifying branch scope/);
  });
});

describe('canonical ADMIN financial envelope', () => {
  it('denies a non-admin with both capabilities before branch/data reads', async () => {
    mocks.tenantContext.mockResolvedValue({
      ...context,
      session: { user: { id: 'staff', role: 'EMPLOYEE' } },
    });
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(mocks.readFiscalExceptions).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Download safe CSV' })).not.toBeInTheDocument();
  });
});
