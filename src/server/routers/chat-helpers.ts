/**
 * Chat router helpers — Prisma include shapes + row → contract view-model
 * mappers. Kept beside the router so query includes and the mappers that read
 * them never drift apart.
 */
import { Prisma } from '@/generated/prisma/client';
import type {
  ChatMessage,
  ChatChannel,
  ChatReaction,
  ChatUserLite,
  ChannelKind,
  PresenceStatus,
  TiptapDoc,
} from '@/lib/chat/contract';

// --- includes --------------------------------------------------------------
/** Base message include (per-user `savedBy` is spread in at query time). */
export const messageInclude = {
  sender: { select: { id: true, name: true, avatar: true, title: true } },
  reactions: { select: { emoji: true, userId: true } },
  attachments: true,
  mentions: { select: { userId: true } },
  pins: { select: { id: true } },
  replies: {
    take: 3,
    orderBy: { createdAt: 'desc' as const },
    select: {
      createdAt: true,
      sender: { select: { id: true, name: true, avatar: true, title: true } },
    },
  },
  _count: { select: { replies: true } },
} satisfies Prisma.MessageInclude;

export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }> & {
  savedBy?: { id: string }[];
};

export const channelListInclude = {
  members: { include: { user: { select: { id: true, name: true, avatar: true, title: true } } } },
  messages: {
    take: 1,
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' as const },
    select: { content: true, createdAt: true },
  },
} satisfies Prisma.ChannelInclude;

export type ChannelRow = Prisma.ChannelGetPayload<{ include: typeof channelListInclude }>;

// --- mappers ---------------------------------------------------------------
export function toUserLite(u: {
  id: string;
  name: string;
  avatar: string | null;
  title?: string | null;
}): ChatUserLite {
  return { id: u.id, name: u.name, avatar: u.avatar, title: u.title ?? null };
}

export function aggregateReactions(
  rows: { emoji: string; userId: string }[],
  currentUserId: string
): ChatReaction[] {
  const byEmoji = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byEmoji.get(r.emoji) ?? [];
    arr.push(r.userId);
    byEmoji.set(r.emoji, arr);
  }
  return [...byEmoji.entries()].map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
    reactedByMe: userIds.includes(currentUserId),
  }));
}

export function toChatMessage(m: MessageRow, currentUserId: string): ChatMessage {
  const deleted = !!m.deletedAt;
  const participants = new Map<string, ChatUserLite>();
  for (const r of m.replies) {
    if (!participants.has(r.sender.id)) participants.set(r.sender.id, toUserLite(r.sender));
  }
  return {
    id: m.id,
    channelId: m.channelId,
    content: deleted ? '' : m.content,
    contentJson: deleted ? null : ((m.contentJson as TiptapDoc | null) ?? null),
    sender: toUserLite(m.sender),
    parentId: m.parentId,
    isEdited: m.isEdited,
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    reactions: deleted ? [] : aggregateReactions(m.reactions, currentUserId),
    attachments: deleted
      ? []
      : m.attachments.map((a) => ({
          id: a.id,
          name: a.name,
          url: a.url,
          type: a.type,
          size: a.size,
          duration: a.duration,
        })),
    mentionIds: m.mentions.map((x) => x.userId),
    replyCount: m._count.replies,
    lastReplyAt: m.replies[0]?.createdAt?.toISOString() ?? null,
    threadParticipants: [...participants.values()],
    isPinned: (m.pins?.length ?? 0) > 0,
    isSaved: (m.savedBy?.length ?? 0) > 0,
  };
}

export function toChatChannel(
  ch: ChannelRow,
  currentUserId: string,
  unreadCount = 0,
  mentionCount = 0
): ChatChannel {
  const myMember = ch.members.find((m) => m.userId === currentUserId);
  const others = ch.members.filter((m) => m.userId !== currentUserId);
  const isDM = ch.type === 'DM';
  const peer = isDM ? others[0]?.user : undefined;
  const last = ch.messages[0];
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type as ChannelKind,
    topic: ch.topic,
    description: ch.description,
    isPrivate: ch.isPrivate,
    isArchived: ch.isArchived,
    createdById: ch.createdById,
    memberCount: ch.members.length,
    members: ch.members.map((m) => ({
      ...toUserLite(m.user),
      role: m.role,
      presence: 'offline' as PresenceStatus,
    })),
    isDM,
    dmPeer: peer ? toUserLite(peer) : null,
    unreadCount,
    mentionCount,
    muted: myMember?.muted ?? false,
    lastReadAt: myMember?.lastReadAt?.toISOString() ?? null,
    lastMessagePreview: last?.content ?? null,
    lastMessageAt: last?.createdAt?.toISOString() ?? null,
  };
}
