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
  resolveEntitlements: vi.fn(),
  queryRaw: vi.fn(),
  count: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: vi.fn(),
  templates: { inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements')>();
  return { ...actual, resolveOrganizationEntitlements: mocks.resolveEntitlements };
});

import { buildPeopleTools } from './people';
import type { AssistantHelpers } from '@/lib/ai/context';

const transactionClient = {
  $queryRaw: mocks.queryRaw,
  user: { create: mocks.create, update: mocks.update, count: mocks.count },
  invitation: { upsert: mocks.invitationUpsert },
};

const db = {
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  // WHA-278: the invite path validates the department against the tenant's own
  // configured catalog before writing.
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(transactionClient),
};

function inviteTool() {
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

describe('assistant inviteMember duplicate guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_1' });
    mocks.queryRaw.mockResolvedValue([{ id: 'org_1' }]);
    mocks.count.mockResolvedValue(9);
    mocks.resolveEntitlements.mockResolvedValue({
      organizationId: 'org_1',
      seatLimit: 10,
      activeSeats: 9,
      enabledModules: [],
      modules: [],
      limits: {},
    });
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

  it('refuses a new member when the workspace has no available seats', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(10);
    mocks.resolveEntitlements.mockResolvedValue({
      organizationId: 'org_1',
      seatLimit: 10,
      activeSeats: 10,
      enabledModules: [],
      modules: [],
      limits: {},
    });

    await expect(
      inviteTool().execute({ ...base, email: 'new.person@company.com' })
    ).rejects.toThrow('Seat limit reached (10/10).');

    expect(mocks.resolveEntitlements).toHaveBeenCalledWith('org_1', transactionClient);
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] },
      },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('does not consume another seat when refreshing a pending invitation', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_1', status: 'INVITED' });
    mocks.update.mockResolvedValue({ id: 'user_1', name: 'Alex Carter' });

    await inviteTool().execute({ ...base, email: 'alex@company.com' });

    expect(mocks.resolveEntitlements).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalled();
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
