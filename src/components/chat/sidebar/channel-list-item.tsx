'use client';

import { Hash, Lock, BellOff } from 'lucide-react';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useIsOnline } from '@/lib/chat/realtime-store';
import type { ChatChannel } from '@/lib/chat/contract';

/** Local presence dot — avoids cross-team deps. 10×10 circle. */
function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      role="img"
      aria-label={online ? 'Online' : 'Offline'}
      className={cn(
        'block size-2.5 rounded-full ring-2 ring-card',
        online ? 'bg-emerald-500' : 'border border-muted-foreground/40 bg-transparent'
      )}
    />
  );
}

export function ChannelListItem({
  channel,
  active,
  onClick,
}: {
  channel: ChatChannel;
  active: boolean;
  onClick: () => void;
}) {
  const isOnline = useIsOnline(channel.dmPeer?.id);
  const isDM = channel.type === 'DM';
  const label = channel.name ?? channel.dmPeer?.name ?? 'Direct Message';
  const hasUnread = channel.unreadCount > 0;
  const hasMention = channel.mentionCount > 0;

  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
        channel.muted && !active && 'opacity-60'
      )}
    >
      {/* Leading icon / avatar */}
      <span className="relative shrink-0 flex items-center justify-center">
        {isDM && channel.dmPeer ? (
          <>
            <Avatar size="sm">
              <AvatarImage src={channel.dmPeer.avatar ?? undefined} alt={channel.dmPeer.name} />
              <AvatarFallback>{channel.dmPeer.name[0]}</AvatarFallback>
            </Avatar>
            <span className="absolute -bottom-0.5 -right-0.5">
              <PresenceDot online={isOnline} />
            </span>
          </>
        ) : channel.isPrivate ? (
          <Lock className="size-3.5" />
        ) : (
          <Hash className="size-3.5" />
        )}
      </span>

      {/* Label */}
      <span
        className={cn(
          'flex-1 truncate text-sm',
          hasUnread && !channel.muted && 'font-semibold text-foreground'
        )}
      >
        {label}
      </span>

      {/* Trailing indicators */}
      <span className="flex shrink-0 items-center gap-1">
        {channel.muted && <BellOff className="size-3 opacity-50" />}
        {hasMention && (
          <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent-brand px-1 text-[10px] font-semibold leading-none text-[#161a19]">
            {channel.mentionCount}
          </span>
        )}
        {hasUnread && !hasMention && (
          <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-secondary px-1 text-[10px] font-medium leading-none text-foreground">
            {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
          </span>
        )}
      </span>
    </button>
  );
}
