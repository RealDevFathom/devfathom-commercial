import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hash: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: mocks.hash }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));

import { hashInviteToken } from '@/lib/invite-token';
import { INVITATION_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';
import { invitationsRouter } from './invitations';

const oldToken = 'old-invitation-token';
const newTokenHash = hashInviteToken('replacement-invitation-token');
const invitation = {
  id: 'invitation_1',
  userId: 'user_1',
  email: 'invitee@example.test',
  tokenHash: hashInviteToken(oldToken),
  acceptedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  user: {
    id: 'user_1',
    name: 'Invitee',
    email: 'invitee@example.test',
    title: 'Engineer',
    department: 'ENGINEERING',
    role: 'EMPLOYEE',
    organization: { isDemo: false },
  },
};

describe('invitations.accept during resend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not let an old-token request claim the row after its token is replaced', async () => {
    let persistedTokenHash = invitation.tokenHash;
    let finishHash!: (hash: string) => void;
    const hashing = new Promise<string>((resolve) => {
      finishHash = resolve;
    });

    mocks.findUnique.mockResolvedValue(invitation);
    mocks.hash.mockReturnValue(hashing);
    mocks.updateMany.mockImplementation(async ({
      where,
    }: {
      where: {
        id: string;
        tokenHash?: string;
        acceptedAt: null;
        expiresAt: { gt: Date };
      };
    }) => ({
      count:
        where.id === invitation.id &&
        where.tokenHash === persistedTokenHash &&
        where.acceptedAt === null &&
        where.expiresAt.gt < invitation.expiresAt
          ? 1
          : 0,
    }));

    const db = {
      invitation: { findUnique: mocks.findUnique },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          invitation: { updateMany: mocks.updateMany },
          user: { update: mocks.userUpdate },
        }),
    };
    const caller = invitationsRouter.createCaller({ db } as never);

    const accepting = caller.accept({
      token: oldToken,
      password: 'Str0ng!Passw0rd',
      phone: '+15550000000',
    });
    await vi.waitFor(() => expect(mocks.hash).toHaveBeenCalledOnce());

    // A resend updates this same invitation row while bcrypt is still running.
    const rejected = expect(accepting).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: INVITATION_GENERIC_MESSAGE,
    });
    persistedTokenHash = newTokenHash;
    finishHash('hashed-password');

    await rejected;
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ tokenHash: invitation.tokenHash }),
      data: { acceptedAt: expect.any(Date) },
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('still claims the invitation when its token has not been replaced', async () => {
    mocks.findUnique.mockResolvedValue(invitation);
    mocks.hash.mockResolvedValue('hashed-password');
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.userUpdate.mockResolvedValue({});

    const db = {
      invitation: { findUnique: mocks.findUnique },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          invitation: { updateMany: mocks.updateMany },
          user: { update: mocks.userUpdate },
        }),
    };
    const caller = invitationsRouter.createCaller({ db } as never);

    await expect(
      caller.accept({
        token: oldToken,
        password: 'Str0ng!Passw0rd',
        phone: '+15550000000',
      })
    ).resolves.toEqual({ email: invitation.user.email });

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: invitation.id,
        tokenHash: invitation.tokenHash,
        acceptedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { acceptedAt: expect.any(Date) },
    });
    expect(mocks.userUpdate).toHaveBeenCalledOnce();
  });
});
