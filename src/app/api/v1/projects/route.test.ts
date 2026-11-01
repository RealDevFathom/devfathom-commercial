// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({
  assertInOrganization: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: unknown) => handler,
}));
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/org-refs', () => ({
  assertInOrganization: mocks.assertInOrganization,
}));

import { POST } from './route';

const handler = POST as unknown as (ctx: unknown, request: Request) => Promise<Response>;

describe('POST /api/v1/projects date validation', () => {
  it('returns 400 without writing when the end date precedes the start date', async () => {
    const projectCreate = vi.fn();
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

const ctx = {
  organizationId: 'org_1',
  userId: 'user_creator',
  db: {
    user: { findMany: vi.fn() },
    client: { findMany: vi.fn() },
    project: { create: mocks.create },
  },
};

const request = (body: Record<string, unknown>) =>
  new Request('https://example.test/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Tenant-safe project', type: 'CLIENT', ...body }),
  });

describe('POST /api/v1/projects organization references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertInOrganization.mockResolvedValue(undefined);
    mocks.create.mockResolvedValue({ id: 'project_1', name: 'Tenant-safe project' });
  });

  it('validates every member and the client in the token organization before creating', async () => {
    await handler(ctx, request({ clientId: 'client_1', memberIds: ['user_member'] }));

    expect(mocks.assertInOrganization).toHaveBeenNthCalledWith(
      1,
      ctx.db.user,
      'org_1',
      ['user_creator', 'user_member']
    );
    expect(mocks.assertInOrganization).toHaveBeenNthCalledWith(
      2,
      ctx.db.client,
      'org_1',
      ['client_1']
    );
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.assertInOrganization.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]
    );
  });

  it.each([['member'], ['client']])('does not write when the %s is foreign', async (kind) => {
    const foreignReference = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    mocks.assertInOrganization.mockReset();
    if (kind === 'member') {
      mocks.assertInOrganization.mockRejectedValueOnce(foreignReference);
    } else {
      mocks.assertInOrganization
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(foreignReference);
    }

    const response = await handler(
      ctx,
      request({ clientId: 'foreign_client', memberIds: ['foreign_user'] })
    );

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
