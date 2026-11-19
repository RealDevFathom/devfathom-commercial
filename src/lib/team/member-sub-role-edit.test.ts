// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PHARMACY_SUB_ROLES, type PharmacySubRoleState } from '@/lib/abac/pharmacy-sub-roles';
import {
  changedSubRoles,
  subRoleChangeRefusal,
  subRoleEditRefusal,
  type SubRoleChangeCheck,
} from './member-sub-role-edit';

const owner = { id: 'owner', status: 'ACTIVE', owner: true, admin: true };
const admin = { id: 'admin', status: 'ACTIVE', owner: false, admin: true };
const cashier = { id: 'cashier', role: 'EMPLOYEE', owner: false };

describe('DEV-959B: who may change whose ticks', () => {
  it('lets the owner change anyone but themselves', () => {
    expect(subRoleEditRefusal(owner, cashier, false)).toBeNull();
    expect(
      subRoleEditRefusal(owner, { id: 'admin', role: 'ADMIN', owner: false }, false)
    ).toBeNull();
    expect(subRoleEditRefusal(owner, { id: 'owner', role: 'ADMIN', owner: true }, false)).toMatch(
      /Nobody changes their own/
    );
  });

  it('limits an administrator to members below them', () => {
    expect(subRoleEditRefusal(admin, cashier, false)).toBeNull();
    expect(subRoleEditRefusal(admin, { id: 'owner', role: 'ADMIN', owner: true }, false)).toMatch(
      /Only the owner/
    );
    expect(subRoleEditRefusal(admin, { id: 'other', role: 'ADMIN', owner: false }, false)).toMatch(
      /Only the owner/
    );
    expect(subRoleEditRefusal(admin, { id: 'admin', role: 'ADMIN', owner: false }, false)).toMatch(
      /Nobody changes their own/
    );
    // A system Owner role on an employee is still an owner.
    expect(subRoleEditRefusal(admin, { id: 'o2', role: 'EMPLOYEE', owner: true }, false)).toMatch(
      /Only the owner/
    );
  });

  it('refuses everyone else, inactive editors and support sessions', () => {
    expect(
      subRoleEditRefusal({ id: 'x', status: 'ACTIVE', owner: false, admin: false }, cashier, false)
    ).toMatch(/Only the owner or an administrator/);
    expect(subRoleEditRefusal({ ...owner, status: 'INACTIVE' }, cashier, false)).toMatch(
      /Only the owner or an administrator/
    );
    expect(subRoleEditRefusal(owner, cashier, true)).toMatch(/support session/);
  });
});

function states(on: string[]): Map<string, PharmacySubRoleState> {
  return new Map(
    PHARMACY_SUB_ROLES.map((subRole) => [subRole.key, on.includes(subRole.key) ? 'on' : 'off'])
  );
}

const CASHIER = ['take-payment', 'customer-orders', 'do-procedures'];
function check(overrides: Partial<SubRoleChangeCheck>): SubRoleChangeCheck {
  return {
    actorOwner: true,
    actorHolds: new Set(PHARMACY_SUB_ROLES.map((subRole) => subRole.key)),
    before: states(CASHIER),
    after: states(CASHIER),
    targetOwnerBefore: false,
    targetOwnerAfter: false,
    ownersAfter: 1,
    pinVerified: false,
    mode: 'tick',
    ...overrides,
  };
}

describe('DEV-959B: the rules every change passes', () => {
  it('reports every sub-role a change moved', () => {
    expect(
      changedSubRoles(
        states(CASHIER),
        states([...CASHIER, 'dispense-prescriptions', 'record-prescriptions'])
      )
    ).toEqual(['dispense-prescriptions', 'record-prescriptions']);
  });

  it('allows a plain tick by someone who holds it', () => {
    expect(
      subRoleChangeRefusal(check({ after: states([...CASHIER, 'receive-stock']) }))
    ).toBeNull();
  });

  it('never lets anyone give what they cannot do, owner included', () => {
    const refusal = subRoleChangeRefusal(
      check({
        actorHolds: new Set(CASHIER),
        after: states([...CASHIER, 'receive-stock']),
      })
    );
    expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
    expect(refusal?.message).toMatch(/only give what you can do yourself/);
  });

  it('lets the owner take away anything, an administrator only what they hold', () => {
    const after = states(['customer-orders', 'do-procedures']);
    expect(subRoleChangeRefusal(check({ actorHolds: new Set(), after }))).toBeNull();
    expect(
      subRoleChangeRefusal(check({ actorOwner: false, actorHolds: new Set(), after }))
    ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('needs a fresh PIN for every weighty sub-role a change gives', () => {
    for (const key of [
      'give-discounts',
      'dispense-prescriptions',
      'record-prescriptions',
      'controlled-medicines',
      'review-catalogue',
      'run-branches',
      'close-the-day',
      'approve-purchase-orders',
    ]) {
      const after = states([...CASHIER, key]);
      expect(subRoleChangeRefusal(check({ after })), key).toMatchObject({ code: 'PIN_REQUIRED' });
      expect(subRoleChangeRefusal(check({ after, pinVerified: true })), key).toBeNull();
    }
    // Taking a weighty one away needs no PIN.
    expect(
      subRoleChangeRefusal(
        check({ before: states([...CASHIER, 'run-branches']), after: states(CASHIER) })
      )
    ).toBeNull();
  });

  it('never ends an owner’s owner access by unticking, and keeps one owner', () => {
    expect(
      subRoleChangeRefusal(check({ targetOwnerBefore: true, targetOwnerAfter: false }))
    ).toMatchObject({ code: 'OWNER_ACCESS' });
    expect(
      subRoleChangeRefusal(
        check({ targetOwnerBefore: true, targetOwnerAfter: false, mode: 'role' })
      )
    ).toBeNull();
    expect(
      subRoleChangeRefusal(
        check({ targetOwnerBefore: true, targetOwnerAfter: false, mode: 'role', ownersAfter: 0 })
      )
    ).toMatchObject({ code: 'LAST_OWNER' });
    expect(
      subRoleChangeRefusal(check({ actorOwner: false, targetOwnerAfter: true, mode: 'role' }))
    ).toMatchObject({ code: 'FORBIDDEN' });
  });
});
