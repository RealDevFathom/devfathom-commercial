import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({
  assertInOrganization: vi.fn(),
  create: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/org-refs', () => ({
  assertInOrganization: mocks.assertInOrganization,
}));

import type { AssistantHelpers } from '@/lib/ai/context';
import { buildProjectsTools } from './projects';

const db = {
  user: { findMany: vi.fn() },
  client: { findMany: vi.fn().mockResolvedValue([{ id: 'client_1', name: 'Acme' }]) },
  project: { create: mocks.create },
  board: { create: vi.fn() },
};

const helpers = {
  db,
  now: () => new Date(),
  isAdmin: false,
  ctx: { organizationId: 'org_1', userId: 'user_1' },
  resolveNamed: (_name: string, rows: Array<{ id: string; name: string }>) => ({
    kind: 'resolved',
    value: rows[0],
  }),
  activity: vi.fn(),
  audit: vi.fn(),
} as unknown as AssistantHelpers;

const input = {
  name: 'Website',
  type: 'CLIENT' as const,
  clientName: 'Acme',
  createDefaultBoard: false,
};

describe('assistant createProject organization references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.client.findMany.mockResolvedValue([{ id: 'client_1', name: 'Acme' }]);
    mocks.assertInOrganization.mockResolvedValue(undefined);
    mocks.create.mockResolvedValue({
      id: 'project_1',
      name: 'Website',
      type: 'CLIENT',
      status: 'ACTIVE',
    });
  });

  it('validates the creator and resolved client before creating', async () => {
    const execute = buildProjectsTools(helpers).createProject.execute as (
      value: typeof input
    ) => Promise<unknown>;
    await execute(input);

    expect(mocks.assertInOrganization).toHaveBeenNthCalledWith(1, db.user, 'org_1', ['user_1']);
    expect(mocks.assertInOrganization).toHaveBeenNthCalledWith(2, db.client, 'org_1', ['client_1']);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('does not create when the resolved client is outside the organization', async () => {
    mocks.assertInOrganization
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('foreign client'));
    const execute = buildProjectsTools(helpers).createProject.execute as (
      value: typeof input
    ) => Promise<unknown>;

    await expect(execute(input)).rejects.toThrow('foreign client');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns the tool error shape for a workspace-reference rejection', async () => {
    mocks.assertInOrganization
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new TRPCError({ code: 'BAD_REQUEST', message: 'That record is not in this workspace.' })
      );
    const execute = buildProjectsTools(helpers).createProject.execute as (
      value: typeof input
    ) => Promise<unknown>;

    await expect(execute(input)).resolves.toEqual({
      error: 'That record is not in this workspace.',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
