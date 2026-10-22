import { describe, expect, it, vi } from 'vitest';

import { approveCount } from './inventory-operations';

describe('approveCount concurrency', () => {
  it('locks the tenant-and-branch count before reading approval state', async () => {
    const calls: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (_query: unknown) => {
        calls.push('lock');
        return [];
      }),
      pharmacyInventoryCount: {
        findFirst: vi.fn(async () => {
          calls.push('read');
          return { id: 'count_1', status: 'APPROVED', createdById: 'creator', lines: [] };
        }),
      },
    };

    await expect(
      approveCount(
        db as never,
        { organizationId: 'org_1', branchId: 'branch_1', actorId: 'actor_2' },
        'count_1',
        'different-prefix'
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });

    expect(calls).toEqual(['lock', 'read']);
    const query = db.$queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(query.strings.join('?')).toContain(
      'WHERE "id" = ? AND "organizationId" = ? AND "branchId" = ? FOR UPDATE'
    );
    expect(query.values).toEqual(['count_1', 'org_1', 'branch_1']);
  });
});
