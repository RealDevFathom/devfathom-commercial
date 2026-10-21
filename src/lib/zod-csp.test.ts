import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('validates nested counter data without probing or compiling Function', async () => {
  const compile = vi.fn(() => {
    throw new Error('CSP forbids eval');
  });
  vi.stubGlobal('Function', compile);
  const { z } = await import('./zod-csp');
  const schema = z.object({ input: z.object({ amount: z.number().positive() }) });
  expect(schema.parse({ input: { amount: 10 } })).toEqual({ input: { amount: 10 } });
  expect(schema.safeParse({ input: { amount: -1 } }).success).toBe(false);
  const { tenderAttemptStorageKey } =
    await import('@/components/pharmacy/counter/tender-attempt-storage');
  expect(
    tenderAttemptStorageKey({ organizationId: 'org', accountId: 'user', branchId: 'branch' })
  ).toContain('org');
  expect(compile).not.toHaveBeenCalled();
});
