/**
 * DEV-838 (F19, F21) — the assistant's password reset.
 *
 * The model must never carry a password: the tool takes only who to reset.
 * Approval applies the shared administrative reset policy (tokenVersion bump so
 * every issued JWT fails revalidation — see auth.must-change-password.test.ts —
 * plus a forced rotation) and emails the member a private, single-use link. The
 * link and its token never appear in model-visible output or the audit record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { compare } from 'bcryptjs';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  userUpdate: vi.fn(),
  resetTokenCreate: vi.fn(),
  sendEmail: vi.fn(),
  passwordResetTemplate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: mocks.sendEmail,
  templates: {
    inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
    passwordReset: mocks.passwordResetTemplate,
  },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(),
  assertSeatAvailable: vi.fn(),
}));

import { buildPeopleTools } from './people';
import { hashInviteToken } from '@/lib/invite-token';
import type { AssistantHelpers } from '@/lib/ai/context';

const db = {
  user: { findUnique: mocks.findUnique, update: mocks.userUpdate },
  passwordResetToken: { create: mocks.resetTokenCreate },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: { update: mocks.userUpdate },
      passwordResetToken: { create: mocks.resetTokenCreate },
    }),
};

type ResetTool = {
  inputSchema: z.ZodType;
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function setup() {
  const helpers = {
    db,
    isAdmin: true,
    isHr: false,
    isAdminOrHr: true,
    ctx: { organizationId: 'org_1', userId: 'user_admin', name: 'Admin' },
    can: vi.fn(async () => true),
    audit: vi.fn(),
    resolvePerson: vi.fn(async () => ({
      kind: 'found',
      value: { id: 'user_aisha', name: 'Aisha Khan' },
      interpreted: false,
    })),
  } as unknown as AssistantHelpers & { audit: ReturnType<typeof vi.fn> };
  const tool = buildPeopleTools(helpers).resetMemberPassword as unknown as ResetTool;
  return { helpers, tool };
}

/** The raw token that went into the private email link. */
function emailedToken(): string {
  const { resetUrl } = mocks.passwordResetTemplate.mock.calls[0]![0] as { resetUrl: string };
  const match = /\/reset-password\/([^/]+)$/.exec(resetUrl);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('assistant resetMemberPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: 'user_aisha',
      name: 'Aisha Khan',
      email: 'aisha@company.com',
      status: 'ACTIVE',
    });
    mocks.userUpdate.mockResolvedValue({
      id: 'user_aisha',
      name: 'Aisha Khan',
      email: 'aisha@company.com',
    });
    mocks.resetTokenCreate.mockResolvedValue({});
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.passwordResetTemplate.mockReturnValue({ subject: 's', html: 'h', text: 't' });
  });

  it('has no password parameter, so the model cannot supply or see one', () => {
    const { tool } = setup();
    const schema = z.toJSONSchema(tool.inputSchema) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['name']);
    expect(JSON.stringify(schema).toLowerCase()).not.toContain('password"');

    // A model-invented password argument is stripped before execute ever runs.
    const parsed = tool.inputSchema.parse({ name: 'Aisha', newPassword: 'Leaked-Passw0rd' });
    expect(parsed).toEqual({ name: 'Aisha' });
  });

  it('revokes sessions with the shared policy and emails a private single-use link', async () => {
    const { tool, helpers } = setup();

    const result = await tool.execute({ name: 'Aisha Khan' });

    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_aisha' },
      data: {
        password: expect.stringMatching(/^\$2[aby]\$12\$/),
        passwordChangedAt: null,
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
      select: { id: true, name: true, email: true },
    });
    // The old (possibly compromised) password is retired: it no longer matches.
    const installed = mocks.userUpdate.mock.calls[0]![0].data.password as string;
    expect(await compare('Old-Compromised-1', installed)).toBe(false);

    const token = emailedToken();
    expect(mocks.resetTokenCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user_aisha',
        tokenHash: hashInviteToken(token),
        expiresAt: expect.any(Date),
      },
    });
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: { email: 'aisha@company.com', name: 'Aisha Khan' } })
    );

    expect(result).toMatchObject({ success: true, sessionsRevoked: true, emailed: true });
    // Neither the model-visible result nor the audit record carries the link.
    const visible = JSON.stringify([result, helpers.audit.mock.calls]);
    expect(visible).not.toContain(installed);
    expect(visible).not.toContain(token);
    expect(visible).not.toContain('/reset-password/');
  });

  it('still revokes sessions when the email fails, without leaking the link', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('smtp down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tool } = setup();

    const result = await tool.execute({ name: 'Aisha Khan' });

    expect(mocks.userUpdate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, sessionsRevoked: true, emailed: false });
    expect(JSON.stringify(result)).not.toContain(emailedToken());
    expect(JSON.stringify(error.mock.calls)).not.toContain(emailedToken());
    error.mockRestore();
  });

  it('re-checks admin at execution and refuses without any write, token or email', async () => {
    const { tool, helpers } = setup();
    helpers.isAdmin = false;

    const result = await tool.execute({ name: 'Aisha Khan' });

    expect(result).toEqual({ error: 'Only admins can reset passwords.' });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.resetTokenCreate).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each(['INACTIVE', 'INVITED'])('refuses a %s member without side effects', async (status) => {
    mocks.findUnique.mockResolvedValue({
      id: 'user_aisha',
      name: 'Aisha Khan',
      email: 'aisha@company.com',
      status,
    });
    const { tool } = setup();

    const result = await tool.execute({ name: 'Aisha Khan' });

    expect(result.error).toEqual(expect.any(String));
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.resetTokenCreate).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
