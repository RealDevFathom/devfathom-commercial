import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), findMany: vi.fn() }));
vi.mock('@/lib/platform/page-access', () => ({ requirePlatformRead: mocks.read }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({ jurisdictionRuleSet: { findMany: mocks.findMany } }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import Page from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
});
afterEach(cleanup);
it('checks platform access and refuses non-SuperAdmin before reading rules', async () => {
  mocks.read.mockResolvedValue({ role: 'OPERATIONS' });
  render(await Page());
  expect(mocks.read).toHaveBeenCalledWith('/platform/settings');
  expect(mocks.findMany).not.toHaveBeenCalled();
  expect(screen.getByText('SuperAdmin access required')).toBeInTheDocument();
});
it('lists rule versions for a SuperAdmin in code and descending version order', async () => {
  mocks.read.mockResolvedValue({ role: 'SUPER_ADMIN' });
  render(await Page());
  expect(mocks.findMany).toHaveBeenCalledWith({ orderBy: [{ code: 'asc' }, { version: 'desc' }] });
  expect(screen.getByText('No rule sets published')).toBeInTheDocument();
});
