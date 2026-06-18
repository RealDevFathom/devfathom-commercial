'use client';

import { useSession } from 'next-auth/react';
import { useTypingUsers } from '@/lib/chat/realtime-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTypingText(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return 'Several people are typing';
}

// ---------------------------------------------------------------------------
// Three animated bounce dots — pure CSS, no JS timers
// ---------------------------------------------------------------------------

function BounceDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      <span className="size-1 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
      <span className="size-1 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
      <span className="size-1 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// TypingIndicator
//
// Reserves a fixed h-5 slot to prevent layout shift when someone starts/stops
// typing. Renders nothing visible when no peers are typing.
// ---------------------------------------------------------------------------

export function TypingIndicator({ channelId }: { channelId: string }) {
  const { data: session } = useSession();
  const currentUserId = (session?.user as { id?: string } | undefined)?.id;

  const all = useTypingUsers(channelId);
  // Filter out the current user — they already see their own keystrokes
  const typists = all.filter((u) => u.userId !== currentUserId);

  return (
    // Fixed height so the message list never jumps when typing state changes
    <div
      className="flex h-5 items-center gap-1.5 px-4"
      aria-live="polite"
      aria-atomic="true"
    >
      {typists.length > 0 && (
        <>
          <span className="text-xs text-muted-foreground">
            {formatTypingText(typists.map((u) => u.userName))}
          </span>
          <BounceDots />
        </>
      )}
    </div>
  );
}
