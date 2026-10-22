// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (...args: never[]) =>
      handler(...args),
}));

import { PATCH } from './route';

const transaction = {
  findUnique: vi.fn(),
  update: vi.fn(),
};
const project = { findUnique: vi.fn() };
const client = { findUnique: vi.fn() };
const authCtx = { db: { transaction, project, client } };

const patch = (body: unknown) =>
  PATCH(
    authCtx as never,
    new Request('https://example.test/api/v1/transactions/transaction-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'transaction-1' }) }
  );

describe('PATCH /api/v1/transactions/[id] organization references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.findUnique.mockResolvedValue({ id: 'transaction-1' });
    transaction.update.mockResolvedValue({ id: 'transaction-1' });
    project.findUnique.mockResolvedValue({ id: 'project-1' });
    client.findUnique.mockResolvedValue({ id: 'client-1' });
  });

  it('rejects a project outside the authenticated organization without updating', async () => {
    project.findUnique.mockResolvedValue(null);

    const response = await patch({ projectId: 'foreign-project' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'projectId does not exist.' });
    expect(project.findUnique).toHaveBeenCalledWith({
      where: { id: 'foreign-project' },
      select: { id: true },
    });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('rejects a client outside the authenticated organization without updating', async () => {
    client.findUnique.mockResolvedValue(null);

    const response = await patch({ clientId: 'foreign-client' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'clientId does not exist.' });
    expect(client.findUnique).toHaveBeenCalledWith({
      where: { id: 'foreign-client' },
      select: { id: true },
    });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it.each(['projectId', 'clientId'] as const)(
    'rejects an empty %s before checking references or updating',
    async (field) => {
      const response = await patch({ [field]: '' });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'Invalid input' });
      expect(project.findUnique).not.toHaveBeenCalled();
      expect(client.findUnique).not.toHaveBeenCalled();
      expect(transaction.update).not.toHaveBeenCalled();
    }
  );

  it('preserves null as an explicit detach without looking up references', async () => {
    const response = await patch({ projectId: null, clientId: null });

    expect(response.status).toBe(200);
    expect(project.findUnique).not.toHaveBeenCalled();
    expect(client.findUnique).not.toHaveBeenCalled();
    expect(transaction.update).toHaveBeenCalledWith({
      where: { id: 'transaction-1' },
      data: { projectId: null, clientId: null },
    });
  });

  it('updates only after supplied references are visible in the tenant-scoped database', async () => {
    const response = await patch({ projectId: 'project-1', clientId: 'client-1' });

    expect(response.status).toBe(200);
    expect(project.findUnique).toHaveBeenCalledOnce();
    expect(client.findUnique).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenCalledWith({
      where: { id: 'transaction-1' },
      data: { projectId: 'project-1', clientId: 'client-1' },
    });
  });
});
