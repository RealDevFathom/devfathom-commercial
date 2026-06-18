'use client';

import { Bell, BellOff, Hash, Lock, Pin, Search, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useIsOnline } from '@/lib/chat/realtime-store';
import type { ChatChannel } from '@/lib/chat/contract';

export function ChannelHeader({
  channel,
  onOpenMembers,
  onOpenPins,
  onOpenSearch,
  onToggleMute,
}: {
  channel: ChatChannel;
  onOpenMembers: () => void;
  onOpenPins: () => void;
  onOpenSearch: () => void;
  onToggleMute: () => void;
}) {
  const utils = trpc.useUtils();
  const isDM = channel.type === 'DM';
  const peerOnline = useIsOnline(channel.dmPeer?.id);
  const displayName = channel.name ?? channel.dmPeer?.name ?? 'Direct Message';

  const setMuted = trpc.chat.setMuted.useMutation({
    onSuccess: () => {
      utils.chat.getChannels.invalidate();
      onToggleMute();
    },
    onError: (err) => toast.error(err.message ?? 'Could not update notification preference'),
  });

  const handleToggleMute = () => {
    setMuted.mutate({ channelId: channel.id, muted: !channel.muted });
  };

  return (
    <TooltipProvider delay={600}>
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        {/* Identity — name + optional topic */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isDM && channel.dmPeer ? (
            <span className="relative shrink-0">
              <Avatar size="sm">
                <AvatarImage src={channel.dmPeer.avatar ?? undefined} alt={channel.dmPeer.name} />
                <AvatarFallback>{channel.dmPeer.name[0]}</AvatarFallback>
              </Avatar>
              <span
                role="img"
                aria-label={peerOnline ? 'Online' : 'Offline'}
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background',
                  peerOnline ? 'bg-emerald-500' : 'border border-muted-foreground/40'
                )}
              />
            </span>
          ) : channel.isPrivate ? (
            <Lock className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Hash className="size-4 shrink-0 text-muted-foreground" />
          )}

          <span className="text-sm font-semibold text-foreground">{displayName}</span>

          {channel.topic && (
            <>
              <span className="select-none text-muted-foreground/40">·</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{channel.topic}</span>
            </>
          )}
        </div>

        {/* Action bar */}
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Members count */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenMembers}
                  aria-label="Members"
                  className="gap-1 text-muted-foreground"
                />
              }
            >
              <Users className="size-4" />
              <span className="tabular-nums text-xs">{channel.memberCount}</span>
            </TooltipTrigger>
            <TooltipContent>Members</TooltipContent>
          </Tooltip>

          {/* Pins */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onOpenPins}
                  aria-label="Pinned messages"
                  className="text-muted-foreground"
                />
              }
            >
              <Pin className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Pinned messages</TooltipContent>
          </Tooltip>

          {/* Search */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onOpenSearch}
                  aria-label="Search in channel"
                  className="text-muted-foreground"
                />
              }
            >
              <Search className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Search in channel</TooltipContent>
          </Tooltip>

          {/* Mute toggle */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleToggleMute}
                  disabled={setMuted.isPending}
                  aria-label={channel.muted ? 'Unmute channel' : 'Mute channel'}
                  className={cn(
                    'transition-colors',
                    channel.muted ? 'text-muted-foreground/50' : 'text-muted-foreground'
                  )}
                />
              }
            >
              {channel.muted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
            </TooltipTrigger>
            <TooltipContent>{channel.muted ? 'Unmute channel' : 'Mute channel'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
