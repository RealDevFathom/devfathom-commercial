/**
 * Chat feature — shared contract.
 *
 * The single source of truth that every chat component, the realtime provider,
 * the backend router, and the socket bridge agree on. The view-model types here
 * are the exact shapes the tRPC `chat` router returns and the UI consumes.
 *
 * Keep this file dependency-light — NO React, NO Prisma, NO server imports — so
 * both client components and server code can import it freely.
 */

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------
export type PresenceStatus = 'online' | 'away' | 'offline';

// ---------------------------------------------------------------------------
// Tiptap rich content
// ---------------------------------------------------------------------------
/** Minimal structural type for a Tiptap JSON node (message rich content). */
export interface TiptapNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: TiptapNode[];
}
/** Root Tiptap document (node with `type: 'doc'`). */
export type TiptapDoc = TiptapNode;

// ---------------------------------------------------------------------------
// View models — the tRPC `chat` router output shapes
// ---------------------------------------------------------------------------
export interface ChatUserLite {
  id: string;
  name: string;
  avatar: string | null;
  title?: string | null;
}

export interface ChatAttachment {
  id: string;
  name: string;
  url: string;
  type: string | null;
  size: number | null;
  /** Playback length in milliseconds — set for audio/voice attachments only. */
  duration: number | null;
}

/** Aggregated reaction for one emoji on one message. */
export interface ChatReaction {
  emoji: string;
  count: number;
  userIds: string[];
  /** True when the current viewer is one of `userIds`. */
  reactedByMe: boolean;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  /** Flattened plaintext — fallback render + search + notification body. */
  content: string;
  /** Rich content. `null` for legacy/system messages → render `content`. */
  contentJson: TiptapDoc | null;
  sender: ChatUserLite;
  parentId: string | null;
  isEdited: boolean;
  editedAt: string | null;
  /** Soft-deleted → render a tombstone, keep the slot. */
  deletedAt: string | null;
  createdAt: string;
  reactions: ChatReaction[];
  attachments: ChatAttachment[];
  /** User ids mentioned in this message (for highlight + "mentions me"). */
  mentionIds: string[];
  /** Thread affordance. */
  replyCount: number;
  lastReplyAt: string | null;
  threadParticipants: ChatUserLite[];
  isPinned: boolean;
  isSaved: boolean;
}

export type ChannelKind = 'DM' | 'GROUP' | 'PROJECT';

export interface ChatChannelMemberLite extends ChatUserLite {
  /** OWNER | ADMIN | MEMBER */
  role: string;
  presence: PresenceStatus;
}

export interface ChatChannel {
  id: string;
  /** `null` for DMs — derive the label from `dmPeer`. */
  name: string | null;
  type: ChannelKind;
  topic: string | null;
  description: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  createdById: string | null;
  memberCount: number;
  members: ChatChannelMemberLite[];
  // DM helpers
  isDM: boolean;
  dmPeer: ChatUserLite | null;
  // sidebar state
  unreadCount: number;
  /** Unread messages that @mention the viewer. */
  mentionCount: number;
  muted: boolean;
  /** Viewer's last-read timestamp — snapshot on open for the "new messages" line. */
  lastReadAt: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
}

// ---------------------------------------------------------------------------
// Realtime events
// ---------------------------------------------------------------------------
/**
 * Canonical socket event names. Flow:
 *   backend mutation → realtime-emit() → socket-server `/emit` →
 *   io.to(room).emit(name, payload) → RealtimeProvider patches the query cache.
 *
 * Rooms: `channel:{channelId}` (channel-scoped) and `user:{userId}` (personal).
 */
export const RT = {
  MESSAGE_NEW: 'chat:message',
  MESSAGE_UPDATE: 'chat:message:update',
  MESSAGE_DELETE: 'chat:message:delete',
  REACTION: 'chat:reaction',
  READ: 'chat:read',
  THREAD_REPLY: 'chat:thread',
  TYPING: 'chat:typing',
  STOP_TYPING: 'chat:stop-typing',
  PRESENCE_ONLINE: 'user:online',
  PRESENCE_OFFLINE: 'user:offline',
  NOTIFICATION: 'notification:new',
  // RT-02: pushed to a user's personal room when their channel membership
  // changes (removed / left) so their client drops the channel live.
  MEMBERSHIP_CHANGED: 'chat:membership',
} as const;

export type RTEventName = (typeof RT)[keyof typeof RT];

export interface RTMessageNew {
  channelId: string;
  message: ChatMessage;
}
export interface RTMessageUpdate {
  channelId: string;
  message: ChatMessage;
}
export interface RTMessageDelete {
  channelId: string;
  messageId: string;
}
export interface RTReaction {
  channelId: string;
  messageId: string;
  reactions: ChatReaction[];
}
export interface RTRead {
  channelId: string;
  userId: string;
  lastReadAt: string;
}
export interface RTThreadReply {
  channelId: string;
  parentId: string;
  message: ChatMessage;
  replyCount: number;
}
export interface RTTyping {
  channelId: string;
  userId: string;
  userName: string;
}
export interface RTPresence {
  userId: string;
  onlineUsers: string[];
}
export interface RTNotification {
  id: string;
  title: string;
  message: string;
  type: string;
  entityType: string | null;
  entityId: string | null;
}

export const channelRoom = (channelId: string) => `channel:${channelId}`;
export const userRoom = (userId: string) => `user:${userId}`;
// Clients publish typing pings here (separate from the subscribe-only message
// channel, so a client can never forge a message event).
export const typingRoom = (channelId: string) => `typing:${channelId}`;
// Online-presence roster (Ably presence), one per tenant. Derived from the
// verified organization so users of one tenant can never attach to, or
// enumerate, another tenant's roster on a shared Ably application.
export const presenceRoom = (organizationId: string) => `presence:org:${organizationId}`;

// ---------------------------------------------------------------------------
// UI constants
// ---------------------------------------------------------------------------
/** Emoji shown in the hover quick-reaction bar. */
export const QUICK_REACTIONS = ['👍', '❤️', '😄', '🎉', '👀', '🙏'] as const;

/** Max attachment size (bytes) accepted by the upload route. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

/** Message history page size (keyset pagination). */
export const MESSAGE_PAGE_SIZE = 30;

// ---------------------------------------------------------------------------
// tRPC procedure reference — source of truth is src/server/routers/chat.ts.
// The army calls these by name; backend conforms outputs to the types above.
// ---------------------------------------------------------------------------
/**
 * QUERIES
 *   chat.getChannels()                         -> ChatChannel[]            (sidebar; unread + mention counts baked in)
 *   chat.getMessages({ channelId, cursor? })   -> { items: ChatMessage[]; nextCursor: string | null }
 *   chat.getThread({ parentId })               -> { parent: ChatMessage; replies: ChatMessage[] }
 *   chat.searchMessages({ query, channelId? }) -> ChatMessage[]
 *   chat.getPins({ channelId })                -> ChatMessage[]
 *   chat.getSaved()                            -> ChatMessage[]
 *   chat.getMembers({ channelId })             -> ChatChannelMemberLite[]
 *   chat.getMentionTargets({ channelId, q })   -> ChatUserLite[]           (mention autocomplete)
 *   chat.browseChannels({ q? })                -> ChatChannel[]            (public, joinable, not-yet-member)
 *
 * MUTATIONS  (each: assertChannelMember authz → write → realtime-emit)
 *   chat.sendMessage({ channelId, content, contentJson?, mentionIds?, parentId?, attachments? }) -> ChatMessage
 *   chat.editMessage({ messageId, content, contentJson?, mentionIds? })   -> ChatMessage
 *   chat.deleteMessage({ messageId })                                     -> { id: string }
 *   chat.toggleReaction({ messageId, emoji })                             -> ChatReaction[]
 *   chat.markRead({ channelId })                                          -> { lastReadAt: string }
 *   chat.createChannel({ name, description?, topic?, type, isPrivate?, memberIds }) -> ChatChannel
 *   chat.updateChannel({ id, name?, description?, topic? })               -> ChatChannel
 *   chat.archiveChannel({ id })                                          -> { id: string }
 *   chat.deleteChannel({ id })                                           -> { id: string }
 *   chat.joinChannel({ channelId })  |  chat.leaveChannel({ channelId })
 *   chat.addMembers({ channelId, userIds })  |  chat.removeMember({ channelId, userId })
 *   chat.createOrGetDM({ userId })                                       -> ChatChannel
 *   chat.togglePin({ messageId })                                        -> { isPinned: boolean }
 *   chat.toggleSave({ messageId })                                       -> { isSaved: boolean }
 *   chat.setMuted({ channelId, muted })                                  -> { muted: boolean }
 *
 * Attachment input shape for sendMessage:
 *   { name: string; url: string; type?: string | null; size?: number | null }
 */
export interface SendAttachmentInput {
  name: string;
  url: string;
  type?: string | null;
  size?: number | null;
  /** Playback length in milliseconds — set for audio/voice attachments only. */
  duration?: number | null;
}
