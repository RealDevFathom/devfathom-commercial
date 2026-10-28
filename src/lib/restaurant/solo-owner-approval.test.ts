import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSoloOwnerCoAuthorization } from './co-authorization';
import { verifyOccurrence, waiveOccurrence } from './sop-verification';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), rate: vi.fn() }));
vi.mock('./terminal-auth', () => ({ authenticateOperator: mocks.authenticate }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rate }));

const request = {
  actingStaffProfileId: 'owner',
  approvingStaffProfileId: 'owner',
  capability: 'sop:verify',
  reason: 'Checked checklist',
  targetType: 'RestaurantSopOccurrence',
  targetId: 'occurrence',
};
function database({ colleagues = 0, tenantOwner = true, branchOwner = false } = {}) {
  const db = {
    restaurantStaffProfile: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: 'owner',
          status: 'ACTIVE',
          user: tenantOwner ? { role: 'ADMIN', status: 'ACTIVE' } : null,
          jobRoles: branchOwner ? [{ id: 'owner-role' }] : [],
        }),
      count: vi.fn().mockResolvedValue(colleagues),
    },
    restaurantSopOccurrence: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: 'occurrence',
          status: 'SUBMITTED',
          branchId: 'branch',
          assignedStaffProfileId: 'owner',
          steps: [],
          evidence: [],
        }),
      update: vi.fn(),
    },
    restaurantCoAuthorization: { create: vi.fn().mockResolvedValue({ id: 'approval' }) },
    restaurantSopVerification: {
      create: vi.fn().mockResolvedValue({ id: 'verification', createdAt: new Date() }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (work) => work(db));
  return db;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.authenticate.mockResolvedValue({ ok: true, staffProfileId: 'owner' });
});

describe('solo owner approval requires live PIN reauthentication and audit', () => {
  it.each([{ tenantOwner: true }, { tenantOwner: false, branchOwner: true }])(
    'allows a solo owner: %j',
    async (options) => {
      const db = database(options);
      const record = await buildSoloOwnerCoAuthorization(db as never, request, 'branch', '4821');
      expect(record).toMatchObject({
        actingStaffProfileId: 'owner',
        approvingStaffProfileId: 'owner',
        reason: '[SOLO_OWNER_PIN_REAUTH] Checked checklist',
      });
      expect(mocks.authenticate).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ staffProfileId: 'owner', type: 'PIN', secret: '4821' })
      );
      expect(JSON.stringify(record)).not.toContain('4821');
    }
  );
  it('denies missing, incorrect and locked PINs', async () => {
    const db = database();
    await expect(
      buildSoloOwnerCoAuthorization(db as never, request, 'branch', undefined)
    ).rejects.toThrow('PIN');
    for (const reason of ['INVALID', 'LOCKED']) {
      mocks.authenticate.mockResolvedValue({ ok: false, reason });
      await expect(
        buildSoloOwnerCoAuthorization(db as never, request, 'branch', 'wrong')
      ).rejects.toThrow('PIN');
    }
  });
  it('requires a second approver in a multi-staff branch even for an owner with a correct PIN', async () => {
    const db = database({ colleagues: 1 });
    await expect(
      buildSoloOwnerCoAuthorization(db as never, request, 'branch', '4821')
    ).rejects.toThrow('second staff');
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
  it('does not treat a solo non-owner as an owner', async () => {
    await expect(
      buildSoloOwnerCoAuthorization(
        database({ tenantOwner: false }) as never,
        request,
        'branch',
        '4821'
      )
    ).rejects.toThrow('Only a solo');
  });
  it('persists PIN reauthentication evidence linked to verification', async () => {
    const db = database();
    await verifyOccurrence(db as never, {
      occurrenceId: 'occurrence',
      actorStaffProfileId: 'owner',
      approvalPin: '4821',
    });
    expect(db.restaurantCoAuthorization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: expect.stringContaining('[SOLO_OWNER_PIN_REAUTH]'),
        }),
      })
    );
    expect(db.restaurantSopVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          coAuthorizationId: 'approval',
          actorStaffProfileId: 'owner',
        }),
      })
    );
  });
  it('rejects self-verification without a PIN and writes no approval or decision', async () => {
    const db = database();
    await expect(
      verifyOccurrence(db as never, { occurrenceId: 'occurrence', actorStaffProfileId: 'owner' })
    ).rejects.toMatchObject({ reason: 'CO_AUTH_REQUIRED' });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
  });
  it('requires another verifier in a multi-staff branch and allows that distinct verifier', async () => {
    const db = database({ colleagues: 1 });
    await expect(
      verifyOccurrence(db as never, {
        occurrenceId: 'occurrence',
        actorStaffProfileId: 'owner',
        approvalPin: '4821',
      })
    ).rejects.toMatchObject({ reason: 'CO_AUTH_REQUIRED' });
    await expect(
      verifyOccurrence(db as never, { occurrenceId: 'occurrence', actorStaffProfileId: 'verifier' })
    ).resolves.toMatchObject({ action: 'VERIFY' });
  });
  it('supports a PIN-audited solo owner waiver', async () => {
    const db = database();
    await expect(
      waiveOccurrence(db as never, {
        occurrenceId: 'occurrence',
        actorStaffProfileId: 'owner',
        approvingStaffProfileId: 'owner',
        reason: 'Emergency',
        approvalPin: '4821',
      })
    ).resolves.toMatchObject({ action: 'WAIVE' });
    expect(db.restaurantSopVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ coAuthorizationId: 'approval' }) })
    );
  });
});
