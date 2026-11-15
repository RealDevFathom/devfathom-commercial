import { beforeEach, describe, expect, it, vi } from 'vitest';

const abac = vi.hoisted(() => ({ can: vi.fn(async () => true) }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: abac.can,
}));

import { actorManagesBranchDrawers } from './counter-capability';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const manager: Rule[] = [
  { capability: 'pharmacy:counter', effect: 'ALLOW' },
  { capability: 'pharmacy:manage', effect: 'ALLOW' },
];

function fixture(options: {
  roleRules?: Rule[];
  overrides?: Rule[];
  member?: { status: string; organizationId: string } | null;
  assigned?: boolean;
}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(
        options.member === null
          ? null
          : {
              status: 'ACTIVE',
              organizationId: 'org-1',
              ...options.member,
              organizationRole: { permissions: options.roleRules ?? manager },
              permissionOverrides: options.overrides ?? [],
            }
      ),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn().mockResolvedValue(options.assigned === false ? null : { branchId: 'b-1' }),
    },
  };
}
const employee = { id: 'user-1', role: 'EMPLOYEE', status: 'ACTIVE' };
const decide = (db: ReturnType<typeof fixture>, user: typeof employee = employee) =>
  actorManagesBranchDrawers(db as never, user, 'org-1', 'b-1', { source: 'TRPC' });

describe('actorManagesBranchDrawers (DEV-821)', () => {
  beforeEach(() => {
    abac.can.mockReset().mockResolvedValue(true);
  });

  it('admits a manager or owner assigned to the branch', async () => {
    const db = fixture({});
    await expect(decide(db)).resolves.toBe(true);
    expect(abac.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'pharmacy:manage',
      undefined,
      expect.objectContaining({ db, source: 'TRPC' })
    );
    expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        userId: 'user-1',
        branchId: 'b-1',
        active: true,
        branch: { organizationId: 'org-1', active: true },
      },
      select: { branchId: true },
    });
  });

  it('refuses a cashier without the canonical manager grant', async () => {
    abac.can.mockResolvedValue(false);
    const db = fixture({});
    await expect(decide(db)).resolves.toBe(false);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  type Options = Parameters<typeof fixture>[0];
  const denials: [string, Options][] = [
    [
      'a user DENY on the manager family',
      { overrides: [{ capability: 'pharmacy.manage', effect: 'DENY' }] },
    ],
    [
      'a role DENY on the counter family',
      { roleRules: [...manager, { capability: 'pharmacy:counter', effect: 'DENY' }] },
    ],
    [
      'no manager ALLOW in the member rules',
      { roleRules: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
    ],
  ];
  it.each(denials)('lets %s win over the organization-wide grant', async (_case, options) => {
    await expect(decide(fixture(options))).resolves.toBe(false);
  });

  const refusals: [string, Options][] = [
    ['an inactive member', { member: { status: 'SUSPENDED', organizationId: 'org-1' } }],
    ['a member of another organization', { member: { status: 'ACTIVE', organizationId: 'org-2' } }],
    ['an unknown user', { member: null }],
    ['a manager not assigned to the branch', { assigned: false }],
  ];
  it.each(refusals)('refuses %s', async (_case, options) => {
    await expect(decide(fixture(options))).resolves.toBe(false);
  });

  it('admits a session ADMIN of the organization on any of its branches', async () => {
    const db = fixture({ assigned: false });
    await expect(decide(db, { ...employee, role: 'ADMIN' })).resolves.toBe(true);
    expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
  });
});
