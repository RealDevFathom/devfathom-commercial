import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hash: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: mocks.hash }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));

import { hashInviteToken } from '@/lib/invite-token';
import { INVITATION_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';
import { invitationsRouter } from './invitations';
import { router, type TRPCContext } from '../trpc';

const oldToken = 'old-invitation-token';
const newToken = 'replacement-invitation-token';

const invitation = {
  id: 'invitation_1',
  userId: 'user_1',
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

function caller() {
  const db = {
    invitation: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
    user: { update: mocks.userUpdate },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        invitation: { updateMany: mocks.updateMany },
        user: { update: mocks.userUpdate },
      }),
  };

  return router({ invitations: invitationsRouter }).createCaller({
    db,
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext).invitations;
}

describe('invitation acceptance across a resend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(invitation);
    mocks.hash.mockResolvedValue('password-hash');
    mocks.userUpdate.mockResolvedValue({});
  });

  it('does not let an old token claim the row after its token was replaced', async () => {
    const replacementHash = hashInviteToken(newToken);
    mocks.updateMany.mockImplementation(async ({ where }: { where: { tokenHash?: string } }) => ({
      count: where.tokenHash === replacementHash ? 1 : 0,
    }));

    await expect(
      caller().accept({
        token: oldToken,
        password: 'Str0ng!Passw0rd',
        phone: '+15550100',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: INVITATION_GENERIC_MESSAGE });

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: invitation.id,
        tokenHash: invitation.tokenHash,
        acceptedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { acceptedAt: expect.any(Date) },
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
