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
import type { AssistantHelpers } from '@/lib/ai/context';

const db = {
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  // WHA-278: the invite path validates the department against the tenant's own
  // configured catalog before writing.
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  organizationRole: { findFirst: mocks.roleFindFirst },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: { create: mocks.create, update: mocks.update },
      invitation: { upsert: mocks.invitationUpsert },
    }),
};

function inviteTool() {
  const helpers = {
    db,
    isAdmin: true,
    isHr: false,
    isAdminOrHr: true,
    ctx: { userId: 'user_admin', name: 'Admin', organizationId: 'org_test' },
    can: vi.fn(async () => true),
    audit: vi.fn(),
  } as unknown as AssistantHelpers;
  const tools = buildPeopleTools(helpers);
  return tools.inviteMember as unknown as {
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

  it('stores the canonical form for a genuinely new member', async () => {
    mocks.findFirst.mockResolvedValue(null);

    await inviteTool().execute({ ...base, email: 'New.Person@Company.COM' });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new.person@company.com' }),
      })
    );
  });

  it('refuses a new member when the workspace has reached its seat limit', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.resolveEntitlements.mockResolvedValue({ activeSeats: 5, seatLimit: 5 });

    const result = await inviteTool().execute({ ...base, email: 'new.person@company.com' });

    expect(result.error).toBe('Seat limit reached (5/5).');
    expect(mocks.resolveEntitlements).toHaveBeenCalledWith('org_test', db);
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
      ctx: { userId: 'user_admin', name: 'Admin', organizationId: 'org_test' },
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

  it.each([undefined, null])(
    'preserves the pending restaurant role when the assistant sends %j',
    async (restaurantRoleKey) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_2', status: 'INVITED' });
      mocks.update.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });

      await inviteTool().execute({
        ...base,
        email: 'manager@company.com',
        restaurantRoleKey,
      });

      expect(mocks.update).toHaveBeenCalledOnce();
      expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty('organizationRoleId');
      expect(mocks.roleFindFirst).not.toHaveBeenCalled();
      expect(mocks.invitationUpsert).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ['general-manager', 'General Manager'],
    ['branch-manager', 'Branch Manager'],
    ['bar-barista', 'Bar / Barista'],
    ['accountant', 'Accountant'],
  ])('assigns the %s restaurant role through an assistant invite', async (key, name) => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.roleFindFirst.mockResolvedValue({ id: `role_${key}`, key, name });

    await inviteTool().execute({
      ...base,
      email: `${key}@company.com`,
      restaurantRoleKey: key,
    });

    expect(mocks.roleFindFirst).toHaveBeenCalledWith({
      where: { key, organizationId: 'org_test' },
      select: { id: true, key: true, name: true },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationRoleId: `role_${key}` }),
      })
    );
  });

  it('clears a pending restaurant role only when explicitly requested', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_2', status: 'INVITED' });
    mocks.update.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });

    await inviteTool().execute({
      ...base,
      email: 'manager@company.com',
      restaurantRoleKey: null,
      clearRestaurantRole: true,
    });

    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationRoleId: null }) })
    );
    expect(mocks.roleFindFirst).not.toHaveBeenCalled();
  });

  it('rejects conflicting restaurant role assignment and clearing', async () => {
    const result = await inviteTool().execute({
      ...base,
      email: 'manager@company.com',
      restaurantRoleKey: 'general-manager',
      clearRestaurantRole: true,
    });

    expect(result.error).toBe('Choose a restaurant role or clear it, not both.');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('rejects an assistant role outside the workspace catalog', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.roleFindFirst.mockResolvedValue(null);

    const result = await inviteTool().execute({
      ...base,
      email: 'manager@company.com',
      restaurantRoleKey: 'general-manager',
    });

    expect(result.error).toBe('"general-manager" is not a role in this workspace.');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
