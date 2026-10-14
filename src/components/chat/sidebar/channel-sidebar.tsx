'use client';

import { useState, type ReactNode } from 'react';
import { Plus, Search, Hash, Compass, MessageSquarePlus, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { ChannelListItem } from './channel-list-item';
import { CreateChannelDialog } from './create-channel-dialog';
import { BrowseChannelsDialog } from './browse-channels-dialog';
import { NewDmDialog } from './new-dm-dialog';

export function ChannelSidebar({
  selectedChannelId,
  onSelect,
  onOpenSearch,
  className,
}: {
  selectedChannelId: string | null;
  onSelect: (channelId: string) => void;
  onOpenSearch?: () => void;
  /** Visibility/layout overrides from the parent (mobile master-detail toggle). */
  className?: string;
}) {
  const { data: channels, isLoading } = trpc.chat.getChannels.useQuery();
  const [filter, setFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);

  const q = filter.toLowerCase().trim();
  const filtered = q
    ? channels?.filter((ch) => {
        const label = ch.name ?? ch.dmPeer?.name ?? '';
        return label.toLowerCase().includes(q);
      })
    : channels;

  const regularChannels = filtered?.filter((c) => c.type !== 'DM') ?? [];
  const dmChannels = filtered?.filter((c) => c.type === 'DM') ?? [];

  return (
    <TooltipProvider delay={600}>
      <div
        className={cn(
          'flex h-full w-full shrink-0 flex-col border-r border-border/60 bg-card/40 md:w-[280px]',
          className
        )}
      >
        {/* Filter toolbar */}
        <div className="flex items-center gap-1 border-b border-border/60 px-3 py-2.5">
          <div className="relative flex-1">
            <Hash className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter channels…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-7 border-0 bg-secondary/50 pl-6 text-xs focus-visible:ring-1 focus-visible:ring-ring/30"
            />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onOpenSearch}
                  aria-label="Jump to a channel or person"
                  className="shrink-0 text-muted-foreground"
                />
              }
            >
              <Search className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="right">Jump to…</TooltipContent>
          </Tooltip>
        </div>

        {/* Channel lists */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="space-y-1.5 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full rounded-md" />
              ))}
            </div>
          ) : (
            <div className="py-2">
              {/* ── Channels section ── */}
              <SectionHeader
                label="Channels"
                actions={
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setCreateOpen(true)}
                            aria-label="Create channel"
                            className="text-muted-foreground"
                          />
                        }
                      >
                        <Plus className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent side="right">Create channel</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setBrowseOpen(true)}
                            aria-label="Browse channels"
                            className="text-muted-foreground"
                          />
                        }
                      >
                        <Compass className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent side="right">Browse channels</TooltipContent>
                    </Tooltip>
                  </>
                }
              />

              {regularChannels.length === 0 ? (
                <p className="px-4 py-2 text-xs text-muted-foreground/60">
                  {q ? 'No channels match.' : 'No channels yet.'}
                </p>
              ) : (
                <ul className="space-y-0.5 px-2">
                  {regularChannels.map((ch) => (
                    <li key={ch.id}>
                      <ChannelListItem
                        channel={ch}
                        active={ch.id === selectedChannelId}
                        onClick={() => onSelect(ch.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}

              <Separator className="my-2" />

              {/* ── Direct Messages section ── */}
              <SectionHeader
                label="Direct Messages"
                actions={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setDmOpen(true)}
                          aria-label="New message"
                          className="text-muted-foreground"
                        />
                      }
                    >
                      <MessageSquarePlus className="size-3" />
                    </TooltipTrigger>
                    <TooltipContent side="right">New message</TooltipContent>
                  </Tooltip>
                }
              />

              {dmChannels.length === 0 ? (
                <div className="px-4 py-3 text-center">
                  <MessageSquare className="mx-auto size-6 text-muted-foreground/20" />
                  <p className="mt-1 text-xs text-muted-foreground/60">
                    {q ? 'No DMs match.' : 'No direct messages.'}
                  </p>
                </div>
              ) : (
                <ul className="space-y-0.5 px-2">
                  {dmChannels.map((ch) => (
                    <li key={ch.id}>
                      <ChannelListItem
                        channel={ch}
                        active={ch.id === selectedChannelId}
                        onClick={() => onSelect(ch.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Dialogs rendered outside ScrollArea */}
      <CreateChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          setCreateOpen(false);
          onSelect(id);
        }}
      />
      <BrowseChannelsDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onJoined={(id) => {
          setBrowseOpen(false);
          onSelect(id);
        }}
      />
      <NewDmDialog
        open={dmOpen}
        onOpenChange={setDmOpen}
        onCreated={(id) => {
          setDmOpen(false);
          onSelect(id);
        }}
      />
    </TooltipProvider>
  );
}

function SectionHeader({ label, actions }: { label: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </div>
  );
}
