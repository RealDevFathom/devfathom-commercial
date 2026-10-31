/**
 * CHAT domain tools for the DevFathom assistant — channels, messages, DMs.
 *
 * PRIVACY IS PARAMOUNT. The assistant may only read or act over channels the
 * acting user is a MEMBER of. Channel access is membership-only and is NOT
 * admin-overridable (see `authz.isChannelMember`), so private channels and DMs
 * stay private even when an admin is driving the assistant. Every read and
 * write below is gated on membership, and channel-name resolution searches ONLY
 * the user's own channels — message content from channels the user is not in is
 * never exposed.
 *
 * Each tool mirrors the equivalent `chat` tRPC mutation/query (input validation,
 * authorization, logic, and side effects — mention parsing, notifications,
 * realtime broadcast) so an assistant-driven action behaves identically to a
 * human one. Writes set `needsApproval: true`. Optional params are `.nullish()`
 * (NOT `.optional()`) — Groq/gpt-oss send `null` for omitted optionals.
 */
import { tool } from 'ai';
import { z } from 'zod';
import * as authz from '@/lib/authz';
import { emitToChannel, emitToUser } from '@/lib/realtime-emit';
import { RT } from '@/lib/chat/contract';
import { messageInclude, toChatMessage, type MessageRow } from '@/server/routers/chat-helpers';
import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';

export function buildChatTools(h: AssistantHelpers): ToolSet {
  const me = h.ctx.userId;

  // ── shared gates ──────────────────────────────────────────────────────────

  /**
   * Resolve a channel by name from ONLY the user's own non-DM channels. DMs
   * have no name (resolve those by person), and scoping the candidate pool to
   * the user's memberships means a name can never match a channel they're not
   * in — privacy holds before we even reach the membership gate.
   */
  async function resolveMyChannel(query: string) {
    const channels = await h.db.channel.findMany({
      where: { isArchived: false, type: { not: 'DM' }, members: { some: { userId: me } } },
      select: { id: true, name: true },
    });
    const rows = channels
      .filter((c): c is { id: string; name: string } => !!c.name)
      .map((c) => ({ id: c.id, name: c.name }));
    return h.resolveNamed(query, rows);
  }

  /**
   * Channel OWNER/ADMIN, or an app ADMIN — EXACTLY mirrors the chat router's
   * `canManageChannel`. App admins may manage non-DM channels, but never DMs.
   */
  async function canManageChannel(channelId: string): Promise<boolean> {
    const m = await h.db.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: me } },
      select: { role: true },
    });
    if (m && (m.role === 'OWNER' || m.role === 'ADMIN')) return true;
    if (h.isAdmin) {
      const ch = await h.db.channel.findUnique({
        where: { id: channelId },
        select: { type: true },
      });
      return !!ch && ch.type !== 'DM';
    }
    return false;
  }

  /** Find an existing 1:1 DM with `peerId`, or create one — mirrors createOrGetDM. */
  async function getOrCreateDM(peerId: string): Promise<string> {
    const candidates = await h.db.channel.findMany({
      where: {
        type: 'DM',
        AND: [{ members: { some: { userId: me } } }, { members: { some: { userId: peerId } } }],
      },
      select: { id: true, _count: { select: { members: true } } },
    });
    const existing = candidates.find((c) => c._count.members === 2);
    if (existing) return existing.id;
    const dm = await h.db.channel.create({
      data: {
        type: 'DM',
        isPrivate: true,
        createdById: me,
        members: {
          create: [
            { userId: me, role: 'MEMBER' },
            { userId: peerId, role: 'MEMBER' },
          ],
        },
      },
      select: { id: true },
    });
    return dm.id;
  }

  const tools: ToolSet = {
    // ─────────────────────────────────── READS ───────────────────────────────
    listChannels: tool({
      description:
        'List the chat channels YOU belong to — name, type, unread count, and how many unread messages @mention you. Use for "my channels", "what channels am I in", "where do I have unread messages", "am I mentioned anywhere".',
      inputSchema: z.object({}),
      execute: async () => {
        const channels = await h.db.channel.findMany({
          where: { isArchived: false, members: { some: { userId: me } } },
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            name: true,
            type: true,
            topic: true,
            members: {
              select: {
                userId: true,
                lastReadAt: true,
                muted: true,
                user: { select: { name: true } },
              },
            },
          },
        });
        return Promise.all(
          channels.map(async (ch) => {
            const mine = ch.members.find((m) => m.userId === me);
            const since = mine?.lastReadAt ?? new Date(0);
            const [unread, mentions] = await Promise.all([
              h.db.message.count({
                where: {
                  channelId: ch.id,
                  deletedAt: null,
                  senderId: { not: me },
                  createdAt: { gt: since },
                },
              }),
              h.db.messageMention.count({
                where: {
                  userId: me,
                  message: { channelId: ch.id, deletedAt: null, createdAt: { gt: since } },
                },
              }),
            ]);
            const isDM = ch.type === 'DM';
            const peer = isDM ? ch.members.find((m) => m.userId !== me)?.user.name : null;
            return {
              name: isDM ? (peer ?? 'Direct message') : ch.name,
              type: ch.type,
              isDM,
              topic: isDM ? null : ch.topic,
              unread,
              mentions,
              muted: mine?.muted ?? false,
            };
          })
        );
      },
    }),

    searchMessages: tool({
      description:
        'Search chat messages by text, across only the channels YOU belong to (DMs included). Optionally scope to one named channel you are in. Use for "find the message about the launch", "search chat for the staging URL", "did anyone mention the budget".',
      inputSchema: z.object({
        query: z.string().min(1).describe('Text to search for in message content'),
        channel: z
          .string()
          .nullish()
          .describe('Optional: limit to one named channel you belong to'),
      }),
      execute: async ({ query, channel }) => {
        let channelId: string | undefined;
        let scopeNote: string | undefined;
        if (channel) {
          const r = await resolveMyChannel(channel);
          if (r.kind === 'notfound')
            return { error: `No channel matches "${channel}" that you are a member of.` };
          if (r.kind === 'ambiguous')
            return { needsClarification: `Which channel — ${r.candidates.join(', ')}?` };
          channelId = r.value.id;
          if (r.interpreted) scopeNote = `Interpreted "${channel}" as ${r.value.name}.`;
          // Belt + braces — resolution already scoped to the user's channels.
          if (!(await authz.isChannelMember(h.db, me, channelId)))
            return { error: 'You are not a member of that channel.' };
        }
        const rows = await h.db.message.findMany({
          where: {
            deletedAt: null,
            content: { contains: query, mode: 'insensitive' },
            // No channel given → restrict to channels the user is a member of.
            channel: channelId ? { id: channelId } : { members: { some: { userId: me } } },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            content: true,
            createdAt: true,
            sender: { select: { name: true } },
            channel: {
              select: {
                name: true,
                type: true,
                members: {
                  where: { userId: { not: me } },
                  select: { user: { select: { name: true } } },
                  take: 1,
                },
              },
            },
          },
        });
        return {
          count: rows.length,
          note: scopeNote,
          results: rows.map((m) => ({
            channel:
              m.channel.type === 'DM'
                ? `DM with ${m.channel.members[0]?.user.name ?? 'someone'}`
                : (m.channel.name ?? 'channel'),
            sender: m.sender.name,
            content: m.content.slice(0, 280),
            at: m.createdAt,
          })),
        };
      },
    }),

    getChannelMessages: tool({
      description:
        'Read the most recent messages in a named channel you belong to, oldest → newest, so you can summarize or catch up. Use for "what\'s the latest in #general", "catch me up on the design channel", "summarize #eng today". Give the channel name.',
      inputSchema: z.object({
        channel: z.string().describe('Channel name (fuzzy match), e.g. "general" or "#eng"'),
        limit: z
          .number()
          .int()
          .nullish()
          .describe('How many recent messages to fetch (default 30, max 50)'),
      }),
      execute: async ({ channel, limit }) => {
        const r = await resolveMyChannel(channel);
        if (r.kind === 'notfound')
          return { error: `No channel matches "${channel}" that you are a member of.` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which channel — ${r.candidates.join(', ')}?` };
        const channelId = r.value.id;
        // Belt + braces — resolution already scoped to the user's channels.
        if (!(await authz.isChannelMember(h.db, me, channelId)))
          return { error: 'You are not a member of that channel.' };

        const take = Math.min(Math.max(limit ?? 30, 1), 50);
        const rows = await h.db.message.findMany({
          where: { channelId, parentId: null, deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: { content: true, createdAt: true, sender: { select: { name: true } } },
        });
        const messages = rows
          .reverse()
          .map((m) => ({ sender: m.sender.name, content: m.content, at: m.createdAt }));
        return {
          channel: r.value.name,
          count: messages.length,
          messages,
          note: r.interpreted ? `Interpreted "${channel}" as ${r.value.name}.` : undefined,
        };
      },
    }),

    // ────────────────────────────────── WRITES ───────────────────────────────
    sendMessage: tool({
      description:
        'Post a message to a channel you belong to, OR direct-message a person. Give EITHER `channel` (a channel name) OR `toPerson` (a name) — not both. Use for "post in #general that the deploy is done", "tell the design channel ...", "DM Aisha that I\'ll be late". Optionally @-mention channel members by name to notify them.',
      inputSchema: z.object({
        channel: z.string().nullish().describe('Channel name to post in (a channel you belong to)'),
        toPerson: z
          .string()
          .nullish()
          .describe('A person to direct-message instead of posting in a channel'),
        text: z.string().describe('The message text to send'),
        mention: z
          .array(z.string())
          .nullish()
          .describe('Names of channel members to @-mention and notify'),
      }),
      needsApproval: true,
      execute: async ({ channel, toPerson, text, mention }) => {
        const content = (text ?? '').trim();
        if (!content) return { error: 'Message is empty.' };
        if (!channel && !toPerson)
          return { error: 'Tell me where to send it — a channel name or a person to DM.' };
        if (channel && toPerson)
          return { error: 'Send to either a channel or a person, not both.' };

        let channelId: string;
        let destination: string;
        let note: string | undefined;

        if (channel) {
          const r = await resolveMyChannel(channel);
          if (r.kind === 'notfound')
            return { error: `No channel matches "${channel}" that you are a member of.` };
          if (r.kind === 'ambiguous')
            return { needsClarification: `Which channel — ${r.candidates.join(', ')}?` };
          channelId = r.value.id;
          destination = `#${r.value.name}`;
          if (r.interpreted) note = `Interpreted "${channel}" as ${r.value.name}.`;
          // Authorize membership BEFORE writing (mirrors assertChannelMember).
          if (!(await authz.isChannelMember(h.db, me, channelId)))
            return { error: 'You are not a member of that channel.' };
        } else {
          const r = await h.resolvePerson(toPerson!);
          if (r.kind === 'notfound') return { error: `No team member matches "${toPerson}".` };
          if (r.kind === 'ambiguous')
            return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
          if (r.value.id === me) return { error: 'You cannot DM yourself.' };
          channelId = await getOrCreateDM(r.value.id);
          destination = `DM with ${r.value.name}`;
          if (r.interpreted) note = `Interpreted "${toPerson}" as ${r.value.name}.`;
        }

        // Mention parsing — only channel members may be mentioned (mirrors the
        // router's validMentions filter); self is never notified.
        let validMentions: string[] = [];
        const unresolvedMentions: string[] = [];
        if (mention?.length) {
          const members = await h.db.channelMember.findMany({
            where: { channelId },
            select: { userId: true, user: { select: { name: true } } },
          });
          const memberRows = members.map((m) => ({ id: m.userId, name: m.user.name }));
          const ids = new Set<string>();
          for (const nm of mention) {
            const res = h.resolveNamed(nm, memberRows);
            if (res.kind === 'resolved' && res.value.id !== me) ids.add(res.value.id);
            else unresolvedMentions.push(nm);
          }
          validMentions = [...ids];
        }

        const created = await h.db.message.create({
          data: {
            content,
            channelId,
            senderId: me,
            mentions: validMentions.length
              ? { create: validMentions.map((userId) => ({ userId })) }
              : undefined,
          },
          include: { ...messageInclude, savedBy: { where: { userId: me }, select: { id: true } } },
        });
        // Re-sort the sidebar (fire-and-forget — mirrors the router).
        void h.db.channel
          .update({ where: { id: channelId }, data: { updatedAt: new Date() } })
          .catch(() => {});

        const message = toChatMessage(created as MessageRow, me);
        emitToChannel(channelId, RT.MESSAGE_NEW, { channelId, message });

        if (validMentions.length) {
          const title = `${created.sender.name} mentioned you`;
          const preview = content.slice(0, 140);
          h.notifyUsers(validMentions, {
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

        h.audit({
          category: 'CHAT',
          action: 'sendMessage',
          operation: 'CREATE',
          description: `sent a message to ${destination}`,
          targetType: 'Message',
          targetId: created.id,
          metadata: { mentioned: validMentions.length },
        });

        return {
          sent: true,
          to: destination,
          mentioned: validMentions.length,
          unmentioned: unresolvedMentions.length ? unresolvedMentions : undefined,
          note,
        };
      },
    }),

    createChannel: tool({
      description:
        'Create a new chat channel and optionally add members. Use for "create a channel called launch-room", "make a private channel for the redesign with Aisha and Tom". Defaults to a PRIVATE (invite-only) channel; you are added as the owner.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Channel name, e.g. "design-review"'),
        visibility: z
          .enum(['PUBLIC', 'PRIVATE'])
          .nullish()
          .describe('PUBLIC = anyone can find and join; PRIVATE (default) = invite-only'),
        description: z.string().nullish(),
        topic: z.string().nullish(),
        members: z
          .array(z.string())
          .nullish()
          .describe('Names of people to add as members (you are added as owner automatically)'),
      }),
      needsApproval: true,
      execute: async ({ name, visibility, description, topic, members }) => {
        const isPrivate = visibility !== 'PUBLIC'; // default PRIVATE
        const memberIds = new Set<string>();
        const addedNames: string[] = [];
        if (members?.length) {
          for (const nm of members) {
            const r = await h.resolvePerson(nm);
            if (r.kind === 'notfound') return { error: `No team member matches "${nm}".` };
            if (r.kind === 'ambiguous')
              return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
            if (r.value.id !== me && !memberIds.has(r.value.id)) {
              memberIds.add(r.value.id);
              addedNames.push(r.value.name);
            }
          }
        }
        const others = [...memberIds];
        const ch = await h.db.channel.create({
          data: {
            name,
            description: description ?? undefined,
            topic: topic ?? undefined,
            type: 'GROUP',
            isPrivate,
            createdById: me,
            members: {
              create: [
                { userId: me, role: 'OWNER' },
                ...others.map((userId) => ({ userId, role: 'MEMBER' })),
              ],
            },
          },
          select: { id: true, name: true, isPrivate: true },
        });

        h.audit({
          category: 'CHAT',
          action: 'createChannel',
          operation: 'CREATE',
          description: `created channel "${ch.name ?? name}"`,
          targetType: 'Channel',
          targetId: ch.id,
          targetLabel: ch.name ?? name,
          metadata: { visibility: isPrivate ? 'PRIVATE' : 'PUBLIC', members: addedNames },
        });

        return {
          name: ch.name,
          visibility: ch.isPrivate ? 'PRIVATE' : 'PUBLIC',
          memberCount: others.length + 1,
          members: ['you', ...addedNames],
        };
      },
    }),

    addChannelMembers: tool({
      description:
        'Add people to a channel you belong to and can manage (you must be its owner/admin, or an app admin). Resolve people by name. Use for "add Aisha to #design", "invite Tom and Sara to the eng channel". DMs cannot have members added.',
      inputSchema: z.object({
        channel: z.string().describe('Channel name (a channel you belong to)'),
        members: z.array(z.string()).min(1).describe('Names of people to add'),
      }),
      needsApproval: true,
      execute: async ({ channel, members }) => {
        const r = await resolveMyChannel(channel);
        if (r.kind === 'notfound')
          return { error: `No channel matches "${channel}" that you are a member of.` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which channel — ${r.candidates.join(', ')}?` };
        const channelId = r.value.id;
        if (!(await canManageChannel(channelId)))
          return { error: 'Only the channel owner or an admin can add members.' };

        const ids = new Set<string>();
        const addedNames: string[] = [];
        for (const nm of members) {
          const pr = await h.resolvePerson(nm);
          if (pr.kind === 'notfound') return { error: `No team member matches "${nm}".` };
          if (pr.kind === 'ambiguous')
            return { needsClarification: `Which one — ${pr.candidates.join(', ')}?` };
          if (!ids.has(pr.value.id)) {
            ids.add(pr.value.id);
            addedNames.push(pr.value.name);
          }
        }

        await h.db.channelMember.createMany({
          data: [...ids].map((userId) => ({ channelId, userId, role: 'MEMBER' })),
          skipDuplicates: true,
        });

        h.audit({
          category: 'CHAT',
          action: 'addMembers',
          operation: 'UPDATE',
          description: `added ${addedNames.join(', ')} to "${r.value.name}"`,
          targetType: 'Channel',
          targetId: channelId,
          targetLabel: r.value.name,
          metadata: { added: addedNames },
        });

        return {
          channel: r.value.name,
          added: addedNames,
          note: r.interpreted ? `Interpreted "${channel}" as ${r.value.name}.` : undefined,
        };
      },
    }),
  };

  return tools;
}
