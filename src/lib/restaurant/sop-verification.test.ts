/**
 * M7-L4 — SOP verification unit tests.
 * Covers: VERIFY/REJECT/WAIVE state transitions, co-authorization requirement for
 * waiver, state-guard errors (wrong status, not found).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  verifyOccurrence,
  rejectOccurrence,
  waiveOccurrence,
} from './sop-verification';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'new_id',
      createdAt: new Date(),
      ...data,
    })),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
  };
}

function makeDb() {
  const db: Record<string, unknown> = {
    restaurantSopOccurrence: model(),
    restaurantSopVerification: model(),
    restaurantCoAuthorization: model(),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;
const NOW = new Date('2026-08-20T10:00:00.000Z');
const OCC_ID = 'occ_1';
const ACTOR_ID = 'staff_actor';
const APPROVER_ID = 'staff_approver';

beforeEach(() => {
  db = makeDb();
});

// ── verifyOccurrence ───────────────────────────────────────────────────────────

describe('verifyOccurrence', () => {
  it('transitions SUBMITTED → VERIFIED and writes verification record', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    const result = await verifyOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      actorStaffProfileId: ACTOR_ID,
      now: NOW,
    });

    expect(result.action).toBe('VERIFY');
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VERIFIED' }) })
    );
    expect(db.restaurantSopVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'VERIFY' }) })
    );
  });

  it('transitions LATE → VERIFIED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'LATE' });

    const result = await verifyOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID });
    expect(result.action).toBe('VERIFY');
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VERIFIED' }) })
    );
  });

  it('throws NOT_FOUND when occurrence does not exist', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue(null);

    await expect(verifyOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });

  it('throws INVALID_STATE when occurrence is SCHEDULED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SCHEDULED' });

    await expect(verifyOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });
});

// ── rejectOccurrence ───────────────────────────────────────────────────────────

describe('rejectOccurrence', () => {
  it('transitions SUBMITTED → REJECTED for rework', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    const result = await rejectOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      actorStaffProfileId: ACTOR_ID,
      reason: 'Incomplete checklist',
    });

    expect(result.action).toBe('REJECT');
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) })
    );
  });

  it('throws INVALID_STATE when occurrence is already VERIFIED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'VERIFIED' });

    await expect(rejectOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });
});

// ── waiveOccurrence ────────────────────────────────────────────────────────────

describe('waiveOccurrence', () => {
  it('transitions MISSED → WAIVED with co-authorization', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'MISSED' });
    db.restaurantCoAuthorization.create.mockResolvedValue({ id: 'coauth_1' });

    const result = await waiveOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      actorStaffProfileId: ACTOR_ID,
      approvingStaffProfileId: APPROVER_ID,
      reason: 'Emergency exemption',
    });

    expect(result.action).toBe('WAIVE');
    expect(db.restaurantCoAuthorization.create).toHaveBeenCalled();
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'WAIVED' }) })
    );
    expect(db.restaurantSopVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'WAIVE', coAuthorizationId: 'coauth_1' }),
      })
    );
  });

  it('throws CO_AUTH_REQUIRED when actor and approver are the same', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    await expect(
      waiveOccurrence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        actorStaffProfileId: ACTOR_ID,
        approvingStaffProfileId: ACTOR_ID, // same → self-approval rejected
        reason: 'Test',
      })
    ).rejects.toMatchObject({ reason: 'CO_AUTH_REQUIRED' });
  });

  it('throws INVALID_STATE when occurrence is IN_PROGRESS (not waivable)', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });

    await expect(
      waiveOccurrence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        actorStaffProfileId: ACTOR_ID,
        approvingStaffProfileId: APPROVER_ID,
        reason: 'Test',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('waives LATE occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'LATE' });
    db.restaurantCoAuthorization.create.mockResolvedValue({ id: 'coauth_2' });

    const result = await waiveOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      actorStaffProfileId: ACTOR_ID,
      approvingStaffProfileId: APPROVER_ID,
      reason: 'Manager approved',
    });

    expect(result.action).toBe('WAIVE');
  });
});
