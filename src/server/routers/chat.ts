import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { router, protectedProcedure } from '../trpc';
import { assertChannelMember } from '../authz';
import { assertInOrganization, workspaceId } from '../org-refs';
import { notify } from '@/lib/notifications';
import { emitToChannel, emitToUser } from '@/lib/realtime-emit';
import { tiptapToPlainText, extractMentionIds } from '@/lib/chat/tiptap';
import { RT, MESSAGE_PAGE_SIZE } from '@/lib/chat/contract';
import {
  messageInclude,
  channelListInclude,
  toChatMessage,
  toChatChannel,
  toUserLite,
  aggregateReactions,
  type MessageRow,
} from './chat-helpers';

// Message include with the current user's save state folded in.
const msgIncludeFor = (userId: string) => ({
  ...messageInclude,
  savedBy: { where: { userId }, select: { id: true } },
});

const loadMessage = (db: PrismaClient, id: string, userId: string) =>
  db.message.findUnique({ where: { id }, include: msgIncludeFor(userId) });

/** OWNER/ADMIN of the channel, or an app ADMIN. */
async function canManageChannel(
  db: PrismaClient,
  channelId: string,
  userId: string,
  role?: string | null
): Promise<boolean> {
  const m = await db.channelMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
    select: { role: true },
  });
  if (m && (m.role === 'OWNER' || m.role === 'ADMIN')) return true;
  // App admins may moderate non-DM channels, but DMs stay private even from
  // admins — preserving the authz-keystone invariant (no admin DM override).
  if (role === 'ADMIN') {
    const ch = await db.channel.findUnique({ where: { id: channelId }, select: { type: true } });
    return !!ch && ch.type !== 'DM';
  }
  return false;
}

/** The longest plain-text message body, on send and on edit. */
const MAX_MESSAGE_LENGTH = 8000;

const attachmentInput = z.object({
  name: z.string(),
  url: z.string(),
  type: z.string().nullish(),
  size: z.number().nullish(),
  // Playback length in ms — supplied for audio/voice attachments only.
  duration: z.number().int().nonnegative().nullish(),
});

export const chatRouter = router({
  // ===== Queries ===========================================================
  getChannels: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.user.id;
    const channels = await ctx.db.channel.findMany({
      where: { isArchived: false, members: { some: { userId: me } } },
      include: channelListInclude,
      orderBy: { updatedAt: 'desc' },
    });
    return Promise.all(
      channels.map(async (ch) => {
        const myMember = ch.members.find((m) => m.userId === me);
        const since = myMember?.lastReadAt ?? new Date(0);
        const [unreadCount, mentionCount] = await Promise.all([
          ctx.db.message.count({
            where: {
              channelId: ch.id,
              deletedAt: null,
              senderId: { not: me },
              createdAt: { gt: since },
            },
          }),
          ctx.db.messageMention.count({
            where: {
              userId: me,
              message: { channelId: ch.id, deletedAt: null, createdAt: { gt: since } },
            },
          }),
        ]);
        return toChatChannel(ch, me, unreadCount, mentionCount);
      })
    );
  }),

  getMessages: protectedProcedure
    .input(z.object({ channelId: z.string(), cursor: z.string().nullish() }))
    .query(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const me = ctx.session.user.id;
      const rows = await ctx.db.message.findMany({
        where: { channelId: input.channelId, parentId: null },
        include: msgIncludeFor(me),
        // Tie-break on id so paging is deterministic when createdAt collides.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MESSAGE_PAGE_SIZE + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > MESSAGE_PAGE_SIZE;
      if (hasMore) rows.pop();
      const nextCursor = hasMore ? (rows[rows.length - 1]?.id ?? null) : null;
      const items = rows.reverse().map((m) => toChatMessage(m as MessageRow, me));
      return { items, nextCursor };
    }),

  getThread: protectedProcedure
    .input(z.object({ parentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const parent = await loadMessage(ctx.db, input.parentId, me);
      if (!parent) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
      await assertChannelMember(ctx, parent.channelId);
      const replies = await ctx.db.message.findMany({
        where: { parentId: input.parentId },
        include: msgIncludeFor(me),
        orderBy: { createdAt: 'asc' },
      });
      return {
        parent: toChatMessage(parent as MessageRow, me),
        replies: replies.map((r) => toChatMessage(r as MessageRow, me)),
      };
    }),

  // RT-02: prior-version snapshots for a message, newest-first. Channel-membership
  // gated, so only people who can see the message can read its edit history.
  getMessageEditHistory: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .query(async ({ ctx, input }) => {
      const msg = await ctx.db.message.findUnique({
        where: { id: input.messageId },
        select: { channelId: true, content: true, editedAt: true },
      });
      if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
      await assertChannelMember(ctx, msg.channelId);
      const edits = await ctx.db.messageEdit.findMany({
        where: { messageId: input.messageId },
        select: { id: true, previousContent: true, editedAt: true },
        orderBy: { editedAt: 'desc' },
      });
      return { current: msg.content, currentEditedAt: msg.editedAt, edits };
    }),

  searchMessages: protectedProcedure
    .input(z.object({ query: z.string().min(1), channelId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      if (input.channelId) await assertChannelMember(ctx, input.channelId);
      const rows = await ctx.db.message.findMany({
        where: {
          deletedAt: null,
          content: { contains: input.query, mode: 'insensitive' },
          channel: input.channelId
            ? { id: input.channelId }
            : { members: { some: { userId: me } } },
        },
        include: msgIncludeFor(me),
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return rows.map((m) => toChatMessage(m as MessageRow, me));
    }),

  getPins: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const me = ctx.session.user.id;
      const pins = await ctx.db.pinnedMessage.findMany({
        where: { channelId: input.channelId },
        orderBy: { createdAt: 'desc' },
        include: { message: { include: msgIncludeFor(me) } },
      });
      return pins.map((p) => toChatMessage(p.message as MessageRow, me));
    }),

  getSaved: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.user.id;
    const saved = await ctx.db.savedMessage.findMany({
      // Only surface saves whose channel the user is STILL a member of, so a
      // save can't leak message content after the user leaves / is removed.
      where: { userId: me, message: { channel: { members: { some: { userId: me } } } } },
      orderBy: { createdAt: 'desc' },
      include: { message: { include: msgIncludeFor(me) } },
    });
    return saved.map((s) => toChatMessage(s.message as MessageRow, me));
  }),

  getMembers: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const members = await ctx.db.channelMember.findMany({
        where: { channelId: input.channelId },
        include: { user: { select: { id: true, name: true, avatar: true, title: true } } },
      });
      return members.map((m) => ({
        ...toUserLite(m.user),
        role: m.role,
        presence: 'offline' as const,
      }));
    }),

  getMentionTargets: protectedProcedure
    .input(z.object({ channelId: z.string(), q: z.string().default('') }))
    .query(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const members = await ctx.db.channelMember.findMany({
        where: {
          channelId: input.channelId,
          ...(input.q ? { user: { name: { contains: input.q, mode: 'insensitive' } } } : {}),
        },
        include: { user: { select: { id: true, name: true, avatar: true, title: true } } },
        take: 8,
      });
      return members.map((m) => toUserLite(m.user));
    }),

  browseChannels: protectedProcedure
    .input(z.object({ q: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const channels = await ctx.db.channel.findMany({
        where: {
          isArchived: false,
          isPrivate: false,
          type: { not: 'DM' },
          members: { none: { userId: me } },
          ...(input.q ? { name: { contains: input.q, mode: 'insensitive' } } : {}),
        },
        include: channelListInclude,
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });
      return channels.map((ch) => toChatChannel(ch, me));
    }),

  // ===== Mutations =========================================================
  sendMessage: protectedProcedure
    .input(
      z.object({
        channelId: z.string(),
        content: z.string().max(MAX_MESSAGE_LENGTH).default(''),
        contentJson: z.any().optional(),
        mentionIds: z.array(z.string()).optional(),
        parentId: z.string().optional(),
        attachments: z.array(attachmentInput).max(20).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const me = ctx.session.user.id;
      // A reply's parent must live in the SAME channel (no cross-channel thread injection).
      if (input.parentId) {
        const parent = await ctx.db.message.findUnique({
          where: { id: input.parentId },
          select: { channelId: true, deletedAt: true },
        });
        if (!parent || parent.channelId !== input.channelId || parent.deletedAt) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid thread parent' });
        }
      }
      // Attachment URLs must be ones our upload route issued — no arbitrary/external URLs.
      if (input.attachments?.some((a) => !a.url.startsWith('/uploads/'))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid attachment URL' });
      }
      // Authoritative server-side derivation — never trust client content/mentions.
      const content = input.contentJson ? tiptapToPlainText(input.contentJson) : input.content;
      const rawMentions = input.contentJson
        ? extractMentionIds(input.contentJson)
        : (input.mentionIds ?? []);
      if (!content.trim() && !input.attachments?.length) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Message is empty' });
      }
      const validMentions = rawMentions.length
        ? (
            await ctx.db.channelMember.findMany({
              where: { channelId: input.channelId, userId: { in: rawMentions } },
              select: { userId: true },
            })
          )
            .map((m) => m.userId)
            .filter((id) => id !== me)
        : [];

      const created = await ctx.db.message.create({
        data: {
          content,
          contentJson: input.contentJson ?? undefined,
          channelId: input.channelId,
          senderId: me,
          parentId: input.parentId,
          attachments: input.attachments?.length
            ? {
                create: input.attachments.map((a) => ({
                  name: a.name,
                  url: a.url,
                  type: a.type ?? null,
                  size: a.size ?? null,
                  duration: a.duration ?? null,
                })),
              }
            : undefined,
          mentions: validMentions.length
            ? { create: validMentions.map((userId) => ({ userId })) }
            : undefined,
        },
        include: msgIncludeFor(me),
      });
      // Fire-and-forget: bumping updatedAt only re-sorts the sidebar; don't make
      // the sender wait an extra DB round-trip for it.
      void ctx.db.channel
        .update({ where: { id: input.channelId }, data: { updatedAt: new Date() } })
        .catch(() => {});

      const message = toChatMessage(created as MessageRow, me);
      // Top-level messages hit the channel timeline; replies only update their
      // thread, so a thread reply doesn't mark the whole channel unread or
      // overwrite the sidebar preview.
      if (input.parentId) {
        emitToChannel(input.channelId, RT.THREAD_REPLY, {
          channelId: input.channelId,
          parentId: input.parentId,
          message,
          replyCount: message.replyCount,
        });
      } else {
        emitToChannel(input.channelId, RT.MESSAGE_NEW, { channelId: input.channelId, message });
      }
      if (validMentions.length) {
        const title = `${created.sender.name} mentioned you`;
        const preview = content.slice(0, 140);
        notify(ctx.db, validMentions, {
          type: 'mention',
          title,
          message: preview,
          entityType: 'Message',
          entityId: created.id,
        });
        for (const uid of validMentions) {
          emitToUser(uid, RT.NOTIFICATION, {
            id: created.id,
            title,
            message: preview,
            type: 'mention',
            entityType: 'Message',
            entityId: created.id,
          });
        }
      }
      return message;
    }),

  editMessage: protectedProcedure
    .input(
      z.object({
        messageId: z.string(),
        // DEV-1055: the same cap as sendMessage, so an edit cannot grow a message.
        content: z.string().max(MAX_MESSAGE_LENGTH).default(''),
        contentJson: z.any().optional(),
        mentionIds: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const existing = await ctx.db.message.findUnique({
        where: { id: input.messageId },
        // RT-02: also grab the current content so we can snapshot it before overwrite.
        select: {
          senderId: true,
          channelId: true,
          deletedAt: true,
          content: true,
          contentJson: true,
        },
      });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
      if (existing.senderId !== me)
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only edit your own messages' });
      // DEV-1055: authorship alone is not enough. Someone removed from the channel
      // can no longer read it, so they may not rewrite what its members see either.
      await assertChannelMember(ctx, existing.channelId);
      if (existing.deletedAt)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot edit a deleted message' });

      const content = input.contentJson ? tiptapToPlainText(input.contentJson) : input.content;
      // The rich-text path derives its text on the server, so cap that too.
      if (content.length > MAX_MESSAGE_LENGTH) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `A message can be at most ${MAX_MESSAGE_LENGTH} characters.`,
        });
      }
      const rawMentions = input.contentJson
        ? extractMentionIds(input.contentJson)
        : (input.mentionIds ?? []);
      const validMentions = rawMentions.length
        ? (
            await ctx.db.channelMember.findMany({
              where: { channelId: existing.channelId, userId: { in: rawMentions } },
              select: { userId: true },
            })
          ).map((m) => m.userId)
        : [];

      // RT-04: capture the pre-edit mention set so we can notify only the people
      // NEWLY @mentioned by this edit (the transaction below replaces them).
      const priorMentions = await ctx.db.messageMention.findMany({
        where: { messageId: input.messageId },
        select: { userId: true },
      });
      const priorMentionSet = new Set(priorMentions.map((m) => m.userId));

      await ctx.db.$transaction([
        ctx.db.messageMention.deleteMany({ where: { messageId: input.messageId } }),
        // RT-02: snapshot the pre-edit content so the edit history is reconstructable.
        ctx.db.messageEdit.create({
          data: {
            messageId: input.messageId,
            previousContent: existing.content,
            previousContentJson: existing.contentJson ?? undefined,
          },
        }),
        ctx.db.message.update({
          where: { id: input.messageId },
          data: {
            content,
            contentJson: input.contentJson ?? undefined,
            isEdited: true,
            editedAt: new Date(),
            mentions: validMentions.length
              ? { create: validMentions.map((userId) => ({ userId })) }
              : undefined,
          },
        }),
      ]);
      const reloaded = await loadMessage(ctx.db, input.messageId, me);
      const message = toChatMessage(reloaded as MessageRow, me);
      emitToChannel(existing.channelId, RT.MESSAGE_UPDATE, {
        channelId: existing.channelId,
        message,
      });

      // RT-04: notify people newly @mentioned by this edit (mirrors sendMessage,
      // which only fired for mentions present at create time).
      const newlyMentioned = validMentions.filter((uid) => !priorMentionSet.has(uid) && uid !== me);
      if (newlyMentioned.length) {
        const senderName = ctx.session.user.name ?? 'Someone';
        const title = `${senderName} mentioned you`;
        const preview = content.slice(0, 140);
        notify(ctx.db, newlyMentioned, {
          type: 'mention',
          title,
          message: preview,
          entityType: 'Message',
          entityId: input.messageId,
        });
        for (const uid of newlyMentioned) {
          emitToUser(uid, RT.NOTIFICATION, {
            id: input.messageId,
            title,
            message: preview,
            type: 'mention',
            entityType: 'Message',
            entityId: input.messageId,
          });
        }
      }
      return message;
    }),

  deleteMessage: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const existing = await ctx.db.message.findUnique({
        where: { id: input.messageId },
        select: { senderId: true, channelId: true, channel: { select: { type: true } } },
      });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
      // App admins may moderate non-DM channels, but never DMs (DM privacy holds
      // even for admins). Everyone else deletes only their own messages, and only
      // while they are still a member of the channel (DEV-1055).
      const canModerate = ctx.session.user.role === 'ADMIN' && existing.channel.type !== 'DM';
      if (!canModerate) {
        if (existing.senderId !== me) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You can only delete your own messages',
          });
        }
        await assertChannelMember(ctx, existing.channelId);
      }
      await ctx.db.message.update({
        where: { id: input.messageId },
        data: { deletedAt: new Date(), content: '', contentJson: undefined },
      });
      emitToChannel(existing.channelId, RT.MESSAGE_DELETE, {
        channelId: existing.channelId,
        messageId: input.messageId,
      });
      return { id: input.messageId };
    }),

  toggleReaction: protectedProcedure
    .input(z.object({ messageId: z.string(), emoji: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const msg = await ctx.db.message.findUnique({
        where: { id: input.messageId },
        select: { channelId: true },
      });
      if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
      await assertChannelMember(ctx, msg.channelId);
      const existing = await ctx.db.messageReaction.findUnique({
        where: {
          messageId_userId_emoji: { messageId: input.messageId, userId: me, emoji: input.emoji },
        },
        select: { id: true },
      });
      if (existing) await ctx.db.messageReaction.delete({ where: { id: existing.id } });
      else
        await ctx.db.messageReaction.create({
          data: { messageId: input.messageId, userId: me, emoji: input.emoji },
        });
      const rows = await ctx.db.messageReaction.findMany({
        where: { messageId: input.messageId },
        select: { emoji: true, userId: true },
      });
      const reactions = aggregateReactions(rows, me);
      emitToChannel(msg.channelId, RT.REACTION, {
        channelId: msg.channelId,
        messageId: input.messageId,
        reactions,
      });
      return reactions;
    }),

  markRead: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const me = ctx.session.user.id;
      const now = new Date();
      await ctx.db.channelMember.update({
        where: { channelId_userId: { channelId: input.channelId, userId: me } },
        data: { lastReadAt: now },
      });
      // RT-09: a read receipt is the actor's OWN state — emit it to their personal
      // room (syncs their other tabs) instead of broadcasting everyone's read times
      // to the whole channel, where any subscriber could observe them.
      emitToUser(me, RT.READ, {
        channelId: input.channelId,
        userId: me,
        lastReadAt: now.toISOString(),
      });
      return { lastReadAt: now.toISOString() };
    }),

  createChannel: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        topic: z.string().optional(),
        type: z.enum(['GROUP', 'PROJECT']).default('GROUP'),
        isPrivate: z.boolean().default(true),
        memberIds: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const others = [...new Set(input.memberIds)].filter((id) => id !== me);
      await assertInOrganization(ctx.db.user, workspaceId(ctx), [me, ...others]);
      const ch = await ctx.db.channel.create({
        data: {
          name: input.name,
          description: input.description,
          topic: input.topic,
          type: input.type,
          isPrivate: input.isPrivate,
          createdById: me,
          members: {
            create: [
              { userId: me, role: 'OWNER' },
              ...others.map((userId) => ({ userId, role: 'MEMBER' })),
            ],
          },
        },
        include: channelListInclude,
      });
      return toChatChannel(ch, me);
    }),

  updateChannel: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        topic: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await canManageChannel(ctx.db, input.id, ctx.session.user.id, ctx.session.user.role)))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only channel admins can edit this channel',
        });
      const { id, ...data } = input;
      const ch = await ctx.db.channel.update({ where: { id }, data, include: channelListInclude });
      return toChatChannel(ch, ctx.session.user.id);
    }),

  archiveChannel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!(await canManageChannel(ctx.db, input.id, ctx.session.user.id, ctx.session.user.role)))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only channel admins can archive this channel',
        });
      await ctx.db.channel.update({ where: { id: input.id }, data: { isArchived: true } });
      return { id: input.id };
    }),

  deleteChannel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!(await canManageChannel(ctx.db, input.id, ctx.session.user.id, ctx.session.user.role)))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only channel admins can delete this channel',
        });
      await ctx.db.channel.delete({ where: { id: input.id } });
      return { id: input.id };
    }),

  joinChannel: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const ch = await ctx.db.channel.findUnique({
        where: { id: input.channelId },
        select: { isPrivate: true, type: true },
      });
      if (!ch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Channel not found' });
      if (ch.isPrivate || ch.type === 'DM')
        throw new TRPCError({ code: 'FORBIDDEN', message: 'This channel is private' });
      await ctx.db.channelMember.upsert({
        where: { channelId_userId: { channelId: input.channelId, userId: me } },
        create: { channelId: input.channelId, userId: me, role: 'MEMBER' },
        update: {},
      });
      return { channelId: input.channelId };
    }),

  leaveChannel: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.channelMember.deleteMany({
        where: { channelId: input.channelId, userId: ctx.session.user.id },
      });
      // RT-02: tell the user's other tabs to drop this channel's live subscription.
      emitToUser(ctx.session.user.id, RT.MEMBERSHIP_CHANGED, { channelId: input.channelId });
      return { channelId: input.channelId };
    }),

  addMembers: protectedProcedure
    .input(z.object({ channelId: z.string(), userIds: z.array(z.string()).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.db.channel.findUnique({
        where: { id: input.channelId },
        select: { type: true },
      });
      if (!channel) throw new TRPCError({ code: 'NOT_FOUND', message: 'Channel not found' });
      if (channel.type === 'DM')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot add members to a direct message',
        });
      if (
        !(await canManageChannel(
          ctx.db,
          input.channelId,
          ctx.session.user.id,
          ctx.session.user.role
        ))
      )
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only channel admins can add members' });
      await assertInOrganization(ctx.db.user, workspaceId(ctx), input.userIds);
      await ctx.db.channelMember.createMany({
        data: input.userIds.map((userId) => ({
          channelId: input.channelId,
          userId,
          role: 'MEMBER',
        })),
        skipDuplicates: true,
      });
      return { channelId: input.channelId };
    }),

  removeMember: protectedProcedure
    .input(z.object({ channelId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      if (
        input.userId !== me &&
        !(await canManageChannel(ctx.db, input.channelId, me, ctx.session.user.role))
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only channel admins can remove members',
        });
      await ctx.db.channelMember.deleteMany({
        where: { channelId: input.channelId, userId: input.userId },
      });
      // RT-02: immediately cut the removed member's live stream — their client
      // refetches channels (dropping this one's subscription) and re-authorizes
      // Ably, instead of keeping live events until the next ~hourly token renewal.
      emitToUser(input.userId, RT.MEMBERSHIP_CHANGED, { channelId: input.channelId });
      return { channelId: input.channelId };
    }),

  createOrGetDM: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      if (input.userId === me)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot DM yourself' });
      await assertInOrganization(ctx.db.user, workspaceId(ctx), [input.userId]);
      const candidates = await ctx.db.channel.findMany({
        where: {
          type: 'DM',
          AND: [
            { members: { some: { userId: me } } },
            { members: { some: { userId: input.userId } } },
          ],
        },
        include: { ...channelListInclude, _count: { select: { members: true } } },
      });
      let dm = candidates.find((c) => c._count.members === 2) ?? null;
      if (!dm) {
        dm = await ctx.db.channel.create({
          data: {
            type: 'DM',
            isPrivate: true,
            createdById: me,
            members: {
              create: [
                { userId: me, role: 'MEMBER' },
                { userId: input.userId, role: 'MEMBER' },
              ],
            },
          },
          include: { ...channelListInclude, _count: { select: { members: true } } },
        });
      }
      return toChatChannel(dm, me);
    }),

  togglePin: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const msg = await ctx.db.message.findUnique({
        where: { id: input.messageId },
        select: { channelId: true },
      });
      if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
      await assertChannelMember(ctx, msg.channelId);
      const existing = await ctx.db.pinnedMessage.findUnique({
        where: { messageId: input.messageId },
        select: { id: true },
      });
      let isPinned: boolean;
      if (existing) {
        await ctx.db.pinnedMessage.delete({ where: { id: existing.id } });
        isPinned = false;
      } else {
        await ctx.db.pinnedMessage.create({
          data: { messageId: input.messageId, channelId: msg.channelId, pinnedById: me },
        });
        isPinned = true;
      }
      const reloaded = await loadMessage(ctx.db, input.messageId, me);
      if (reloaded)
        emitToChannel(msg.channelId, RT.MESSAGE_UPDATE, {
          channelId: msg.channelId,
          message: toChatMessage(reloaded as MessageRow, me),
        });
      return { isPinned };
    }),

  toggleSave: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      // Membership check closes an IDOR: without it, saving an arbitrary message
      // id would expose its full contents (incl. private DMs) via getSaved.
      const msg = await ctx.db.message.findUnique({
        where: { id: input.messageId },
        select: { channelId: true },
      });
      if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
      await assertChannelMember(ctx, msg.channelId);
      const existing = await ctx.db.savedMessage.findUnique({
        where: { messageId_userId: { messageId: input.messageId, userId: me } },
        select: { id: true },
      });
      let isSaved: boolean;
      if (existing) {
        await ctx.db.savedMessage.delete({ where: { id: existing.id } });
        isSaved = false;
      } else {
        await ctx.db.savedMessage.create({ data: { messageId: input.messageId, userId: me } });
        isSaved = true;
      }
      return { isSaved };
    }),

  setMuted: protectedProcedure
    .input(z.object({ channelId: z.string(), muted: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      await ctx.db.channelMember.update({
        where: { channelId_userId: { channelId: input.channelId, userId: ctx.session.user.id } },
        data: { muted: input.muted },
      });
      return { muted: input.muted };
    }),
});
