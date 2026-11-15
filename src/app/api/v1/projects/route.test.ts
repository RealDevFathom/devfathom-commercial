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

describe('POST /api/v1/projects workspace scoping', () => {
  type Where = { id: string | { in: string[] }; organizationId: string };
  function makeCtx(orgUsers: string[], orgClients: string[]) {
    const projectCreate = vi.fn(async ({ data }: { data: { name: string } }) => ({
      id: 'project-1',
      name: data.name,
    }));
    const userFindMany = vi.fn(async ({ where }: { where: Where }) =>
      where.organizationId === 'org-1' && typeof where.id === 'object'
        ? where.id.in.filter((id) => orgUsers.includes(id)).map((id) => ({ id }))
        : []
    );
    const clientFindFirst = vi.fn(async ({ where }: { where: Where }) =>
      where.organizationId === 'org-1' &&
      typeof where.id === 'string' &&
      orgClients.includes(where.id)
        ? { id: where.id }
        : null
    );
    return {
      projectCreate,
      userFindMany,
      clientFindFirst,
      ctx: {
        userId: 'user-1',
        organizationId: 'org-1',
        db: {
          project: { create: projectCreate },
          user: { findMany: userFindMany },
          client: { findFirst: clientFindFirst },
        },
      },
    };
  }
  const handler = POST as unknown as (ctx: unknown, request: Request) => Promise<Response>;
  const post = (ctx: unknown, body: Record<string, unknown>) =>
    handler(
      ctx,
      new Request('https://example.test/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Scoped project', type: 'CLIENT', ...body }),
      })
    );

  it('rejects a clientId from another organization without writing', async () => {
    const { ctx, projectCreate, clientFindFirst } = makeCtx(['user-1'], ['client-1']);
    const response = await post(ctx, { clientId: 'foreign-client' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'clientId does not exist.' });
    expect(clientFindFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-client', organizationId: 'org-1' },
      select: { id: true },
    });
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('rejects a memberId from another organization without writing', async () => {
    const { ctx, projectCreate, userFindMany } = makeCtx(['user-1', 'user-2'], []);
    const response = await post(ctx, { memberIds: ['user-2', 'foreign-user'] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'memberIds contains an unknown user.' });
    expect(userFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['user-1', 'user-2', 'foreign-user'] }, organizationId: 'org-1' },
      select: { id: true },
    });
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('creates the project when every reference belongs to the organization', async () => {
    const { ctx, projectCreate } = makeCtx(['user-1', 'user-2'], ['client-1']);
    const response = await post(ctx, { clientId: 'client-1', memberIds: ['user-2', 'user-1'] });

    expect(response.status).toBe(201);
    expect(projectCreate).toHaveBeenCalledTimes(1);
    const { data } = projectCreate.mock.calls[0]![0] as unknown as {
      data: { clientId: string; members: { create: { userId: string; role: string }[] } };
    };
    expect(data.clientId).toBe('client-1');
    expect(data.members.create).toEqual([
      { userId: 'user-1', role: 'LEAD' },
      { userId: 'user-2', role: 'MEMBER' },
    ]);
  });
});
