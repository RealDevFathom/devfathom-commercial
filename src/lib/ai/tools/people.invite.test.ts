/**
 * D20 — the assistant's `inviteMember` tool is a user-creation path too, so it
 * must refuse a differently-cased duplicate with a stated message rather than
 * letting the composite unique index surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  invitationUpsert: vi.fn(),
  departmentFindFirst: vi.fn(),
  roleFindFirst: vi.fn(),
  roleFindMany: vi.fn(),
  resolveEntitlements: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: vi.fn(),
  templates: { inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: mocks.resolveEntitlements,
  assertSeatAvailable: (entitlements: { activeSeats: number; seatLimit: number }) => {
    if (entitlements.activeSeats >= entitlements.seatLimit) {
      throw new Error(
        `Seat limit reached (${entitlements.activeSeats}/${entitlements.seatLimit}).`
      );
    }
  },
}));

import { buildPeopleTools } from './people';
import { INVITE_ROLE_MISMATCH, INVITE_ROLE_NOT_OFFERED } from '@/lib/vertical-catalog';
import { sendEmail, templates } from '@/lib/email';
import type { AssistantHelpers } from '@/lib/ai/context';

const db = {
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  // WHA-278: the invite path validates the department against the tenant's own
  // configured catalog before writing.
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  organizationRole: { findFirst: mocks.roleFindFirst, findMany: mocks.roleFindMany },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: { create: mocks.create, update: mocks.update },
      invitation: { upsert: mocks.invitationUpsert },
    }),
};

function peopleTools(vertical?: string) {
  const helpers = {
    db,
    isAdmin: true,
    isHr: false,
    isAdminOrHr: true,
    ctx: { organizationId: 'org_1', userId: 'user_admin', name: 'Admin', vertical },
    can: vi.fn(async () => true),
    audit: vi.fn(),
  } as unknown as AssistantHelpers;
  return buildPeopleTools(helpers);
}

function inviteTool(vertical?: string) {
  return peopleTools(vertical).inviteMember as unknown as {
    inputSchema: { parse: (input: Record<string, unknown>) => Record<string, unknown> };
    execute: (input: Record<string, unknown>) => Promise<{ error?: string }>;
  };
}

const base = {
  name: 'Alex Carter',
  department: 'ENGINEERING',
  title: 'Engineer',
  role: 'EMPLOYEE',
};

describe('assistant inviteMember guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_1' });
    mocks.resolveEntitlements.mockResolvedValue({ activeSeats: 1, seatLimit: 5 });
  });

  it.each([['ALEX@COMPANY.COM'], ['Alex@Company.com'], ['  alex@company.com  ']])(
    'refuses %j when alex@company.com is already a member',
    async (email) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_1', status: 'ACTIVE' });

      const result = await inviteTool().execute({ ...base, email });

      expect(result.error).toBe('A user with this email already exists.');
      expect(mocks.findFirst).toHaveBeenCalledWith({
        where: { email: 'alex@company.com' },
        select: { id: true, status: true },
      });
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  // DEV-838 (F20): the accept link is a bearer credential. It must reach only
  // the invitee's inbox, never the tool result that flows into the next model
  // call (and from there into the action ledger).
  it.each([
    ['delivered', true],
    ['failed', false],
  ])('keeps the invitation token out of the model-visible result (%s email)', async (_, ok) => {
    mocks.findFirst.mockResolvedValue(null);
    if (!ok) vi.mocked(sendEmail).mockRejectedValueOnce(new Error('smtp down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await inviteTool().execute({ ...base, email: 'new.person@company.com' });

    const { acceptUrl } = vi.mocked(templates.inviteMember).mock.calls[0]![0];
    const token = acceptUrl.split('/invite/')[1]!;
    expect(token.length).toBeGreaterThan(20);
    expect(mocks.invitationUpsert).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ email: 'new.person@company.com', emailed: ok });
    expect(result).not.toHaveProperty('inviteUrl');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('/invite/');
    error.mockRestore();
  });

  it('stores the canonical form for a genuinely new member', async () => {
    mocks.findFirst.mockResolvedValue(null);

    await inviteTool().execute({ ...base, email: 'New.Person@Company.COM' });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new.person@company.com' }),
      })
    );
  });

  it.each([
    ['general-manager', 'General Manager'],
    ['branch-manager', 'Branch Manager'],
    ['bar-barista', 'Bar / Barista'],
    ['accountant', 'Accountant'],
  ])('assigns the tenant %s role through the tool schema', async (key, name) => {
    mocks.findFirst.mockResolvedValue(null);
    const id = `role_${key}`;
    mocks.roleFindFirst.mockResolvedValue({ id, name });
    const tool = inviteTool();

    const result = await tool.execute(
      tool.inputSchema.parse({ ...base, email: 'staff@company.com', organizationRoleId: id })
    );

    expect(result.error).toBeUndefined();
    expect(templates.inviteMember).toHaveBeenCalledWith(expect.objectContaining({ role: name }));
    expect(mocks.roleFindFirst).toHaveBeenCalledWith({
      where: { id, organizationId: 'org_1' },
      select: { id: true, name: true, key: true },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationRoleId: id }),
      })
    );
  });

  it('lists tenant role IDs for the invite tool', async () => {
    const roles = [{ id: 'role_gm', key: 'general-manager', name: 'General Manager' }];
    mocks.roleFindMany.mockResolvedValue(roles);
    const tool = peopleTools().listStaffRoles as unknown as {
      execute: (input: object) => Promise<unknown>;
    };

    expect(await tool.execute({})).toEqual(roles);
    expect(mocks.roleFindMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1' },
      orderBy: { name: 'asc' },
      select: { id: true, key: true, name: true },
    });
  });

  it('rejects a role outside the tenant catalog before writing', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.roleFindFirst.mockResolvedValue(null);

    const result = await inviteTool().execute({
      ...base,
      email: 'staff@company.com',
      organizationRoleId: 'another_tenant_role',
    });

    expect(result.error).toBe('Invalid role template.');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    'preserves a pending role when no template is selected (%s)',
    async (organizationRoleId) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_invited', status: 'INVITED' });
      mocks.update.mockResolvedValue({ id: 'user_invited', name: 'Alex Carter' });

      await inviteTool().execute({ ...base, email: 'staff@company.com', organizationRoleId });

      expect(mocks.update.mock.calls[0]![0].data).not.toHaveProperty('organizationRoleId');
      expect(mocks.invitationUpsert).toHaveBeenCalledOnce();
    }
  );

  it('replaces a pending role when a valid template is selected', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_invited', status: 'INVITED' });
    mocks.update.mockResolvedValue({ id: 'user_invited', name: 'Alex Carter' });
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_branch', name: 'Branch Manager' });

    await inviteTool().execute({
      ...base,
      email: 'staff@company.com',
      organizationRoleId: 'role_branch',
    });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationRoleId: 'role_branch' }),
      })
    );
  });

  it('refuses a new member when the workspace has reached its seat limit', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.resolveEntitlements.mockResolvedValue({ activeSeats: 5, seatLimit: 5 });

    const result = await inviteTool().execute({ ...base, email: 'new.person@company.com' });

    expect(result.error).toBe('Seat limit reached (5/5).');
    expect(mocks.resolveEntitlements).toHaveBeenCalledWith('org_1', db);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('refreshes a pending invite at the seat limit without consuming another seat', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_invited', status: 'INVITED' });
    mocks.update.mockResolvedValue({ id: 'user_invited', name: 'Alex Carter' });
    mocks.resolveEntitlements.mockResolvedValue({ activeSeats: 5, seatLimit: 5 });

    const result = await inviteTool().execute({ ...base, email: 'alex@company.com' });

    expect(result.error).toBeUndefined();
    expect(mocks.resolveEntitlements).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalled();
    expect(mocks.invitationUpsert).toHaveBeenCalled();
  });

  // WHA-278 — departments are tenant-configured rows behind a composite foreign
  // key. A key this workspace does not have must be refused with a stated
  // message rather than surfacing as a raw constraint violation.
  it('refuses a department this workspace has not configured', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.departmentFindFirst.mockResolvedValue(null);

    const result = await inviteTool().execute({
      ...base,
      email: 'new.person@company.com',
      department: 'KITCHEN',
    });

    expect(result).toEqual({
      error: '"KITCHEN" is not an active department in this workspace.',
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('re-checks admin permission when the tool runs, ignoring the approval that built it', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const helpers = {
      db,
      isAdmin: true,
      isHr: false,
      isAdminOrHr: true,
      ctx: { organizationId: 'org_1', userId: 'user_admin', name: 'Admin' },
      can: vi.fn(async () => true),
      audit: vi.fn(),
    } as unknown as AssistantHelpers;
    const tools = buildPeopleTools(helpers);
    helpers.isAdmin = false;

    const result = await (
      tools.inviteMember as unknown as {
        execute: (input: Record<string, unknown>) => Promise<{ error?: string }>;
      }
    ).execute({ ...base, email: 'new.person@company.com' });

    const roleTool = tools.listStaffRoles as unknown as {
      execute: (input: object) => Promise<{ error?: string }>;
    };
    expect(await roleTool.execute({})).toEqual({
      error: 'Only admins can list staff role templates.',
    });
    expect(mocks.roleFindMany).not.toHaveBeenCalled();

    expect(result.error).toBe('Only admins can invite members.');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('accepts a non-agency department key the workspace does configure', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_kitchen' });

    await inviteTool().execute({
      ...base,
      email: 'new.person@company.com',
      department: 'KITCHEN',
    });

    expect(mocks.departmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'KITCHEN', active: true } })
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ department: 'KITCHEN' }) })
    );
  });
});

// SEC-I (DEV-827): the assistant grants exactly what the chosen role's label says.
describe('assistant inviteMember pharmacy role labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_1' });
    mocks.resolveEntitlements.mockResolvedValue({ activeSeats: 1, seatLimit: 5 });
  });

  const template = (key: string) =>
    mocks.roleFindFirst.mockResolvedValue({ id: `role_${key}`, name: key, key });

  it.each([
    ['owner', 'ADMIN', INVITE_ROLE_NOT_OFFERED],
    ['owner-operator', 'EMPLOYEE', INVITE_ROLE_NOT_OFFERED],
    ['manager', 'HR', INVITE_ROLE_MISMATCH],
  ])('refuses %s at %s', async (key, role, message) => {
    template(key);
    const tool = inviteTool('PHARMACY');
    const result = await tool.execute(
      tool.inputSchema.parse({
        ...base,
        email: 'staff@pharmacy.pk',
        role,
        organizationRoleId: `role_${key}`,
      })
    );
    expect(result.error).toBe(message);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('reads the vertical when the assistant context omits it', async () => {
    template('owner');
    mocks.resolveEntitlements.mockResolvedValue({
      activeSeats: 1,
      seatLimit: 5,
      vertical: 'PHARMACY',
    });
    const tool = inviteTool();
    const result = await tool.execute(
      tool.inputSchema.parse({
        ...base,
        email: 'staff@pharmacy.pk',
        role: 'ADMIN',
        organizationRoleId: 'role_owner',
      })
    );
    expect(result.error).toBe(INVITE_ROLE_NOT_OFFERED);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('invites a pharmacy manager at staff access', async () => {
    template('manager');
    const tool = inviteTool('PHARMACY');
    const result = await tool.execute(
      tool.inputSchema.parse({
        ...base,
        email: 'staff@pharmacy.pk',
        organizationRoleId: 'role_manager',
      })
    );
    expect(result.error).toBeUndefined();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'EMPLOYEE', organizationRoleId: 'role_manager' }),
      })
    );
  });
});
