'use client';

import { useIsOnline } from '@/lib/chat/realtime-store';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// PresenceDot — small coloured circle indicating online / offline status
// ---------------------------------------------------------------------------

export function PresenceDot({
  userId,
  className,
}: {
  userId: string | null | undefined;
  className?: string;
}) {
  const online = useIsOnline(userId);

  return (
    <span
      aria-label={online ? 'Online' : 'Offline'}
      role="img"
      className={cn(
        'inline-block shrink-0 rounded-full',
        // Size defaults to 8px; callers can override via className
        'size-2',
        online ? 'bg-success' : 'border border-muted-foreground/40 bg-muted',
        className
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// PresenceLabel — "Active" / "Away" text that mirrors PresenceDot state
// ---------------------------------------------------------------------------

export function PresenceLabel({ userId }: { userId: string | null | undefined }) {
  const online = useIsOnline(userId);

  return (
    <span className={cn('text-xs', online ? 'text-success' : 'text-muted-foreground')}>
      {online ? 'Active' : 'Away'}
    </span>
  );
}
