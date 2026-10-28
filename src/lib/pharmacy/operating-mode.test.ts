import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enforceOperatingMode, type PharmacyApprovalKind } from './operating-mode';
const mocks = vi.hoisted(() => ({ solo: vi.fn(), can: vi.fn() }));
vi.mock('./solo-approval', () => ({
  authorizeSoloApproval: mocks.solo,
  verifySoloOwnerPin: mocks.solo,
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can }));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
function fixture(mode: string, role = 'owner') {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: { findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: mode })) },
    user: { findFirst: vi.fn(async () => ({ organizationRole: { key: role } })) },
    auditLog: { create: vi.fn() },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.solo.mockImplementation(async (_db, _scope, _target, pin) => pin === '4729');
});
describe.each<PharmacyApprovalKind>([
  'RX',
  'OVERRIDE',
  'REFUND',
  'RETURN',
  'DISCOUNT',
  'ADJUSTMENT',
  'PURCHASE',
])('%s operating policy', (kind) => {
  const input = { kind, makerIds: ['actor'], targetType: 'Document', targetId: 'document' };
  it('allows SOLO owner only with fresh PIN through the #683 audited verifier', async () => {
    const db = fixture('SOLO');
    await expect(enforceOperatingMode(db as never, scope, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      enforceOperatingMode(db as never, scope, { ...input, pin: '4729' })
    ).resolves.toHaveProperty('policy', 'PHARMACY:SOLO_OWNER_PIN');
    expect(mocks.solo).toHaveBeenLastCalledWith(
      db,
      scope,
      { type: 'Document', id: 'document' },
      '4729'
    );
  });
  it('denies STAFFED self approval even with a PIN', async () => {
    const db = fixture('STAFFED', kind === 'RX' ? 'pharmacist' : 'owner');
    await expect(
      enforceOperatingMode(db as never, scope, { ...input, pin: '4729' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.solo).not.toHaveBeenCalled();
  });
  it('denies cashier and inappropriate role; accepts independent qualified checker with secret-free audit', async () => {
    if (kind === 'PURCHASE') mocks.can.mockResolvedValue(false);
    for (const role of ['cashier', kind === 'RX' ? 'owner' : 'pharmacist'])
      await expect(
        enforceOperatingMode(fixture('STAFFED', role) as never, scope, {
          ...input,
          makerIds: ['maker'],
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.can.mockResolvedValue(true);
    const db = fixture('STAFFED', kind === 'RX' ? 'pharmacist' : 'manager');
    await expect(
      enforceOperatingMode(db as never, scope, { ...input, makerIds: ['maker'] })
    ).resolves.toHaveProperty('actorId', 'actor');
    expect(db.auditLog.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('4729');
  });
});
it('fails closed when an Rx pharmacist has an explicit capability denial', async () => {
  mocks.can.mockResolvedValue(false);
  await expect(
    enforceOperatingMode(fixture('STAFFED', 'pharmacist') as never, scope, {
      kind: 'RX',
      makerIds: ['maker'],
      targetType: 'Rx',
      targetId: 'rx',
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('fails closed when approval evidence cannot be persisted', async () => {
  const db = fixture('STAFFED');
  db.auditLog.create.mockRejectedValue(new Error('audit unavailable') as never);
  await expect(
    enforceOperatingMode(db as never, scope, {
      kind: 'REFUND',
      makerIds: ['maker'],
      targetType: 'Sale',
      targetId: 'sale',
    })
  ).rejects.toThrow('audit unavailable');
});
