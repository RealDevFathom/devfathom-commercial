'use client';

import { useState } from 'react';
import { Search, Users, Loader2, Hash } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';

export function BrowseChannelsDialog({
  open,
  onOpenChange,
  onJoined,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJoined: (channelId: string) => void;
}) {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const { data: channels, isLoading } = trpc.chat.browseChannels.useQuery({}, { enabled: open });

  const joinChannel = trpc.chat.joinChannel.useMutation({
    onSuccess: (_, variables) => {
      utils.chat.getChannels.invalidate();
      utils.chat.browseChannels.invalidate();
      toast.success('Joined channel');
      onJoined(variables.channelId);
      setJoiningId(null);
    },
    onError: (err) => {
      toast.error(err.message ?? 'Could not join channel');
      setJoiningId(null);
    },
  });

  const q = search.toLowerCase().trim();
  const filtered = q
    ? channels?.filter((ch) => {
        const name = (ch.name ?? '').toLowerCase();
        const desc = (ch.description ?? '').toLowerCase();
        return name.includes(q) || desc.includes(q);
      })
    : channels;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Browse channels</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search channels..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        <ScrollArea className="h-80">
          {isLoading ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : !filtered?.length ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Hash className="mb-2 size-8 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">
                {q ? 'No channels match your search.' : 'No public channels to join.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-1 p-1">
              {filtered.map((ch) => (
                <li
                  key={ch.id}
                  className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-secondary/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium text-foreground">
                        {ch.name}
                      </span>
                    </div>
                    {ch.description && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {ch.description}
                      </p>
                    )}
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground/70">
                      <Users className="size-3" />
                      {ch.memberCount} member{ch.memberCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={joiningId === ch.id || joinChannel.isPending}
                    onClick={() => {
                      setJoiningId(ch.id);
                      joinChannel.mutate({ channelId: ch.id });
                    }}
                    className="mt-0.5 shrink-0"
                  >
                    {joiningId === ch.id ? <Loader2 className="animate-spin" /> : 'Join'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
