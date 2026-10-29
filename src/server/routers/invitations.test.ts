import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const db = {
  invitation: {
    findUnique: mocks.invitationFindUnique,
    updateMany: mocks.invitationUpdateMany,
  },
  user: { updateMany: mocks.userUpdateMany },
  $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
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
});
