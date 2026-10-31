// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transactionFindUnique: vi.fn(),
  transactionUpdate: vi.fn(),
  projectFindFirst: vi.fn(),
  clientFindFirst: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (request: Request, context: unknown) =>
      handler(
        {
          organizationId: 'org-owned',
          db: {
            transaction: {
              findUnique: mocks.transactionFindUnique,
              update: mocks.transactionUpdate,
            },
            project: { findFirst: mocks.projectFindFirst },
            client: { findFirst: mocks.clientFindFirst },
          },
        } as never,
        request as never,
        context as never
      ),
}));

import { PATCH } from './route';

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request('https://example.test/api/v1/transactions/transaction-owned', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'transaction-owned' }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionFindUnique.mockResolvedValue({ id: 'transaction-owned' });
  mocks.transactionUpdate.mockResolvedValue({ id: 'transaction-owned' });
  mocks.projectFindFirst.mockResolvedValue({ id: 'project-owned' });
  mocks.clientFindFirst.mockResolvedValue({ id: 'client-owned' });
});

describe('PATCH /api/v1/transactions/:id organization references', () => {
  it.each([
    ['projectId', mocks.projectFindFirst],
    ['clientId', mocks.clientFindFirst],
  ] as const)('rejects a foreign %s without changing the transaction', async (field, lookup) => {
    lookup.mockResolvedValueOnce(null);

    const response = await patch({ [field]: `${field}-foreign` });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: `${field} does not exist.` });
    expect(lookup).toHaveBeenCalledWith({
      where: { id: `${field}-foreign`, organizationId: 'org-owned' },
      select: { id: true },
    });
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it('updates when both references belong to the token organization', async () => {
    const response = await patch({ projectId: 'project-owned', clientId: 'client-owned' });

    expect(response.status).toBe(200);
    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'transaction-owned' },
      data: { projectId: 'project-owned', clientId: 'client-owned' },
    });
  });

  it('keeps nullable references clearable without an ownership lookup', async () => {
    const response = await patch({ projectId: null, clientId: null });

    expect(response.status).toBe(200);
    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.clientFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'transaction-owned' },
      data: { projectId: null, clientId: null },
    });
  });
});
