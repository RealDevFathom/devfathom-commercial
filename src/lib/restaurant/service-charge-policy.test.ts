import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  endServiceChargePolicy,
  publishServiceChargePolicy,
  ServiceChargePolicyError,
} from './service-charge-policy';

const start = new Date('2026-09-01T00:00:00.000Z');
const end = new Date('2026-10-01T00:00:00.000Z');

function transactionDb(overrides: Record<string, unknown>) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    restaurantBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
    restaurantServiceChargePolicyVersion: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      ...overrides,
    },
  };
  return {
    tx,
    db: {
      $transaction: (work: (inner: typeof tx) => Promise<unknown>) => work(tx),
    } as unknown as ScopedDb,
  };
}

describe('service-charge policy lifecycle', () => {
  it('replays publish only when the canonical payload hash matches', async () => {
    const created = {
      id: 'policy-1',
      payloadHash: '',
      rate: new Prisma.Decimal('0.1'),
      effectiveFrom: start,
    };
    const { db, tx } = transactionDb({
      create: vi.fn().mockImplementation(({ data }) => {
        Object.assign(created, data);
        return created;
      }),
    });
    const input = {
      organizationId: 'org-1',
      branchId: 'branch-1',
      rate: '0.1',
      effectiveFrom: start,
      acknowledgementRef: 'accountant-approved',
      acknowledged: true as const,
      idempotencyKey: 'publish-key',
    };

    await expect(publishServiceChargePolicy(db, input)).resolves.toBe(created);
    vi.mocked(tx.restaurantServiceChargePolicyVersion.findUnique).mockResolvedValueOnce(
      created as never
    );
    await expect(publishServiceChargePolicy(db, input)).resolves.toBe(created);
    vi.mocked(tx.restaurantServiceChargePolicyVersion.findUnique).mockResolvedValueOnce(
      created as never
    );
    await expect(publishServiceChargePolicy(db, { ...input, rate: '0.2' })).rejects.toMatchObject({
      reason: 'CONFLICT',
    } satisfies Partial<ServiceChargePolicyError>);
    expect(tx.restaurantServiceChargePolicyVersion.create).toHaveBeenCalledTimes(1);
  });

  it('ends once, replays the exact v1 payload, and conflicts on changed date or policy', async () => {
    const current = { id: 'policy-1', effectiveFrom: start, effectiveTo: null };
    let ended: Record<string, unknown> | null = null;
    const { db, tx } = transactionDb({
      findUnique: vi.fn().mockImplementation(() => ended),
      findFirst: vi.fn().mockResolvedValue(current),
      update: vi.fn().mockImplementation(({ data }) => {
        ended = { ...current, ...data };
        return ended;
      }),
    });
    const input = {
      organizationId: 'org-1',
      branchId: 'branch-1',
      policyVersionId: 'policy-1',
      effectiveTo: end,
      idempotencyKey: 'end-key-1',
    };

    const first = await endServiceChargePolicy(db, input);
    await expect(endServiceChargePolicy(db, input)).resolves.toBe(first);
    await expect(
      endServiceChargePolicy(db, {
        ...input,
        effectiveTo: new Date('2026-11-01T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ reason: 'CONFLICT' } satisfies Partial<ServiceChargePolicyError>);
    await expect(
      endServiceChargePolicy(db, { ...input, policyVersionId: 'policy-2' })
    ).rejects.toMatchObject({ reason: 'CONFLICT' } satisfies Partial<ServiceChargePolicyError>);
    expect(tx.restaurantServiceChargePolicyVersion.update).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      id: 'policy-1',
      effectiveTo: end,
      endIdempotencyKey: 'end-key-1',
      endPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
