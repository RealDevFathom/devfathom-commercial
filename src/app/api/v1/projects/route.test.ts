// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: unknown) => handler,
}));
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));

import { POST } from './route';

describe('POST /api/v1/projects date validation', () => {
  it('returns 400 without writing when the end date precedes the start date', async () => {
    const projectCreate = vi.fn();
    const handler = POST as unknown as (ctx: unknown, request: Request) => Promise<Response>;
    const response = await handler(
      { userId: 'user-1', db: { project: { create: projectCreate } } },
      new Request('https://example.test/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid project',
          type: 'INTERNAL',
          startDate: '2026-10-22T00:00:00.000Z',
          endDate: '2026-10-21T00:00:00.000Z',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid input',
      details: [
        {
          path: ['endDate'],
          message: 'End date must be on or after the start date.',
        },
      ],
    });
    expect(projectCreate).not.toHaveBeenCalled();
  });
});
