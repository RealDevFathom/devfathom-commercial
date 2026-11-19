import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  branches: vi.fn(),
  console: vi.fn(),
  timezone: 'Asia/Karachi',
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: async () => ({
    session: { user: { role: 'ADMIN' } },
    organization: { timezone: mocks.timezone },
  }),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: async (actor: unknown) => actor }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: {
    createCaller: () => ({
      branches: mocks.branches,
      catalog: async () => ({ permissions: { financial: true } }),
    }),
  },
}));
vi.mock('./scenario-console', () => ({
  ScenarioConsole: (props: unknown) => {
    mocks.console(props);
    return null;
  },
}));
import Page from './page';
import Loading from './loading';
import ExpiryLoading from '../../inventory/expiry/loading';

beforeEach(() => {
  mocks.timezone = 'Asia/Karachi';
  mocks.console.mockClear();
  mocks.branches.mockResolvedValue({
    organizationId: 'org-1',
    branches: [{ id: 'b1', name: 'Main' }],
  });
});

it('defaults replenishment to the only authorized branch', async () => {
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(mocks.console).toHaveBeenCalledWith(
    expect.objectContaining({ initialBranchId: 'b1', invalidInitialBranch: false })
  );
});

it("passes the organisation's time zone so assumed arrival and expiry use its clock", async () => {
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(mocks.console).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'Asia/Karachi' }));
});

it('keeps an explicit unauthorized branch invalid and preserves the return filter', async () => {
  render(await Page({ searchParams: Promise.resolve({ branch: 'outside' }) }));
  expect(mocks.console).toHaveBeenCalledWith(
    expect.objectContaining({ initialBranchId: '', invalidInitialBranch: true })
  );
  expect(screen.getByRole('link', { name: 'Back to reports' })).toHaveAttribute(
    'href',
    '/pharmacy/reports?branch=outside'
  );
});

it('does not silently choose between multiple authorized branches', async () => {
  mocks.branches.mockResolvedValueOnce({
    organizationId: 'org-1',
    branches: [
      { id: 'b1', name: 'Main' },
      { id: 'b2', name: 'Second' },
    ],
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(mocks.console).toHaveBeenCalledWith(expect.objectContaining({ initialBranchId: '' }));
});

it('names each loading route correctly', () => {
  const first = render(<Loading />);
  expect(screen.getByRole('heading', { level: 1, name: 'Replenishment' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading Replenishment');
  first.unmount();
  render(<ExpiryLoading />);
  expect(screen.getByRole('heading', { level: 1, name: 'Expiry board' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading Expiry board');
});

it.each([
  // DEV-944: the replenishment reader counts the history on the organisation's clock and
  // accepts a history ending on the shop's today, so the default is the Karachi day.
  ['Asia/Karachi', '2026-11-18T19:30:00.000Z', '2026-11-19'],
  ['Asia/Karachi', '2026-11-18T18:59:00.000Z', '2026-11-18'],
  // An organisation on UTC keeps the UTC day.
  ['UTC', '2026-11-18T19:30:00.000Z', '2026-11-18'],
  ['UTC', '2026-11-18T18:59:00.000Z', '2026-11-18'],
])('defaults the history end to the %s day the reader counts at %s', async (zone, now, day) => {
  mocks.timezone = zone;
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
  try {
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(mocks.console).toHaveBeenCalledWith(expect.objectContaining({ today: day }));
  } finally {
    vi.useRealTimers();
  }
});
