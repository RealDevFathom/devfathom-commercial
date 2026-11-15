import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-839 (F22): qualifying for a client through ONE shared project must not
// reveal that client's other projects (names, statuses or count) to the
// assistant. Admins keep the full view.

vi.mock('server-only', () => ({}));

import { buildClientsTools } from './clients';
import type { AssistantHelpers } from '@/lib/ai/context';

type Row = Record<string, unknown>;
type RelArgs = { where?: { members?: { some: { userId: string } } }; select?: Row } | true;

const projects = [
  { id: 'p-mine', name: 'Mine', status: 'ACTIVE', members: [{ userId: 'emp-1' }] },
  { id: 'p-private', name: 'Private Launch', status: 'ON_HOLD', members: [{ userId: 'emp-2' }] },
];

const visible = (args: RelArgs | undefined) => {
  const userId = args && args !== true ? args.where?.members?.some.userId : undefined;
  return userId ? projects.filter((p) => p.members.some((m) => m.userId === userId)) : projects;
};

function harness(actor: { userId: string; isAdmin: boolean }) {
  const findMany = vi.fn(async (args: { select?: Row }) => {
    const countArgs = (args.select?._count as { select?: { projects?: RelArgs } } | undefined)
      ?.select?.projects;
    return [
      {
        id: 'client-1',
        name: 'Acme',
        industry: null,
        location: null,
        status: 'ACTIVE',
        _count: { projects: visible(countArgs).length },
      },
    ];
  });
  const findUnique = vi.fn(async (args: { select: { projects: RelArgs } }) => ({
    name: 'Acme',
    industry: null,
    location: null,
    website: null,
    status: 'ACTIVE',
    notes: null,
    contacts: [],
    projects: visible(args.select.projects).map((p) => ({ name: p.name, status: p.status })),
    invoices: [],
  }));
  const helpers = {
    db: { client: { findMany, findUnique } },
    isAdmin: actor.isAdmin,
    ctx: { userId: actor.userId, name: actor.userId },
    resolveNamed: vi.fn((name: string, candidates: { id: string; name: string }[]) => {
      const value = candidates.find((c) => c.name === name);
      return value ? { kind: 'resolved', value } : { kind: 'notfound' };
    }),
    activity: vi.fn(),
    audit: vi.fn(),
  } as unknown as AssistantHelpers;
  const tools = buildClientsTools(helpers) as unknown as Record<
    string,
    { execute: (input: Record<string, unknown>) => Promise<Row> }
  >;
  return { tools, helpers, findMany, findUnique };
}

describe('assistant client tools — linked project visibility (DEV-839)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getClient shows a member only the projects they belong to', async () => {
    const { tools, helpers } = harness({ userId: 'emp-1', isAdmin: false });
    const result = await tools.getClient.execute({ name: 'Acme' });

    expect(result.projects).toEqual([{ name: 'Mine', status: 'ACTIVE' }]);
    expect(JSON.stringify(result)).not.toContain('Private Launch');
    expect(helpers.audit).not.toHaveBeenCalled();
    expect(helpers.activity).not.toHaveBeenCalled();
  });

  it('listClients counts only the member’s projects', async () => {
    const { tools } = harness({ userId: 'emp-1', isAdmin: false });
    const result = (await tools.listClients.execute({})) as unknown as Row[];
    expect(result[0].projects).toBe(1);
  });

  it('admins still see every linked project and the full count', async () => {
    const { tools } = harness({ userId: 'admin-1', isAdmin: true });
    const detail = await tools.getClient.execute({ name: 'Acme' });
    expect(detail.projects).toEqual([
      { name: 'Mine', status: 'ACTIVE' },
      { name: 'Private Launch', status: 'ON_HOLD' },
    ]);
    const list = (await tools.listClients.execute({})) as unknown as Row[];
    expect(list[0].projects).toBe(2);
  });
});
