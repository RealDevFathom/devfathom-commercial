/**
 * #435 — the assistant's member-edit tools must honor a `team:setRole` DENY,
 * not just the raw session role. Otherwise an ADMIN denied the capability can
 * still grant or revoke roles by asking the assistant instead of using the UI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  invitationUpsert: vi.fn(),
  departmentFindFirst: vi.fn(),
  resolveEntitlements: vi.fn(),
  can: vi.fn<(action: string) => Promise<boolean>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: vi.fn(),
  templates: { inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: mocks.resolveEntitlements,
  assertSeatAvailable: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));

import { buildPeopleTools } from './people';
import type { AssistantHelpers } from '@/lib/ai/context';

const db = {
  user: {
    findFirst: mocks.findFirst,
    findUnique: mocks.findUnique,
    count: mocks.count,
    create: mocks.create,
    update: mocks.update,
  },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: { create: mocks.create, update: mocks.update },
      invitation: { upsert: mocks.invitationUpsert },
    }),
};

type Execute = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function tools() {
  const helpers = {
    db,
    isAdmin: true,
    isHr: false,
    isAdminOrHr: true,
    ctx: { userId: 'user_admin', name: 'Admin', organizationId: 'org_a' },
    can: mocks.can,
    audit: vi.fn(),
    activity: vi.fn(),
    resolvePerson: vi.fn(async () => ({
      kind: 'found',
      value: { id: 'user_casey', name: 'Casey' },
      interpreted: false,
    })),
  } as unknown as AssistantHelpers;
  const built = buildPeopleTools(helpers);
  const execute = (name: string) => (built[name] as unknown as { execute: Execute }).execute;
  return {
    updateMember: execute('updateMember'),
    inviteMember: execute('inviteMember'),
    setMemberStatus: execute('setMemberStatus'),
    resetMemberPassword: execute('resetMemberPassword'),
  };
}

const denied = { error: 'You do not have permission to change team member access.' };

const casey = {
  id: 'user_casey',
  name: 'Casey',
  role: 'EMPLOYEE',
  department: 'ENGINEERING',
  title: 'Engineer',
  phone: null,
  bio: null,
  skills: [],
  status: 'ACTIVE',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.findUnique.mockResolvedValue(casey);
  mocks.findFirst.mockResolvedValue(null);
  mocks.count.mockResolvedValue(1);
  mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_1' });
  mocks.create.mockResolvedValue({ id: 'user_new', name: 'Alex Carter' });
  mocks.update.mockResolvedValue({ ...casey, role: 'ADMIN' });
  mocks.invitationUpsert.mockResolvedValue({});
  mocks.resolveEntitlements.mockResolvedValue({ activeSeats: 1, seatLimit: 10 });
});

describe('assistant member tools honor team:setRole', () => {
  function denySetRole() {
    mocks.can.mockImplementation(async (action) => action !== 'team:setRole');
  }

  it('refuses to grant a role when team:setRole is denied', async () => {
    denySetRole();

    const result = await tools().updateMember({ name: 'Casey', role: 'ADMIN' });

    expect(result).toEqual(denied);
    expect(mocks.can).toHaveBeenCalledWith('team:setRole');
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses a profile-only edit when team:setRole is denied', async () => {
    denySetRole();

    const result = await tools().updateMember({ name: 'Casey', title: 'Senior Engineer' });

    expect(result).toEqual(denied);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses to invite when team:setRole is denied', async () => {
    denySetRole();

    const result = await tools().inviteMember({
      name: 'Alex Carter',
      email: 'alex@company.com',
      role: 'ADMIN',
      department: 'ENGINEERING',
      title: 'Engineer',
    });

    expect(result).toEqual(denied);
    expect(mocks.departmentFindFirst).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.resolveEntitlements).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('refuses a status change when team:setRole is denied', async () => {
    denySetRole();

    const result = await tools().setMemberStatus({ name: 'Casey', status: 'ON_LEAVE' });

    expect(result).toEqual(denied);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses a password reset when team:setRole is denied', async () => {
    denySetRole();

    const result = await tools().resetMemberPassword({
      name: 'Casey',
      newPassword: 'Aa1'.repeat(4),
    });

    expect(result).toEqual(denied);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('grants a role when team:setRole is allowed', async () => {
    const result = await tools().updateMember({ name: 'Casey', role: 'ADMIN' });

    expect(result).not.toHaveProperty('error');
    expect(mocks.can).toHaveBeenCalledWith('team:setRole');
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_casey' }, data: { role: 'ADMIN' } })
    );
  });

  it('invites when team:setRole is allowed', async () => {
    const result = await tools().inviteMember({
      name: 'Alex Carter',
      email: 'alex@company.com',
      role: 'HR',
      department: 'ENGINEERING',
      title: 'Engineer',
    });

    expect(result).not.toHaveProperty('error');
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'HR' }) })
    );
  });
});
