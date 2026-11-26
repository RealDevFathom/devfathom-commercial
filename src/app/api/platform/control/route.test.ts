import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  processStarterImports: vi.fn(),
  requirePlatformSession: vi.fn(),
  executePlatformCommand: vi.fn(),
  assertPlatformMutationOrigin: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: mocks.after,
}));
vi.mock('@/lib/pharmacy/migration/starter-worker', () => ({
  processStarterImports: mocks.processStarterImports,
}));
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: mocks.requirePlatformSession }));
vi.mock('@/lib/platform/commands', () => ({
  executePlatformCommand: mocks.executePlatformCommand,
}));
vi.mock('@/lib/platform/security', () => ({
  assertPlatformMutationOrigin: mocks.assertPlatformMutationOrigin,
  ActivationPreflightError: class ActivationPreflightError extends Error {},
  PlatformSecurityError: class PlatformSecurityError extends Error {
    status = 403;
  },
}));

import { POST } from './route';
import { PlatformSecurityError } from '@/lib/platform/security';

function request() {
  return new Request('https://admin.test/api/platform/control', {
    method: 'POST',
    body: JSON.stringify({ action: 'organization.create', payload: {} }),
  });
}

describe('POST /api/platform/control validation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePlatformSession.mockResolvedValue({ id: 'operator_1' });
  });

  it('returns friendly field errors without serializing Zod internals', async () => {
    const schema = z.object({
      businessDayCutoff: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 09:30'),
    });
    mocks.executePlatformCommand.mockImplementation(() => schema.parse({ businessDayCutoff: '4' }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'Business Day Cutoff: Use 24-hour time, e.g. 09:30',
      fieldErrors: { businessDayCutoff: 'Use 24-hour time, e.g. 09:30' },
    });
    expect(JSON.stringify(body)).not.toMatch(/"(?:details|issues|code|origin|inclusive)":/);
  });

  it('preserves platform security messages', async () => {
    mocks.executePlatformCommand.mockRejectedValue(
      new PlatformSecurityError('This action is not permitted.', 403)
    );
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'This action is not permitted.' });
  });
});

it('wakes the new pharmacy import after the successful setup response', async () => {
  mocks.after.mockClear();
  mocks.executePlatformCommand.mockResolvedValue({ id: 'qa-new-pharmacy', vertical: 'PHARMACY' });
  expect((await POST(request())).status).toBe(200);
  expect(mocks.processStarterImports).not.toHaveBeenCalled();
  expect(mocks.after).toHaveBeenCalledTimes(1);
  await mocks.after.mock.calls[0]![0]();
  expect(mocks.processStarterImports).toHaveBeenCalledWith('qa-new-pharmacy');
});
