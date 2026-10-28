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
  audit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: vi.fn(),
  templates: { inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));

import { buildPeopleTools } from './people';
import { sendEmail, templates } from '@/lib/email';
import { hashInviteToken } from '@/lib/invite-token';
import type { AssistantHelpers } from '@/lib/ai/context';

const db = {
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  // WHA-278: the invite path validates the department against the tenant's own
  // configured catalog before writing.
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
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
    ctx: { userId: 'user_admin', name: 'Admin' },
    can: vi.fn(async () => true),
    audit: mocks.audit,
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
    vi.resetAllMocks();
    vi.mocked(templates.inviteMember).mockReturnValue({ subject: 's', html: 'h', text: 't' });
    mocks.update.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_1' });
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
      ctx: { userId: 'user_admin', name: 'Admin' },
      can: vi.fn(async () => true),
      audit: mocks.audit,
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

describe('assistant invitation credential boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.update.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_1' });
    vi.mocked(templates.inviteMember).mockReturnValue({ subject: 's', html: 'h', text: 't' });
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'reinvite=%s emailFailure=%s keeps credentials out of model and audit',
    async (reInvite, emailFailure) => {
      mocks.findFirst.mockResolvedValue(reInvite ? { id: 'user_2', status: 'INVITED' } : null);
      if (emailFailure)
        vi.mocked(sendEmail).mockRejectedValueOnce(new Error('delivery unavailable'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await inviteTool().execute({ ...base, email: ' Alex@Company.COM ' });
        expect(result).toStrictEqual({
          name: 'Alex Carter',
          email: 'alex@company.com',
          role: 'Employee',
          department: 'Engineering',
          emailed: !emailFailure,
        });
        const mailInput = vi.mocked(templates.inviteMember).mock.calls[0][0];
        const token = new URL(mailInput.acceptUrl).pathname.split('/').at(-1)!;
        expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
        const tokenHash = hashInviteToken(token);
        const write = mocks.invitationUpsert.mock.calls[0][0];
        expect(write.create.tokenHash === tokenHash).toBe(true);
        expect(write.update.tokenHash === tokenHash).toBe(true);
        expect(write.update.acceptedAt).toBeNull();
        expect(reInvite ? mocks.update : mocks.create).toHaveBeenCalledOnce();
        expect(sendEmail).toHaveBeenCalledExactlyOnceWith({
          to: { email: 'alex@company.com', name: 'Alex Carter' },
          subject: 's',
          html: 'h',
          text: 't',
        });
        expect(mocks.audit).toHaveBeenCalledOnce();
        expect(mocks.audit.mock.calls[0][0].metadata.reInvite).toBe(reInvite);
        const serialized = JSON.stringify({ result, audit: mocks.audit.mock.calls });
        for (const secret of [token, tokenHash, mailInput.acceptUrl])
          expect(serialized.includes(secret)).toBe(false);
        expect(/inviteUrl|tokenHash|acceptUrl/.test(serialized)).toBe(false);
      } finally {
        log.mockRestore();
      }
    }
  );
});
