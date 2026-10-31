/**
 * M7-L4 — SOP verification unit tests.
 * Covers: VERIFY/REJECT/WAIVE state transitions, co-authorization requirement for
 * waiver, state-guard errors (wrong status, not found).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const approval = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capable: vi.fn(),
  independent: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: approval.independent }));
vi.mock('./terminal-auth', () => ({ authenticateOperator: approval.authenticate }));
vi.mock('./checkout-routes', () => ({ operatorHasCapability: approval.capable }));

import { verifyOccurrence, rejectOccurrence, waiveOccurrence } from './sop-verification';
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
    restaurantStaffProfile: model(),
    auditLog: model(),
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
  vi.clearAllMocks();
  approval.independent.mockImplementation(async (_org, run) =>
    run({ ...db, $queryRawUnsafe: vi.fn() })
  );
  approval.authenticate.mockResolvedValue({ ok: true, staffProfileId: APPROVER_ID });
  approval.capable.mockResolvedValue(true);
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

    await expect(
      verifyOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });

  it('throws INVALID_STATE when occurrence is SCHEDULED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SCHEDULED' });

    await expect(
      verifyOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
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

    await expect(
      rejectOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
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
      approvingPin: '1234',
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
        approvingPin: '1234',
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
        approvingPin: '1234',
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
      approvingPin: '1234',
      reason: 'Manager approved',
    });

    expect(result.action).toBe('WAIVE');
  });
});

describe('waiver credential and solo-owner boundary', () => {
  const input = {
    occurrenceId: OCC_ID,
    actorStaffProfileId: ACTOR_ID,
    approvingStaffProfileId: ACTOR_ID,
    approvingPin: '4821',
    reason: 'Emergency',
  };
  beforeEach(() => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'MISSED',
      branchId: 'branch_b',
      organizationId: 'org_1',
    });
    db.restaurantStaffProfile = { ...model(), count: vi.fn().mockResolvedValue(0) };
    db.restaurantStaffProfile.findUnique.mockResolvedValue({
      id: ACTOR_ID,
      organizationId: 'org_1',
      status: 'ACTIVE',
      jobRoles: [],
      user: { status: 'ACTIVE', organizationRole: { key: 'owner', isSystem: true } },
    });
  });
  it('permits only the sole active owner after PIN verification and records both identities', async () => {
    await waiveOccurrence(db as unknown as ScopedDb, input);
    expect(approval.authenticate).toHaveBeenCalledWith(
      expect.objectContaining(db),
      expect.objectContaining({ staffProfileId: ACTOR_ID, type: 'PIN', secret: '4821' })
    );
    expect(approval.capable).toHaveBeenCalledWith(
      db,
      ACTOR_ID,
      'coauth:approve',
      expect.any(Date),
      'branch_b'
    );
    expect(approval.independent).toHaveBeenCalledWith('org_1', expect.any(Function), {
      skipDrain: true,
      maxWait: 2_000,
      timeout: 5_000,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'sop.waive.soloOwnerApproval',
        source: 'TRPC',
        actorStaffProfileId: ACTOR_ID,
        targetId: OCC_ID,
        metadata: expect.objectContaining({ coAuthorizationId: 'new_id' }),
      }),
    });
    expect(db.restaurantStaffProfile.count).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', id: { not: ACTOR_ID } },
    });
    expect(db.restaurantCoAuthorization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actingStaffProfileId: ACTOR_ID,
        approvingStaffProfileId: ACTOR_ID,
        reason: '[SOLO_OWNER_PIN_REAUTH] Emergency',
        targetId: OCC_ID,
      }),
      select: { id: true },
    });
    expect(db.restaurantSopVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'WAIVE', coAuthorizationId: 'new_id' }),
      })
    );
  });
  it('requires a second approver when another active staff member exists', async () => {
    db.restaurantStaffProfile.count.mockResolvedValue(1);
    await expect(waiveOccurrence(db as unknown as ScopedDb, input)).rejects.toMatchObject({
      reason: 'CO_AUTH_REQUIRED',
    });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
  it('denies solo staff who are not owners', async () => {
    db.restaurantStaffProfile.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      id: ACTOR_ID,
      jobRoles: [],
      user: { status: 'ACTIVE', organizationRole: { key: 'manager', isSystem: true } },
    });
    await expect(waiveOccurrence(db as unknown as ScopedDb, input)).rejects.toMatchObject({
      reason: 'CO_AUTH_REQUIRED',
    });
  });
  it.each([
    { role: 'ADMIN', organizationRole: { key: 'cashier', isSystem: true } },
    { role: 'EMPLOYEE', organizationRole: { key: 'owner', isSystem: false } },
    { role: 'EMPLOYEE', organizationRole: { key: 'owner-operator', isSystem: false } },
  ])('denies solo self-approval to mutable owner-like identity %j', async (identity) => {
    db.restaurantStaffProfile.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      id: ACTOR_ID,
      organizationId: 'org_1',
      jobRoles: [],
      user: { status: 'ACTIVE', ...identity },
    });
    await expect(waiveOccurrence(db as unknown as ScopedDb, input)).rejects.toMatchObject({
      reason: 'CO_AUTH_REQUIRED',
    });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
  it.each(['INVALID', 'LOCKED'])('denies a %s PIN without writing a waiver', async (reason) => {
    approval.authenticate.mockResolvedValueOnce({ ok: false, reason });
    await expect(waiveOccurrence(db as unknown as ScopedDb, input)).rejects.toMatchObject({
      reason: 'CO_AUTH_REQUIRED',
    });
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  it('rejects an approver ID alone', async () => {
    await expect(
      waiveOccurrence(db as unknown as ScopedDb, { ...input, approvingPin: undefined })
    ).rejects.toMatchObject({ reason: 'CO_AUTH_REQUIRED' });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
  it('denies an approver lacking capability in the occurrence branch', async () => {
    approval.capable.mockResolvedValueOnce(false);
    await expect(waiveOccurrence(db as unknown as ScopedDb, input)).rejects.toMatchObject({
      reason: 'CO_AUTH_REQUIRED',
    });
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
  });
});
