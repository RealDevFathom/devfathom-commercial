import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  persistMarketingGeneration,
  recordMarketingUsage,
  replayMarketingGeneration,
  reserveMarketingGeneration,
} from './marketing-ai-usage';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'UTC',
};
const complete = {
  id: '00000000-0000-4000-8000-000000000010',
  status: 'COMPLETE' as const,
  body: 'A paid draft',
  inputTokens: 11,
  outputTokens: 7,
  totalTokens: 18,
};

function sqlValues(call: unknown[]) {
  return (call[0] as { values: unknown[] }).values;
}

describe('pharmacy marketing AI accounting', () => {
  it('writes organization and branch into every generation and usage operation', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ ...complete, status: 'PENDING', body: null }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    } as unknown as ScopedDb;
    const reserved = await reserveMarketingGeneration(
      db,
      scope,
      '00000000-0000-4000-8000-000000000001'
    );
    await persistMarketingGeneration(db, scope, reserved.generation.id, {
      available: true,
      approved: false,
      body: complete.body,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });
    await recordMarketingUsage(db, scope, complete);
    for (const call of [
      vi.mocked(db.$queryRaw).mock.calls[0],
      ...vi.mocked(db.$executeRaw).mock.calls,
    ]) {
      expect(sqlValues(call)).toContain('org-a');
      expect(sqlValues(call)).toContain('branch-a');
    }
  });

  it('returns already-paid output even when its usage insert fails for later retry', async () => {
    const db = {
      $executeRaw: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as ScopedDb;
    await expect(recordMarketingUsage(db, scope, complete)).resolves.toBeUndefined();
    expect(replayMarketingGeneration(complete)).toEqual({
      available: true,
      body: 'A paid draft',
      approved: false,
    });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('reuses the tenant-and-branch idempotency reservation instead of claiming a second charge', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([complete]);
    const db = { $queryRaw: query } as unknown as ScopedDb;
    await expect(
      reserveMarketingGeneration(db, scope, '00000000-0000-4000-8000-000000000001')
    ).resolves.toEqual({ generation: complete, claimed: false });
    expect(query).toHaveBeenCalledTimes(2);
    expect(sqlValues(query.mock.calls[1])).toEqual(
      expect.arrayContaining(['org-a', 'branch-a', '00000000-0000-4000-8000-000000000001'])
    );
  });
});
