'use client';

import { useEffect } from 'react';
import { HashIcon } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { ChatChannel } from '@/lib/chat/contract';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

// ---------------------------------------------------------------------------
// Quick Switcher
// ---------------------------------------------------------------------------

export function QuickSwitcher({
  open,
  onOpenChange,
  onSelectChannel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSelectChannel: (channelId: string) => void;
}) {
  const { data: channels = [] } = trpc.chat.getChannels.useQuery(undefined, {
    enabled: open,
    staleTime: 30_000,
  });

  const { data: people = [] } = trpc.team.getAll.useQuery(undefined, {
    enabled: open,
    staleTime: 60_000,
  });

  const createOrGetDM = trpc.chat.createOrGetDM.useMutation();

  const groupChannels = (channels as ChatChannel[]).filter((c) => !c.isDM);
  const dmChannels = (channels as ChatChannel[]).filter((c) => c.isDM);

  function handleSelectChannel(channelId: string) {
    onOpenChange(false);
    onSelectChannel(channelId);
  }

  async function handleSelectPerson(userId: string) {
    try {
      const channel = await createOrGetDM.mutateAsync({ userId });
      onOpenChange(false);
      onSelectChannel(channel.id);
    } catch {
      // best-effort — onOpenChange stays true so the user can retry
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => onOpenChange(o)}
      title="Quick Switcher"
      description="Jump to a channel or person"
    >
      <CommandInput placeholder="Jump to channel or person…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {groupChannels.length > 0 && (
          <CommandGroup heading="Channels">
            {groupChannels.map((ch) => (
              <CommandItem
                key={ch.id}
                value={`channel-${ch.name ?? ch.id}`}
                onSelect={() => handleSelectChannel(ch.id)}
              >
                <HashIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{ch.name ?? '(unnamed)'}</span>
                {ch.unreadCount > 0 && (
                  <span className="ml-auto text-xs font-semibold text-primary tabular-nums">
                    {ch.unreadCount}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {dmChannels.length > 0 && (
          <CommandGroup heading="Direct messages">
            {dmChannels.map((ch) => (
              <CommandItem
                key={ch.id}
                value={`dm-${ch.dmPeer?.name ?? ch.id}`}
                onSelect={() => handleSelectChannel(ch.id)}
              >
                <Avatar size="sm" className="shrink-0">
                  {ch.dmPeer?.avatar && <AvatarImage src={ch.dmPeer.avatar} alt={ch.dmPeer.name} />}
                  <AvatarFallback>{(ch.dmPeer?.name ?? '?')[0].toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="truncate">{ch.dmPeer?.name ?? 'Unknown'}</span>
                {ch.unreadCount > 0 && (
                  <span className="ml-auto text-xs font-semibold text-primary tabular-nums">
                    {ch.unreadCount}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {(people as { id: string; name: string; avatar?: string | null; title?: string | null }[])
          .length > 0 && (
          <CommandGroup heading="People">
            {(
              people as {
                id: string;
                name: string;
                avatar?: string | null;
                title?: string | null;
              }[]
            ).map((person) => (
              <CommandItem
                key={person.id}
                value={`person-${person.name}`}
                onSelect={() => void handleSelectPerson(person.id)}
              >
                <Avatar size="sm" className="shrink-0">
                  {person.avatar && <AvatarImage src={person.avatar} alt={person.name} />}
                  <AvatarFallback>{(person.name ?? '?')[0].toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="truncate">{person.name}</span>
                {person.title && (
                  <span className="ml-auto max-w-[7rem] truncate text-xs text-muted-foreground">
                    {person.title}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

// ---------------------------------------------------------------------------
// Hotkey hook — bind ⌘K / Ctrl+K globally
// ---------------------------------------------------------------------------

export function useQuickSwitcherHotkey(open: () => void) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);
}
