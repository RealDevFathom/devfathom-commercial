'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import {
  Hash, Send, Plus, X, Loader2, MessageSquare, Users, Pencil, Trash2, Check,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday } from 'date-fns';

const channelTypeIcons: Record<string, string> = {
  GROUP: '#', PROJECT: '#', DM: '@',
};

export function ChatContent() {
  const { data: session } = useSession();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);

  const { data: channels, isLoading: channelsLoading } = trpc.chat.getChannels.useQuery();

  // Auto-select first channel
  useEffect(() => {
    if (channels?.length && !selectedChannelId) {
      setSelectedChannelId(channels[0].id);
    }
  }, [channels, selectedChannelId]);

  const selectedChannel = channels?.find((c) => c.id === selectedChannelId);

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-0 -m-6 animate-fade-in">
      {/* Channel sidebar */}
      <div className="w-64 shrink-0 border-r border-border/60 bg-card flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <h2 className="font-display text-sm font-bold text-foreground">Messages</h2>
          <button onClick={() => setShowCreateChannel(true)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
            <Plus className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {channelsLoading ? (
            <div className="p-3 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</div>
          ) : channels?.length ? (
            <div className="p-2 space-y-0.5">
              {channels.map((channel) => {
                const lastMsg = channel.messages[0];
                const isSelected = channel.id === selectedChannelId;
                return (
                  <button
                    key={channel.id}
                    onClick={() => setSelectedChannelId(channel.id)}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors',
                      isSelected ? 'bg-[#FF4C29]/10 text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                    )}
                  >
                    <span className={cn('shrink-0 font-mono text-sm font-bold mt-0.5', isSelected ? 'text-[#FF4C29]' : '')}>
                      {channelTypeIcons[channel.type]}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={cn('text-sm font-medium truncate', isSelected ? 'text-foreground' : '')}>{channel.name || 'Direct Message'}</p>
                      {lastMsg && (
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {lastMsg.sender.name.split(' ')[0]}: {lastMsg.content.slice(0, 30)}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="p-6 text-center">
              <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground/20" />
              <p className="mt-2 text-xs text-muted-foreground">No channels yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Message area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedChannel ? (
          <>
            {/* Channel header */}
            <ChannelHeader
              channel={selectedChannel}
              onDeleted={() => setSelectedChannelId(null)}
            />

            {/* Messages */}
            <MessageArea channelId={selectedChannel.id} currentUserId={session?.user?.id ?? ''} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="mx-auto h-12 w-12 text-muted-foreground/20" />
              <h3 className="mt-4 font-display text-lg font-semibold text-foreground">Select a channel</h3>
              <p className="mt-1 text-sm text-muted-foreground">Choose a channel to start messaging</p>
            </div>
          </div>
        )}
      </div>

      {/* Create channel modal */}
      {showCreateChannel && <CreateChannelModal onClose={() => setShowCreateChannel(false)} />}
    </div>
  );
}

function ChannelHeader({ channel, onDeleted }: {
  channel: { id: string; name: string | null; description: string | null; members: Array<unknown> };
  onDeleted: () => void;
}) {
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [showDelete, setShowDelete] = useState(false);

  const updateChannel = trpc.chat.updateChannel.useMutation({
    onSuccess: () => { utils.chat.getChannels.invalidate(); setIsEditing(false); },
  });
  const deleteChannel = trpc.chat.deleteChannel.useMutation({
    onSuccess: () => { utils.chat.getChannels.invalidate(); onDeleted(); },
  });

  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-border/60 shrink-0 group/header">
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <div className="flex items-center gap-2">
            <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editName.trim()) updateChannel.mutate({ id: channel.id, name: editName.trim(), description: editDesc || null });
                if (e.key === 'Escape') setIsEditing(false);
              }}
              className="text-sm font-semibold text-foreground bg-transparent border-b border-[#FF4C29] pb-0.5 focus:outline-none w-40"
            />
            <input
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Description..."
              className="text-xs text-muted-foreground bg-transparent border-b border-border pb-0.5 focus:outline-none flex-1"
            />
            <button
              onClick={() => { if (editName.trim()) updateChannel.mutate({ id: channel.id, name: editName.trim(), description: editDesc || null }); }}
              disabled={!editName.trim() || updateChannel.isPending}
              className="flex h-6 w-6 items-center justify-center rounded-md text-emerald-500 hover:bg-emerald-500/10 transition-colors disabled:opacity-40"
            >
              {updateChannel.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </button>
            <button onClick={() => setIsEditing(false)} className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Hash className="h-4 w-4 text-muted-foreground" />
              {channel.name}
            </h3>
            {channel.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{channel.description}</p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-1">
        <div className="flex items-center gap-1 text-xs text-muted-foreground mr-2">
          <Users className="h-3.5 w-3.5" />
          {channel.members.length}
        </div>

        {!isEditing && !showDelete && (
          <>
            <button
              onClick={() => { setEditName(channel.name || ''); setEditDesc(channel.description || ''); setIsEditing(true); }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover/header:text-muted-foreground hover:!bg-secondary hover:!text-foreground transition-all"
              title="Edit channel"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setShowDelete(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover/header:text-muted-foreground hover:!bg-red-500/10 hover:!text-red-500 transition-all"
              title="Delete channel"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}

        {showDelete && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => deleteChannel.mutate({ id: channel.id })}
              disabled={deleteChannel.isPending}
              className="rounded-lg bg-red-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
            >
              {deleteChannel.isPending ? 'Deleting...' : 'Delete'}
            </button>
            <button onClick={() => setShowDelete(false)} className="text-[11px] text-muted-foreground hover:text-foreground px-1">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageArea({ channelId, currentUserId }: { channelId: string; currentUserId: string }) {
  const utils = trpc.useUtils();
  const { data: messages, isLoading } = trpc.chat.getMessages.useQuery({ channelId });
  const sendMessage = trpc.chat.sendMessage.useMutation({
    onSuccess: () => { utils.chat.getMessages.invalidate({ channelId }); utils.chat.getChannels.invalidate(); setInput(''); },
  });

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    sendMessage.mutate({ channelId, content: input.trim() });
  };

  const formatMsgTime = (date: Date) => {
    const d = new Date(date);
    if (isToday(d)) return format(d, 'h:mm a');
    if (isYesterday(d)) return `Yesterday ${format(d, 'h:mm a')}`;
    return format(d, 'MMM d, h:mm a');
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {isLoading ? (
          <div className="space-y-4">{Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-3"><Skeleton className="h-8 w-8 rounded-full shrink-0" /><div className="space-y-1.5"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-48" /></div></div>
          ))}</div>
        ) : messages?.length ? (
          messages.map((msg) => {
            const isOwn = msg.sender.id === currentUserId;
            return (
              <div key={msg.id} className={cn('flex gap-3 group', isOwn && 'flex-row-reverse')}>
                <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                  <AvatarImage src={msg.sender.avatar ?? undefined} />
                  <AvatarFallback className="text-[10px] bg-secondary font-medium">{msg.sender.name[0]}</AvatarFallback>
                </Avatar>
                <div className={cn('max-w-[70%]', isOwn && 'text-right')}>
                  <div className={cn('flex items-baseline gap-2', isOwn && 'flex-row-reverse')}>
                    <span className="text-xs font-semibold text-foreground">{msg.sender.name}</span>
                    <span className="text-[10px] text-muted-foreground/50">{formatMsgTime(msg.createdAt)}</span>
                  </div>
                  <div className={cn(
                    'mt-1 inline-block rounded-2xl px-4 py-2 text-sm leading-relaxed',
                    isOwn
                      ? 'bg-[#FF4C29] text-white rounded-tr-md'
                      : 'bg-secondary text-foreground rounded-tl-md'
                  )}>
                    {msg.content}
                  </div>
                  {msg._count.replies > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">{msg._count.replies} {msg._count.replies === 1 ? 'reply' : 'replies'}</p>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex-1 flex items-center justify-center py-20">
            <div className="text-center">
              <MessageSquare className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">No messages yet. Start the conversation.</p>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Compose */}
      <div className="shrink-0 border-t border-border/60 px-6 py-3">
        <div className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Type a message..."
            className="w-full rounded-xl border border-border bg-secondary/50 px-4 py-3 pr-12 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sendMessage.isPending}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-[#FF4C29] transition-colors disabled:opacity-30"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
}

function CreateChannelModal({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data: team } = trpc.team.getAll.useQuery();

  const createChannel = trpc.chat.createChannel.useMutation({
    onSuccess: () => { utils.chat.getChannels.invalidate(); onClose(); },
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
            <h2 className="font-display text-lg font-bold text-foreground">New Channel</h2>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Channel Name</label>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="e.g. dev-team"
                className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this channel about?"
                className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Members</label>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {team?.map((m) => (
                  <button key={m.id} onClick={() => setSelectedMembers((prev) => prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id])}
                    className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                      selectedMembers.includes(m.id) ? 'bg-[#FF4C29]/10 text-[#FF4C29] ring-1 ring-[#FF4C29]/20' : 'bg-secondary text-muted-foreground hover:text-foreground')}>
                    {m.name.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border/60 px-6 py-4">
            <button onClick={onClose} className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={() => { if (name.trim()) createChannel.mutate({ name: name.trim(), description: description || undefined, memberIds: selectedMembers }); }}
              disabled={!name.trim() || createChannel.isPending}
              className="flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-4 py-2 text-xs font-semibold text-white hover:bg-[#E63E1C] disabled:opacity-40 transition-colors">
              {createChannel.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Creating...</> : 'Create Channel'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
