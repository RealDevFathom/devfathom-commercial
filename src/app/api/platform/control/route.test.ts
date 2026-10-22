import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  requirePlatformSession: vi.fn(),
  executePlatformCommand: vi.fn(),
  assertPlatformMutationOrigin: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: mocks.requirePlatformSession }));
vi.mock('@/lib/platform/commands', () => ({
  executePlatformCommand: mocks.executePlatformCommand,
}));
vi.mock('@/lib/platform/security', () => ({
  assertPlatformMutationOrigin: mocks.assertPlatformMutationOrigin,
  PlatformSecurityError: class PlatformSecurityError extends Error {},
}));

import { POST } from './route';

describe('POST /api/platform/control validation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePlatformSession.mockResolvedValue({ id: 'operator_1' });
  });

  it('returns only a friendly message and path-addressable field errors', async () => {
    const schema = z.object({
      businessDayCutoff: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 09:30'),
    });
    mocks.executePlatformCommand.mockImplementation(() => schema.parse({ businessDayCutoff: '4' }));

    const response = await POST(
      new Request('https://admin.test/api/platform/control', {
        method: 'POST',
        body: JSON.stringify({ action: 'organization.create', payload: {} }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Business day cutoff: Use 24-hour time, e.g. 09:30');
    expect(body.fieldErrors).toEqual({
      businessDayCutoff: 'Use 24-hour time, e.g. 09:30',
    });
    expect(JSON.stringify(body)).not.toMatch(/\"(?:code|origin|inclusive)\"/);
  });
});
