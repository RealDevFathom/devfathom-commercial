import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hash } from 'bcryptjs';
import { hashInviteToken } from '@/lib/invite-token';
import { INVITATION_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';

const mocks = vi.hoisted(() => ({
  invitationFindUnique: vi.fn(),
  invitationUpdateMany: vi.fn(),
  userUpdateMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed-password') }));

import type { TRPCContext } from '../trpc';
import { invitationsRouter } from './invitations';

const pendingInvitation = {
  id: 'invitation_a',
  userId: 'user_a',
  tokenHash: hashInviteToken('raw-token'),
  acceptedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  user: {
    id: 'user_a',
    name: 'Invitee',
    email: 'invitee@example.test',
    title: 'Engineer',
    department: 'ENGINEERING',
    role: 'EMPLOYEE',
    status: 'INVITED',
    organization: { isDemo: false },
  },
};

const transactionDb = {
  invitation: {
    findUnique: mocks.invitationFindUnique,
    updateMany: mocks.invitationUpdateMany,
  },
  user: { updateMany: mocks.userUpdateMany },
};

const db = {
  ...transactionDb,
  $transaction: async (fn: (tx: typeof transactionDb) => Promise<unknown>) => fn(transactionDb),
};

const caller = () =>
  invitationsRouter.createCaller({
    db,
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext);

describe('invitation acceptance status guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invitationFindUnique.mockResolvedValue(pendingInvitation);
    mocks.invitationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.userUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('does not expose a pending token for a deactivated invitee', async () => {
    mocks.invitationFindUnique.mockResolvedValue({
      ...pendingInvitation,
      user: { ...pendingInvitation.user, status: 'INACTIVE' },
    });

    await expect(caller().get({ token: 'raw-token' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('cannot reactivate an invitee deactivated after the invitation was loaded', async () => {
    mocks.userUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      caller().accept({
        token: 'raw-token',
        password: 'Str0ng!Passw0rd',
        phone: '+15550123',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mocks.userUpdateMany).toHaveBeenCalledWith({
      where: { id: 'user_a', status: 'INVITED' },
      data: expect.objectContaining({ status: 'ACTIVE' }),
    });
  });

  it('rejects an old acceptance after a resend during hashing and leaves the new token usable once', async () => {
    const row = { ...pendingInvitation, acceptedAt: null as Date | null };
    mocks.invitationFindUnique.mockImplementation(async ({ where }) =>
      where.tokenHash === row.tokenHash ? { ...row } : null
    );
    // Model the conditional database write against the current row, not the
    // snapshot returned before hashing. An omitted predicate matches any token.
    mocks.invitationUpdateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.id !== row.id ||
        (where.tokenHash !== undefined && where.tokenHash !== row.tokenHash) ||
        row.acceptedAt !== where.acceptedAt ||
        row.expiresAt <= where.expiresAt.gt
      ) {
        return { count: 0 };
      }
      row.acceptedAt = data.acceptedAt;
      return { count: 1 };
    });
    vi.mocked(hash).mockImplementationOnce(async () => {
      // Both resend paths rotate the token on the same invitation row.
      row.tokenHash = hashInviteToken('resent-token');
      row.expiresAt = new Date(Date.now() + 120_000);
      row.acceptedAt = null;
      return 'hashed-password';
    });

    const input = { password: 'Str0ng!Passw0rd', phone: '+15550123' };
    await expect(caller().accept({ ...input, token: 'raw-token' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: INVITATION_GENERIC_MESSAGE,
    });
    expect(row.acceptedAt).toBeNull();
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();

    await expect(caller().accept({ ...input, token: 'resent-token' })).resolves.toEqual({
      email: pendingInvitation.user.email,
    });
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(mocks.userUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: pendingInvitation.userId, status: 'INVITED' },
      data: expect.objectContaining({ password: 'hashed-password', status: 'ACTIVE' }),
    });

    await expect(caller().accept({ ...input, token: 'resent-token' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: INVITATION_GENERIC_MESSAGE,
    });
    expect(mocks.userUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('accepts an unchanged invitation and preserves the invitee profile fields', async () => {
    await expect(
      caller().accept({
        token: 'raw-token',
        password: 'Str0ng!Passw0rd',
        phone: '+15550123',
        bio: 'Hello',
        skills: ['TypeScript'],
      })
    ).resolves.toEqual({ email: pendingInvitation.user.email });
    expect(mocks.userUpdateMany).toHaveBeenCalledWith({
      where: { id: pendingInvitation.userId, status: 'INVITED' },
      data: {
        password: 'hashed-password',
        status: 'ACTIVE',
        phone: '+15550123',
        bio: 'Hello',
        skills: ['TypeScript'],
      },
    });
  });
});
