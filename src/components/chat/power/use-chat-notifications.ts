'use client';

import { useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { useSocket } from '@/lib/socket';
import type { RTNotification } from '@/lib/chat/contract';

// ---------------------------------------------------------------------------
// useChatNotifications
//
// Side-effect hook — mount once near the app root (e.g. inside the chat
// layout). It:
//   1. Lazily requests desktop Notification permission on first mount (non-
//      blocking; the browser may ignore it if the user hasn't interacted yet).
//   2. Subscribes to `notification:new` socket events.
//   3. For every incoming notification:
//      - Shows a sonner toast (always).
//      - If the document is hidden AND Notification.permission is 'granted',
//        also fires a native desktop Notification.
//
// All work is best-effort; nothing throws.
// ---------------------------------------------------------------------------

export function useChatNotifications() {
  const { data: session } = useSession();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const { onNotification } = useSocket(userId);

  // Guard so we only call requestPermission once across re-renders / StrictMode
  const permAskedRef = useRef(false);

  // Request desktop-notification permission lazily on mount. We do it in a
  // useEffect so it runs after the first user interaction in most browsers.
  useEffect(() => {
    if (permAskedRef.current) return;
    permAskedRef.current = true;

    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    ) {
      void Notification.requestPermission().catch(() => {
        // Silently swallow — some browsers throw when called outside a gesture
      });
    }
  }, []);

  // Subscribe to socket notifications
  useEffect(() => {
    if (!userId) return;

    const unsub = onNotification((raw: unknown) => {
      try {
        const n = raw as RTNotification;

        // Always show a sonner toast
        toast(n.title, {
          description: n.message,
          duration: 5_000,
        });

        // Also push a native Notification when the tab is backgrounded
        if (
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden' &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          // `tag` deduplicates: if two events with the same id arrive, only one
          // notification shows in the OS notification center.
          new Notification(n.title, {
            body: n.message,
            tag: n.id,
          });
        }
      } catch {
        // Best-effort — never let a notification error bubble into the app
      }
    });

    return unsub;
  }, [userId, onNotification]);
}
