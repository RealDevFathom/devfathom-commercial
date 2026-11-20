// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PHARMACY_SUB_ROLES, type PharmacySubRoleState } from '@/lib/abac/pharmacy-sub-roles';
import { isWeightyPharmacySubRole } from '@/lib/abac/pharmacy-sub-role-weight';
import {
  accessChangeRefusal,
  accessEditRefusal,
  changedSubRoles,
  type AccessChangeCheck,
} from './pharmacy-access-guard';

const owner = { id: 'owner', status: 'ACTIVE', owner: true, admin: true };
const admin = { id: 'admin', status: 'ACTIVE', owner: false, admin: true };
const cashier = { id: 'cashier', owner: false, admin: false };

describe('DEV-959B: who may change whose access', () => {
  it('lets the owner change anyone but themselves', () => {
    expect(accessEditRefusal(owner, cashier, false)).toBeNull();
    expect(accessEditRefusal(owner, { id: 'admin', owner: false, admin: true }, false)).toBeNull();
    expect(accessEditRefusal(owner, { id: 'owner2', owner: true, admin: true }, false)).toBeNull();
    expect(accessEditRefusal(owner, { id: 'owner', owner: true, admin: true }, false)).toMatch(
      /Nobody changes their own/
    );
  });

  it('limits an administrator who is not the owner to people below them', () => {
    expect(accessEditRefusal(admin, cashier, false)).toBeNull();
    expect(accessEditRefusal(admin, null, false)).toBeNull();
    expect(accessEditRefusal(admin, { id: 'o', owner: true, admin: true }, false)).toMatch(
      /Only the owner/
    );
    // Administrator access held through a personal exception protects the person too.
    expect(accessEditRefusal(admin, { id: 'x', owner: false, admin: true }, false)).toMatch(
      /Only the owner/
    );
  });

  it('refuses support sessions, inactive editors and people who are not administrators', () => {
    expect(accessEditRefusal(owner, cashier, true)).toMatch(/support session/);
    expect(accessEditRefusal({ ...owner, status: 'INACTIVE' }, cashier, false)).toMatch(
      /Only the owner or an administrator/
    );
    expect(
      accessEditRefusal({ id: 'c', status: 'ACTIVE', owner: false, admin: false }, cashier, false)
    ).toMatch(/Only the owner or an administrator/);
  });
});

const states = (on: string[]): Map<string, PharmacySubRoleState> =>
  new Map(
    PHARMACY_SUB_ROLES.map((subRole) => [subRole.key, on.includes(subRole.key) ? 'on' : 'off'])
  );

function check(overrides: Partial<AccessChangeCheck>): AccessChangeCheck {
  return {
    editor: { kind: 'owner' },
    before: states(['take-payment']),
    after: states(['take-payment']),
    ownerBefore: false,
    ownerAfter: false,
    adminBefore: false,
    adminAfter: false,
    ownersBefore: 1,
    ownersAfter: 1,
    pinVerified: false,
    mode: 'tick',
    ...overrides,
  };
}

const administrator = (holds: string[]): AccessChangeCheck['editor'] => ({
  kind: 'administrator',
  holds: new Set(holds),
});

describe('DEV-959B: the rules every access change passes', () => {
  it('counts a sub-role as changed only when its decided state changes', () => {
    expect(changedSubRoles(states(['take-payment']), states(['take-payment']))).toEqual([]);
    expect(
      changedSubRoles(states(['take-payment']), states(['take-payment', 'receive-stock']))
    ).toEqual(['receive-stock']);
  });

  it('lets the owner give any sub-role, a weighty one with their own fresh approval', () => {
    for (const subRole of PHARMACY_SUB_ROLES) {
      const given = check({ after: states(['take-payment', subRole.key]) });
      if (subRole.key === 'take-payment') continue;
      if (isWeightyPharmacySubRole(subRole.key)) {
        expect(accessChangeRefusal(given)?.code).toBe('PIN_REQUIRED');
        expect(accessChangeRefusal({ ...given, pinVerified: true })).toBeNull();
      } else {
        expect(accessChangeRefusal(given)).toBeNull();
      }
    }
  });

  it('needs the owner’s approval to take a weighty sub-role away too', () => {
    const takeAway = check({
      before: states(['take-payment', 'dispense-prescriptions']),
      after: states(['take-payment']),
    });
    expect(accessChangeRefusal(takeAway)?.code).toBe('PIN_REQUIRED');
    expect(accessChangeRefusal({ ...takeAway, pinVerified: true })).toBeNull();
  });

  it('never lets an administrator who is not the owner change a weighty sub-role', () => {
    const holdsAll = administrator(PHARMACY_SUB_ROLES.map((subRole) => subRole.key));
    for (const key of [
      'dispense-prescriptions',
      'receive-stock',
      'manage-stock',
      'financial-reports',
    ]) {
      const give = check({
        editor: holdsAll,
        after: states(['take-payment', key]),
        pinVerified: true,
      });
      expect(accessChangeRefusal(give)).toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringMatching(/Only the owner can change .*extra weight/),
      });
      const takeAway = check({
        editor: holdsAll,
        before: states(['take-payment', key]),
        pinVerified: true,
      });
      expect(accessChangeRefusal(takeAway)?.code).toBe('FORBIDDEN');
    }
  });

  it('lets an administrator change only the non-weighty sub-roles they hold', () => {
    const editor = administrator(['take-payment', 'operational-reports']);
    expect(
      accessChangeRefusal(check({ editor, after: states(['take-payment', 'operational-reports']) }))
    ).toBeNull();
    expect(accessChangeRefusal(check({ editor, after: states([]) }))).toBeNull();
    expect(
      accessChangeRefusal(check({ editor, after: states(['take-payment', 'do-procedures']) }))
    ).toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/you cannot/) });
  });

  it('never lets an administrator make an administrator or an owner', () => {
    const editor = administrator(['take-payment']);
    expect(accessChangeRefusal(check({ editor, mode: 'role', adminAfter: true }))?.message).toMatch(
      /make someone an administrator/
    );
    expect(
      accessChangeRefusal(
        check({ editor, mode: 'role', adminAfter: true, ownerAfter: true, ownersAfter: 2 })
      )?.message
    ).toMatch(/make someone an owner/);
  });

  it('lets a path with no member behind it only take access away', () => {
    const system = { kind: 'system' } as const;
    expect(accessChangeRefusal(check({ editor: system, after: states([]) }))).toBeNull();
    expect(
      accessChangeRefusal(
        check({ editor: system, after: states(['take-payment', 'do-procedures']) })
      )
    ).toBeNull();
    expect(
      accessChangeRefusal(
        check({ editor: system, after: states(['take-payment', 'dispense-prescriptions']) })
      )?.code
    ).toBe('FORBIDDEN');
    expect(
      accessChangeRefusal(check({ editor: system, mode: 'role', adminAfter: true }))?.code
    ).toBe('FORBIDDEN');
  });

  it('keeps at least one active owner, whoever makes the change', () => {
    for (const editor of [{ kind: 'owner' } as const, { kind: 'system' } as const]) {
      expect(
        accessChangeRefusal(
          check({
            editor,
            mode: 'role',
            ownerBefore: true,
            adminBefore: true,
            ownersBefore: 1,
            ownersAfter: 0,
            pinVerified: true,
          })
        )?.code
      ).toBe('LAST_OWNER');
    }
    // A workspace with no owner yet is not blocked from changes that leave it the same.
    expect(accessChangeRefusal(check({ ownersBefore: 0, ownersAfter: 0 }))).toBeNull();
  });

  it('never ends an owner’s access by unticking one box', () => {
    expect(
      accessChangeRefusal(
        check({ ownerBefore: true, ownerAfter: false, ownersBefore: 2, ownersAfter: 1 })
      )?.code
    ).toBe('OWNER_ACCESS');
  });
});
