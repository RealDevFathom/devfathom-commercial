import { cleanup, render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: vi.fn(), list: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: { createCaller: () => ({ spaces: { list: mocks.list } }) },
}));
vi.mock('@/components/hotel/function-spaces-panel', () => ({
  HotelFunctionSpacesPanel: () => <p>Loaded spaces panel</p>,
}));

import Page from './page';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({});
});
afterEach(cleanup);

// Calls the loader and renders its resolved JSX. This is not Next RSC/browser acceptance.
it('renders loaded spaces', async () => {
  mocks.list.mockResolvedValue({ branchId: 'property', spaces: [] });
  render(await Page());
  expect(screen.getByText('Loaded spaces panel')).toBeVisible();
});

it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)('explains %s as access denial', async (code) => {
  mocks.list.mockRejectedValue(new TRPCError({ code }));
  render(await Page());
  expect(screen.getByRole('heading', { name: 'This page is not available to you' })).toBeVisible();
  expect(screen.queryByText(/complete property provisioning/)).toBeNull();
});

it('explains a missing property without claiming permission denial', async () => {
  mocks.list.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
  render(await Page());
  expect(screen.getByRole('heading', { name: 'This workspace has no property yet' })).toBeVisible();
  expect(screen.queryByText(/Sign in with an account/)).toBeNull();
});

it('rethrows unexpected load failures to the existing retry boundary', async () => {
  const failure = new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Connection unavailable',
  });
  mocks.list.mockRejectedValue(failure);
  await expect(Page()).rejects.toBe(failure);
});

it('preserves context failures instead of misreporting missing property provisioning', async () => {
  const failure = new Error('Context unavailable');
  mocks.context.mockRejectedValue(failure);
  await expect(Page()).rejects.toBe(failure);
  expect(mocks.list).not.toHaveBeenCalled();
});
