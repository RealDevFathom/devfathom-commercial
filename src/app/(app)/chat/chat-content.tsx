'use client';

/**
 * Chat — Slack-grade workspace.
 *
 * Composition root. Holds the selected-channel + panel state and wires together
 * the sidebar, channel header, live message timeline, composer, and the
 * power-feature panels (quick switcher, search, pins, saved). Live updates flow
 * in through the app-level RealtimeProvider patching the React Query cache; this
 * component only orchestrates layout + navigation.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bookmark, Search, MessageSquare } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import { ChannelSidebar } from '@/components/chat/sidebar/channel-sidebar';
import { ChannelHeader } from '@/components/chat/sidebar/channel-header';
import { ChannelMembersDialog } from '@/components/chat/sidebar/channel-members-dialog';
import { MessageList } from '@/components/chat/message/message-list';
import { MessageComposer } from '@/components/chat/composer/message-composer';
import { TypingIndicator } from '@/components/chat/power/typing-indicator';
import { QuickSwitcher, useQuickSwitcherHotkey } from '@/components/chat/power/quick-switcher';
import { SearchPanel } from '@/components/chat/power/search-panel';
import { PinsPanel } from '@/components/chat/power/pins-panel';
import { SavedView } from '@/components/chat/power/saved-view';
import { useChatNotifications } from '@/components/chat/power/use-chat-notifications';

export function ChatContent() {
  // Mention/notification toasts + desktop notifications (mounted once here).
  useChatNotifications();

  const utils = trpc.useUtils();
  const { data: channels } = trpc.chat.getChannels.useQuery();

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  // Resolve synchronously so the timeline query fires the same render the list resolves.
  const effectiveChannelId = selectedChannelId ?? channels?.[0]?.id ?? null;
  const selectedChannel = useMemo(
    () => channels?.find((c) => c.id === effectiveChannelId) ?? null,
    [channels, effectiveChannelId]
  );

  // Commit the resolved default into state so the view doesn't jump when
  // getChannels reorders (updatedAt desc) before the user picks a channel.
  useEffect(() => {
    if (!selectedChannelId && channels?.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time default-channel commit once channels load
      setSelectedChannelId(channels[0].id);
    }
  }, [channels, selectedChannelId]);

  // Panels
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useQuickSwitcherHotkey(useCallback(() => setSwitcherOpen(true), []));

  // Mobile master-detail: render the channel list OR the conversation, never
  // both (they sit side-by-side from md up regardless of this). Loads on the
  // list; picking a channel slides to the conversation, with a back button.
  const [mobileView, setMobileView] = useState<'list' | 'conversation'>('list');

  const markRead = trpc.chat.markRead.useMutation({
    onSuccess: (_data, vars) => {
      // Reset locally too, so unread clears even if the socket echo is missed.
      utils.chat.getChannels.setData(undefined, (old) =>
        old?.map((c) => (c.id === vars.channelId ? { ...c, unreadCount: 0, mentionCount: 0 } : c))
      );
    },
  });
  const markReadMutate = markRead.mutate;

  // On channel open: mark the channel read.
  useEffect(() => {
    if (effectiveChannelId) markReadMutate({ channelId: effectiveChannelId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveChannelId]);

  // Keep the active channel read as live messages arrive while it's focused.
  const activeUnread = selectedChannel?.unreadCount ?? 0;
  useEffect(() => {
    if (effectiveChannelId && activeUnread > 0) markReadMutate({ channelId: effectiveChannelId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveChannelId, activeUnread]);

  const selectChannel = useCallback((id: string) => {
    setSelectedChannelId(id);
    setMobileView('conversation');
  }, []);
  const jumpTo = useCallback((m: { channelId: string }) => {
    setSelectedChannelId(m.channelId);
    setMobileView('conversation');
    setSearchOpen(false);
    setSavedOpen(false);
  }, []);

  const topBtn =
    'flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Global bar — jump-to + saved live here (workspace-wide, not per channel). */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-card px-3 sm:px-4">
        <button
          type="button"
          onClick={() => setSwitcherOpen(true)}
          className={cn(
            topBtn,
            'min-w-0 flex-1 justify-start text-muted-foreground/80 sm:min-w-56 sm:flex-none'
          )}
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Jump to a channel or person…</span>
          <kbd className="ml-auto hidden rounded border border-border/60 bg-background px-1 text-[10px] sm:inline">
            ⌘K
          </kbd>
        </button>
        <button type="button" onClick={() => setSavedOpen(true)} className={cn(topBtn, 'shrink-0')}>
          <Bookmark className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Saved</span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <ChannelSidebar
          selectedChannelId={effectiveChannelId}
          onSelect={selectChannel}
          onOpenSearch={() => setSwitcherOpen(true)}
          className={cn(mobileView === 'list' ? 'flex' : 'hidden', 'md:flex')}
        />

        <main
          className={cn(
            'min-w-0 flex-1 flex-col bg-background',
            mobileView === 'conversation' ? 'flex' : 'hidden',
            'md:flex'
          )}
        >
          {selectedChannel ? (
            <>
              <ChannelHeader
                channel={selectedChannel}
                onOpenMembers={() => setMembersOpen(true)}
                onOpenPins={() => setPinsOpen(true)}
                onOpenSearch={() => setSearchOpen(true)}
                onToggleMute={() => undefined}
                onBack={() => setMobileView('list')}
              />
              {/* key per channel: MessageList snapshots lastReadAt at mount for a
                  stable "New messages" divider (markRead moves it afterwards). */}
              <MessageList
                key={selectedChannel.id}
                channelId={selectedChannel.id}
                lastReadAt={selectedChannel.lastReadAt}
              />
              <TypingIndicator channelId={selectedChannel.id} />
              <div className="px-4 pb-4 pt-1">
                {/* key remounts the composer per channel: clean draft/editor reset + focus. */}
                <MessageComposer
                  key={selectedChannel.id}
                  channelId={selectedChannel.id}
                  autoFocus
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted">
                  <MessageSquare className="h-6 w-6 text-muted-foreground/50" />
                </div>
                <p className="mt-3 text-sm font-medium text-foreground">No conversation selected</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pick a channel on the left, or press ⌘K to jump to one.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Channel-scoped panels */}
      {selectedChannel && (
        <>
          <PinsPanel channelId={selectedChannel.id} open={pinsOpen} onOpenChange={setPinsOpen} />
          <SearchPanel
            open={searchOpen}
            onOpenChange={setSearchOpen}
            channelId={selectedChannel.id}
            onJump={jumpTo}
          />
          <ChannelMembersDialog
            channelId={selectedChannel.id}
            open={membersOpen}
            onOpenChange={setMembersOpen}
          />
        </>
      )}

      {/* Workspace-wide */}
      <SavedView open={savedOpen} onOpenChange={setSavedOpen} onJump={jumpTo} />
      <QuickSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        onSelectChannel={(id) => {
          setSelectedChannelId(id);
          setMobileView('conversation');
          setSwitcherOpen(false);
        }}
      />
    </div>
  );
}
