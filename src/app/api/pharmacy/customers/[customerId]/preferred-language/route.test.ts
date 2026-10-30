import { TRPCError } from '@trpc/server';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: vi.fn(), setLanguage: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/app/(app)/pharmacy/loyalty/loyalty-router', () => ({
  pharmacyLoyaltyRouter: { createCaller: () => ({ setPreferredLanguage: mocks.setLanguage }) },
}));

import { PATCH } from './route';

const params = { params: Promise.resolve({ customerId: 'customer-a' }) };
const request = (body = JSON.stringify({ branchId: 'branch-a', preferredLanguage: 'ur' })) =>
  new Request('http://pharmacy.localhost/api/pharmacy/customers/customer-a/preferred-language', {
    method: 'PATCH',
    body,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({});
  mocks.setLanguage.mockResolvedValue({ customerId: 'customer-a', preferredLanguage: 'ur' });
});

it('passes the validated language and customer to the tenant caller', async () => {
  const req = request();
  const response = await PATCH(req, params);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ customerId: 'customer-a', preferredLanguage: 'ur' });
  expect(mocks.context).toHaveBeenCalledWith({ req });
  expect(mocks.setLanguage).toHaveBeenCalledWith({
    branchId: 'branch-a',
    customerId: 'customer-a',
    preferredLanguage: 'ur',
  });
});

it.each([
  ['BAD_REQUEST', 400],
  ['UNAUTHORIZED', 401],
  ['FORBIDDEN', 403],
  ['NOT_FOUND', 404],
  ['INTERNAL_SERVER_ERROR', 500],
] as const)('maps %s to HTTP %i without exposing internal error details', async (code, status) => {
  mocks.setLanguage.mockRejectedValue(new TRPCError({ code, message: 'private failure details' }));

  const response = await PATCH(request(), params);

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: 'Customer language could not be updated.' });
});

it.each(['{', '{}', '{"branchId":"branch-a","preferredLanguage":"fr"}'])(
  'rejects invalid input before creating a caller: %s',
  async (body) => {
    expect((await PATCH(request(body), params)).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.setLanguage).not.toHaveBeenCalled();
  }
);
