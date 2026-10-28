import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AssistantHelpers } from '@/lib/ai/context';

const mocks = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock('@/lib/auth/password-reset', () => ({ initiateAdminPasswordReset: mocks.reset }));
import { buildPeopleTools } from './people';

function setup() {
  const h = {
    db: {},
    isAdmin: true,
    isAdminOrHr: true,
    ctx: { organizationId: 'org_a', userId: 'admin_a' },
    resolvePerson: vi.fn(async () => ({
      kind: 'found',
      value: { id: 'user_a' },
      interpreted: true,
    })),
    audit: vi.fn(),
    can: vi.fn(async () => true),
  };
  const tool = buildPeopleTools(h as unknown as AssistantHelpers)
    .resetMemberPassword as unknown as {
    inputSchema: z.ZodObject;
    needsApproval: boolean;
    execute: (input: { name: string }) => Promise<unknown>;
  };
  return { h, tool };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reset.mockResolvedValue({ user: { id: 'user_a', name: 'Aisha' }, emailSent: true });
});

describe('assistant out-of-band password reset', () => {
  it('exposes only a member name, requires approval, and returns only safe status', async () => {
    const { h, tool } = setup();
    expect(Object.keys(tool.inputSchema.shape)).toEqual(['name']);
    expect(tool.needsApproval).toBe(true);
    // An old approval continuation cannot supply a credential to the executor.
    const parsed = tool.inputSchema.parse({
      name: 'Aisha',
      newPassword: 'Injected123!',
      token: 'forged',
    });
    expect(parsed).toEqual({ name: 'Aisha' });
    expect(await tool.execute(parsed as { name: string })).toEqual({
      name: 'Aisha',
      success: true,
      emailSent: true,
      message: 'Reset link sent to the registered email. Existing sessions and tokens revoked.',
      scopeNote: 'Interpreted "Aisha" as Aisha.',
    });
    expect(mocks.reset).toHaveBeenCalledWith(h.db, 'org_a', 'user_a');
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'resetMemberPassword',
        targetId: 'user_a',
        metadata: { passwordReset: true, emailSent: true },
      })
    );
  });

  it('rechecks permission on execution after approval', async () => {
    const { h, tool } = setup();
    h.isAdmin = false;
    expect(await tool.execute({ name: 'Aisha' })).toEqual({
      error: 'Only admins can reset passwords.',
    });
    expect(h.resolvePerson).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('honors an explicit capability denial even for an admin', async () => {
    const { h, tool } = setup();
    h.can.mockResolvedValue(false);
    expect(await tool.execute({ name: 'Aisha' })).toEqual({
      error: 'Only admins can reset passwords.',
    });
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'notfound' }, { error: 'No team member matches "Aisha".' }],
    [
      { kind: 'ambiguous', candidates: ['Aisha A', 'Aisha B'] },
      { needsClarification: 'Which one — Aisha A, Aisha B?' },
    ],
  ])('preserves resolution failures without side effects', async (resolution, expected) => {
    const { h, tool } = setup();
    h.resolvePerson.mockResolvedValue(resolution as never);
    expect(await tool.execute({ name: 'Aisha' })).toEqual(expected);
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('reports delivery failure safely while recording revocation', async () => {
    const { h, tool } = setup();
    mocks.reset.mockResolvedValue({ user: { id: 'user_a', name: 'Aisha' }, emailSent: false });
    expect(await tool.execute({ name: 'Aisha' })).toMatchObject({
      success: true,
      emailSent: false,
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { passwordReset: true, emailSent: false } })
    );
  });
});
