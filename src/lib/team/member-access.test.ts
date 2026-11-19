// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { readPharmacyMemberAccess } from './member-access';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

function template(key: string): Rule[] {
  const found = PHARMACY_ROLE_TEMPLATES.find((candidate) => candidate.key === key)!;
  return found.capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));
}

function fakeDb(member: {
  role: 'ADMIN' | 'EMPLOYEE';
  organizationRole: { name: string; isSystem: boolean; permissions: Rule[] } | null;
  overrides?: Rule[];
}) {
  const overrides = member.overrides ?? [];
  const findFirst = vi.fn(async (args: { where: { id: string; organizationId: string } }) =>
    args.where.id === 'u_1' && args.where.organizationId === 'org_1'
      ? {
          id: 'u_1',
          name: 'Ayesha',
          role: member.role,
          department: 'COUNTER',
          status: 'ACTIVE',
          organizationRole: member.organizationRole
            ? { name: member.organizationRole.name, isSystem: member.organizationRole.isSystem }
            : null,
          permissionOverrides: overrides.map((_, index) => ({ id: `o_${index}` })),
        }
      : null
  );
  // The ABAC engine's own lookup of the person's rules.
  const findUnique = vi.fn(async () => ({
    organizationRole: member.organizationRole
      ? { permissions: member.organizationRole.permissions }
      : null,
    permissionOverrides: overrides,
  }));
  const update = vi.fn();
  return {
    db: { user: { findFirst, findUnique, update } } as unknown as Parameters<
      typeof readPharmacyMemberAccess
    >[0],
    findFirst,
    findUnique,
    update,
  };
}

function ticked(result: Awaited<ReturnType<typeof readPharmacyMemberAccess>>) {
  return result.groups
    .flatMap((group) => group.subRoles)
    .filter((subRole) => subRole.state === 'on')
    .map((subRole) => subRole.key)
    .sort();
}

describe('what this person can do', () => {
  it('ticks the Cashier sub-roles and shows every other sub-role unticked', async () => {
    const { db, update } = fakeDb({
      role: 'EMPLOYEE',
      organizationRole: { name: 'Cashier', isSystem: true, permissions: template('cashier') },
    });
    const result = await readPharmacyMemberAccess(db, 'org_1', 'u_1');
    expect(ticked(result)).toEqual(['customer-orders', 'do-procedures', 'take-payment']);
    const all = result.groups.flatMap((group) => group.subRoles);
    expect(all.filter((subRole) => subRole.state === 'off').length).toBe(all.length - 3);
    expect(result.member).toEqual({
      id: 'u_1',
      name: 'Ayesha',
      status: 'ACTIVE',
      roleName: 'Cashier',
      customRole: false,
      exceptionCount: 0,
      administrator: null,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('applies per-person exceptions on top of the role, deny winning', async () => {
    const { db } = fakeDb({
      role: 'EMPLOYEE',
      organizationRole: { name: 'Cashier', isSystem: true, permissions: template('cashier') },
      overrides: [
        { capability: 'pharmacy:discount', effect: 'ALLOW' },
        { capability: 'pharmacy:orders', effect: 'DENY' },
      ],
    });
    const result = await readPharmacyMemberAccess(db, 'org_1', 'u_1');
    expect(ticked(result)).toEqual(['do-procedures', 'give-discounts', 'take-payment']);
    expect(result.member.exceptionCount).toBe(2);
  });

  it('reads a custom role the way the engine enforces it', async () => {
    const { db } = fakeDb({
      role: 'EMPLOYEE',
      organizationRole: {
        name: 'Night pharmacist',
        isSystem: false,
        permissions: [
          { capability: 'pharmacy:dispense', effect: 'ALLOW' },
          { capability: 'pharmacy:*', effect: 'ALLOW' },
          { capability: 'pharmacy:close', effect: 'DENY' },
        ],
      },
    });
    const result = await readPharmacyMemberAccess(db, 'org_1', 'u_1');
    const keys = ticked(result);
    // Dispensing includes prescription capture; the wildcard never reaches discounts.
    expect(keys).toContain('dispense-prescriptions');
    expect(keys).toContain('record-prescriptions');
    expect(keys).toContain('take-payment');
    expect(keys).not.toContain('close-the-day');
    expect(keys).not.toContain('give-discounts');
    expect(keys).not.toContain('review-catalogue');
    expect(result.member.customRole).toBe(true);
  });

  it('includes the tenant-administrator fallbacks the server applies without a role', async () => {
    const { db } = fakeDb({ role: 'ADMIN', organizationRole: null });
    const result = await readPharmacyMemberAccess(db, 'org_1', 'u_1');
    expect(ticked(result)).toEqual(
      [
        'approve-purchase-orders',
        'receive-stock',
        'record-prescriptions',
        'suggest-catalogue-edits',
      ].sort()
    );
    expect(result.member.roleName).toBeNull();
    expect(result.member.administrator).toBe('full');
  });

  it('decides administrator access with the engine, not the role name alone', async () => {
    const custom = fakeDb({
      role: 'EMPLOYEE',
      organizationRole: {
        name: 'Office',
        isSystem: false,
        permissions: [{ capability: 'admin:access', effect: 'ALLOW' }],
      },
    });
    expect((await readPharmacyMemberAccess(custom.db, 'org_1', 'u_1')).member.administrator).toBe(
      'access-only'
    );
    const denied = fakeDb({
      role: 'ADMIN',
      organizationRole: null,
      overrides: [{ capability: 'admin:access', effect: 'DENY' }],
    });
    expect((await readPharmacyMemberAccess(denied.db, 'org_1', 'u_1')).member.administrator).toBe(
      'role-only'
    );
  });

  it('refuses a person outside the organization', async () => {
    const { db, findUnique } = fakeDb({ role: 'EMPLOYEE', organizationRole: null });
    await expect(readPharmacyMemberAccess(db, 'org_2', 'u_1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
