export interface Person {
  id: string;
  name: string;
  email?: string;
  title?: string | null;
  avatar?: string | null;
}

export interface TiptapNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string }[];
  content?: TiptapNode[];
}

export interface NoteSummary {
  id: string;
  title: string;
  contentText?: string;
  visibility: 'PRIVATE' | 'SHARED' | 'TEAM';
  author?: Person;
  authorId?: string;
  project?: { id: string; name: string } | null;
  client?: { id: string; name: string } | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface Note extends NoteSummary {
  contentJson: TiptapNode;
  editable: boolean;
  shares: { id: string; userId: string; permission: 'VIEW' | 'EDIT'; user: Person }[];
  mentions: { id: string; userId: string; user: Person }[];
  linksFrom: { id: string; toNote: NoteSummary }[];
  linksTo: { id: string; fromNote: NoteSummary }[];
}

export interface NoteRevision {
  id: string;
  noteId: string;
  title: string;
  contentJson: TiptapNode;
  contentText?: string;
  createdAt: string;
  createdBy?: Person;
}

export interface Channel {
  id: string;
  name: string;
  type: 'DM' | 'GROUP' | 'PROJECT';
  topic?: string | null;
  description?: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isDM: boolean;
  dmPeer?: Person | null;
  memberCount: number;
  members: (Person & { role?: string; presence?: string })[];
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  content: string;
  sender: Person;
  parentId?: string | null;
  isEdited: boolean;
  editedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  reactions: { emoji: string; count: number; userIds: string[]; reactedByMe: boolean }[];
  attachments: { id: string; name: string; url: string; type?: string; size?: number }[];
  replyCount: number;
  threadParticipants: Person[];
  isPinned: boolean;
  isSaved: boolean;
}

export interface Meeting {
  id: string;
  title: string;
  description?: string | null;
  startTime: string;
  endTime: string;
  location?: string | null;
  recurrence?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
  createdById: string;
  attendees: { id: string; userId: string; joinedAt?: string | null; user: Person }[];
  createdAt: string;
  updatedAt: string;
}

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  type: string;
  isRead: boolean;
  entityType?: string | null;
  entityId?: string | null;
  createdAt: string;
}

export interface NotificationChannelPreference {
  inApp?: boolean;
  email?: boolean;
}

export type NotificationPreferences = Partial<
  Record<
    | 'task'
    | 'mention'
    | 'meeting'
    | 'leave'
    | 'invoice'
    | 'project'
    | 'client'
    | 'resignation'
    | 'note',
    NotificationChannelPreference
  >
>;

export interface CollaborationSearch {
  notes: NoteSummary[];
  messages: Message[];
  meetings: Meeting[];
  team: Person[];
}
