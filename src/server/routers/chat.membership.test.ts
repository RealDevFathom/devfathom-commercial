/**
 * DEV-1055: editing or deleting a chat message needs CURRENT channel membership,
 * not just authorship. A member removed from a channel can no longer read it, so
 * they must not be able to rewrite or erase what the remaining members see.
 * Workspace administrators keep moderation of non-DM channels.
 *
 * Runs the REAL router against a small in-memory db; only platform middleware
 * dependencies, realtime fan-out and notifications are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  messageFindUnique: vi.fn(),
  messageCreate: vi.fn(),
  messageUpdate: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  mentionFindMany: vi.fn(),
  mentionDeleteMany: vi.fn(),
  editCreate: vi.fn(),
  transaction: vi.fn(),
  emitToChannel: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/realtime-emit', () => ({
  emitToChannel: mocks.emitToChannel,
  emitToUser: vi.fn(),
}));
vi.mock('./chat-helpers', () => ({
  messageInclude: {},
  channelListInclude: {},
  toChatMessage: vi.fn((row: { id: string }) => ({ id: row?.id })),
  toChatChannel: vi.fn(),
  toUserLite: vi.fn(),
  aggregateReactions: vi.fn(),
}));

import { chatRouter } from './chat';
import type { TRPCContext } from '../trpc';

const db = {
  message: {
    findUnique: mocks.messageFindUnique,
    update: mocks.messageUpdate,
    create: mocks.messageCreate,
  },
  channelMember: { findUnique: mocks.memberFindUnique, findMany: mocks.memberFindMany },
  messageMention: { findMany: mocks.mentionFindMany, deleteMany: mocks.mentionDeleteMany },
  messageEdit: { create: mocks.editCreate },
  $transaction: mocks.transaction,
};

function caller(user: { id: string; role: 'ADMIN' | 'EMPLOYEE' }) {
  return chatRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['chat'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { ...user, department: 'OPERATIONS', status: 'ACTIVE', name: 'Sam' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const author = { id: 'user_author', role: 'EMPLOYEE' as const };
let members: Set<string>;
let channelType: 'PUBLIC' | 'DM';

beforeEach(() => {
  vi.clearAllMocks();
  members = new Set(['user_author']);
  channelType = 'PUBLIC';
  mocks.messageFindUnique.mockImplementation(async () => ({
    id: 'msg_1',
    senderId: 'user_author',
    channelId: 'chan_1',
    deletedAt: null,
    content: 'original',
    contentJson: null,
    channel: { type: channelType },
  }));
  mocks.memberFindUnique.mockImplementation(
    async ({ where }: { where: { channelId_userId: { channelId: string; userId: string } } }) =>
      where.channelId_userId.channelId === 'chan_1' && members.has(where.channelId_userId.userId)
        ? { id: 'member_1', role: 'MEMBER' }
        : null
  );
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.mentionFindMany.mockResolvedValue([]);
  mocks.transaction.mockResolvedValue([]);
  mocks.messageUpdate.mockResolvedValue({ id: 'msg_1' });
});

describe('DEV-1055: chat edit and delete require current channel membership', () => {
  it('lets a current member edit and delete their own message', async () => {
    await expect(
      caller(author).editMessage({ messageId: 'msg_1', content: 'fixed typo' })
    ).resolves.toBeDefined();
    expect(mocks.transaction).toHaveBeenCalledOnce();

    await expect(caller(author).deleteMessage({ messageId: 'msg_1' })).resolves.toEqual({
      id: 'msg_1',
    });
    expect(mocks.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'msg_1' } })
    );
  });

  it('refuses an edit by the author after they were removed from the channel', async () => {
    members.clear();

    await expect(
      caller(author).editMessage({ messageId: 'msg_1', content: 'rewritten after removal' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You are not a member of this channel',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.messageUpdate).not.toHaveBeenCalled();
    expect(mocks.emitToChannel).not.toHaveBeenCalled();
  });

  it('refuses a delete by the author after they were removed from the channel', async () => {
    members.clear();

    await expect(caller(author).deleteMessage({ messageId: 'msg_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You are not a member of this channel',
    });
    expect(mocks.messageUpdate).not.toHaveBeenCalled();
    expect(mocks.emitToChannel).not.toHaveBeenCalled();
  });

  it('keeps administrator moderation of a non-DM channel they are not a member of', async () => {
    await expect(
      caller({ id: 'user_admin', role: 'ADMIN' }).deleteMessage({ messageId: 'msg_1' })
    ).resolves.toEqual({ id: 'msg_1' });
    expect(mocks.messageUpdate).toHaveBeenCalledOnce();
  });

  it('never lets an administrator delete inside a DM, member or not', async () => {
    channelType = 'DM';
    await expect(
      caller({ id: 'user_admin', role: 'ADMIN' }).deleteMessage({ messageId: 'msg_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.messageUpdate).not.toHaveBeenCalled();
  });

  it("does not let an administrator edit someone else's message", async () => {
    members.add('user_admin');
    await expect(
      caller({ id: 'user_admin', role: 'ADMIN' }).editMessage({
        messageId: 'msg_1',
        content: 'words put in their mouth',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('caps edited content at 8000 characters, plain or rich text', async () => {
    await expect(
      caller(author).editMessage({ messageId: 'msg_1', content: 'x'.repeat(8001) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller(author).editMessage({
        messageId: 'msg_1',
        contentJson: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(8001) }] }],
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.transaction).not.toHaveBeenCalled();

    await expect(
      caller(author).editMessage({ messageId: 'msg_1', content: 'x'.repeat(8000) })
    ).resolves.toBeDefined();
  });

  it('caps text derived from rich content at 8000 characters on send too', async () => {
    const rich = (length: number) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(length) }] }],
    });

    await expect(
      caller(author).sendMessage({ channelId: 'chan_1', contentJson: rich(8001) })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A message can be at most 8000 characters.',
    });
    await expect(
      caller(author).sendMessage({ channelId: 'chan_1', content: 'x'.repeat(8001) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });
});
