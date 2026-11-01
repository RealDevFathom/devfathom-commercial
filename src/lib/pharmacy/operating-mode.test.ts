import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enforceOperatingMode,
  STAFFED_SELF_APPROVAL_MESSAGE,
  type PharmacyApprovalKind,
} from './operating-mode';
const mocks = vi.hoisted(() => ({ solo: vi.fn(), can: vi.fn(), branch: vi.fn(), pin: vi.fn() }));
vi.mock('./solo-approval', () => ({
  authorizeSoloApproval: mocks.solo,
  verifyPharmacyUserPin: mocks.pin,
}));
vi.mock('./procurement-access', () => ({
  actorCanProcure: (...args: unknown[]) => mocks.can(...args),
}));
vi.mock('./branch-assignment', () => ({ assertBranchAssignment: mocks.branch }));
vi.mock('@/lib/abac', () => ({ can: mocks.can }));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
function fixture(mode: string, role = 'owner', isSystem = true) {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: { findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: mode })) },
    user: { findFirst: vi.fn(async () => ({ organizationRole: { key: role, isSystem } })) },
    auditLog: { create: vi.fn() },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.pin.mockImplementation(async (_scope, pin) => pin === '4729');
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
  it.skipIf(kind === 'RX')('denies STAFFED self approval even with a PIN', async () => {
    const db = fixture('STAFFED', 'owner');
    await expect(
      enforceOperatingMode(db as never, scope, { ...input, pin: '4729' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.solo).not.toHaveBeenCalled();
  });
  it('honors a SOLO capability denial before PIN verification or approval evidence', async () => {
    mocks.can.mockResolvedValue(false);
    const db = fixture('SOLO');
    await expect(
      enforceOperatingMode(db as never, scope, { ...input, pin: '4729' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.solo).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  it('denies cashier and inappropriate role; accepts independent qualified checker with secret-free audit', async () => {
    // Rx and purchasing eligibility come from the persisted grant, not the role key.
    if (kind === 'PURCHASE' || kind === 'RX') mocks.can.mockResolvedValue(false);
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
it('lets a dispense holder approve their own STAFFED Rx line, as before operating modes', async () => {
  const db = fixture('STAFFED', 'pharmacist');
  await expect(
    enforceOperatingMode(db as never, scope, {
      kind: 'RX',
      makerIds: ['actor'],
      targetType: 'PrescriptionSale',
      targetId: 'sale',
    })
  ).resolves.toEqual({ actorId: 'actor', policy: 'PHARMACY:STAFFED:RX' });
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(mocks.solo).not.toHaveBeenCalled();
  expect(db.auditLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      actorId: 'actor',
      action: 'PHARMACY:STAFFED:RX',
      metadata: expect.objectContaining({ makerIds: ['actor'], selfDispense: true }),
    }),
  });
});
it.each(['owner', 'cashier'])(
  'refuses own STAFFED Rx approval by a %s without pharmacy:dispense',
  async (role) => {
    mocks.can.mockResolvedValue(false);
    const db = fixture('STAFFED', role);
    await expect(
      enforceOperatingMode(db as never, scope, {
        kind: 'RX',
        makerIds: ['actor'],
        targetType: 'PrescriptionSale',
        targetId: 'sale',
        pin: '4729',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  }
);
it('accepts a custom-role dispense holder as an independent Rx checker', async () => {
  const db = fixture('STAFFED', 'dispensary-lead');
  await expect(
    enforceOperatingMode(db as never, scope, {
      kind: 'RX',
      makerIds: ['maker'],
      targetType: 'PrescriptionSale',
      targetId: 'sale',
    })
  ).resolves.toHaveProperty('actorId', 'actor');
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
it('fails closed when an owner or manager has an explicit capability denial', async () => {
  mocks.can.mockResolvedValue(false);
  await expect(
    enforceOperatingMode(fixture('STAFFED', 'manager') as never, scope, {
      kind: 'ADJUSTMENT',
      makerIds: ['maker'],
      targetType: 'WriteOff',
      targetId: 'write-off',
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(mocks.can).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'actor' }),
    'pharmacy:inventory',
    undefined,
    expect.objectContaining({ db: expect.anything() })
  );
});

it('allows an organization-wide approval without inventing a branch', async () => {
  await expect(
    enforceOperatingMode(
      fixture('STAFFED', 'manager') as never,
      { ...scope, branchId: null },
      {
        kind: 'OVERRIDE',
        makerIds: ['maker'],
        targetType: 'PharmacyPackPrice',
        targetId: 'pack',
      }
    )
  ).resolves.toHaveProperty('policy', 'PHARMACY:STAFFED:OVERRIDE');
  expect(mocks.branch).not.toHaveBeenCalled();
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


it('does not serialize STAFFED counters on the organization row before the delegated PIN verifier', async () => {
  const db = fixture('STAFFED', 'pharmacist');
  const steps: string[] = [];
  db.$queryRaw.mockImplementation(async () => { steps.push('organization'); return []; });
  mocks.pin.mockImplementation(async () => { steps.push('credential'); return true; });
  await enforceOperatingMode(db as never, scope, {
    kind: 'RX', makerIds: ['actor'], checkerId: 'checker', pin: '4729',
    targetType: 'PrescriptionSale', targetId: 'sale',
  });
  expect(steps).toEqual(['credential']);
});
it('holds the organization row for SOLO approval and rereads the mode under it', async () => {
  const db = fixture('SOLO');
  const steps: string[] = [];
  db.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) => {
    steps.push(sql.join('?').includes('pharmacy_lock_solo_roster') ? 'roster' : 'organization');
    return [];
  }) as never);
  db.organization.findFirstOrThrow.mockImplementation(async () => {
    steps.push('mode');
    return { pharmacyOperatingMode: 'SOLO' };
  });
  mocks.solo.mockImplementation(async () => { steps.push('solo'); return true; });
  await enforceOperatingMode(db as never, scope, {
    kind: 'DISCOUNT', makerIds: ['actor'], pin: '4729', targetType: 'PharmacySale', targetId: 'sale',
  });
  expect(steps).toEqual(['mode', 'organization', 'roster', 'mode', 'solo']);
});
it('falls back to independent STAFFED approval when SOLO ends before the row lock', async () => {
  const db = fixture('SOLO');
  db.organization.findFirstOrThrow
    .mockResolvedValueOnce({ pharmacyOperatingMode: 'SOLO' })
    .mockResolvedValueOnce({ pharmacyOperatingMode: 'STAFFED' });
  await expect(
    enforceOperatingMode(db as never, scope, {
      kind: 'DISCOUNT', makerIds: ['actor'], pin: '4729', targetType: 'PharmacySale', targetId: 'sale',
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(mocks.solo).not.toHaveBeenCalled();
});

it('records the SOLO mode when a SOLO pharmacy uses an independent checker', async () => {
  const db = fixture('SOLO', 'manager');
  await expect(
    enforceOperatingMode(db as never, scope, {
      kind: 'REFUND',
      makerIds: ['maker'],
      targetType: 'PharmacyTender',
      targetId: 'tender',
    })
  ).resolves.toEqual({ actorId: 'actor', policy: 'PHARMACY:SOLO_INDEPENDENT_CHECKER:REFUND' });
  expect(mocks.solo).not.toHaveBeenCalled();
  expect(db.auditLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: 'PHARMACY:SOLO_INDEPENDENT_CHECKER:REFUND',
      metadata: expect.objectContaining({ operatingMode: 'SOLO' }),
    }),
  });
});
it('keeps the STAFFED label for STAFFED independent approvals', async () => {
  const db = fixture('STAFFED', 'manager');
  await enforceOperatingMode(db as never, scope, {
    kind: 'RETURN',
    makerIds: ['maker'],
    targetType: 'PharmacySaleLine',
    targetId: 'line',
  });
  expect(db.auditLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: 'PHARMACY:STAFFED:RETURN',
      metadata: expect.objectContaining({ operatingMode: 'STAFFED' }),
    }),
  });
});
it.each(['owner', 'manager'])(
  'rejects a tenant-authored %s lookalike role as a non-clinical checker',
  async (role) => {
    const db = fixture('STAFFED', role, false);
    await expect(
      enforceOperatingMode(db as never, scope, {
        kind: 'OVERRIDE',
        makerIds: ['maker'],
        targetType: 'PharmacySaleLine',
        targetId: 'line',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  }
);
it('accepts the scoped system owner-operator role with the action capability', async () => {
  const db = fixture('STAFFED', 'owner-operator');
  await expect(
    enforceOperatingMode(db as never, scope, {
      kind: 'ADJUSTMENT',
      makerIds: ['maker'],
      targetType: 'WriteOff',
      targetId: 'write-off',
    })
  ).resolves.toHaveProperty('policy', 'PHARMACY:STAFFED:ADJUSTMENT');
  expect(mocks.can).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'actor' }),
    'pharmacy:inventory',
    undefined,
    expect.anything()
  );
});
it('points a STAFFED sole owner at the SOLO switch when self-approval is refused', async () => {
  await expect(
    enforceOperatingMode(fixture('STAFFED', 'owner') as never, scope, {
      kind: 'REFUND',
      makerIds: ['actor'],
      targetType: 'PharmacyTender',
      targetId: 'tender',
      pin: '4729',
    })
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: STAFFED_SELF_APPROVAL_MESSAGE,
  });
});
