'use client';

import { useState } from 'react';
import { Search, Loader2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useIsOnline } from '@/lib/chat/realtime-store';

export function NewDmDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channelId: string) => void;
}) {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);

  const { data: team, isLoading } = trpc.team.getAll.useQuery(undefined, { enabled: open });

  const createOrGetDM = trpc.chat.createOrGetDM.useMutation({
    onSuccess: (channel) => {
      utils.chat.getChannels.invalidate();
      onCreated(channel.id);
      setOpeningId(null);
    },
    onError: (err) => {
      toast.error(err.message ?? 'Could not open DM');
      setOpeningId(null);
    },
  });

  const q = search.toLowerCase().trim();
  const filtered = q
    ? team?.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q)
      )
    : team;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New direct message</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Find a teammate..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        <ScrollArea className="h-64">
          {isLoading ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-lg" />
              ))}
            </div>
          ) : !filtered?.length ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <MessageSquare className="mb-2 size-7 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">
                {q ? 'No teammates match.' : 'No teammates found.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5 p-1">
              {filtered.map((member) => (
                <DmRow
                  key={member.id}
                  member={member}
                  loading={openingId === member.id}
                  onClick={() => {
                    if (openingId) return;
                    setOpeningId(member.id);
                    createOrGetDM.mutate({ userId: member.id });
                  }}
                />
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function DmRow({
  member,
  loading,
  onClick,
}: {
  member: { id: string; name: string; avatar: string | null; title?: string | null; email: string };
  loading: boolean;
  onClick: () => void;
}) {
  const online = useIsOnline(member.id);

  return (
    <li>
      <button
        onClick={onClick}
        disabled={loading}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-secondary/70 disabled:opacity-50"
      >
        <span className="relative shrink-0">
          <Avatar size="sm">
            <AvatarImage src={member.avatar ?? undefined} />
            <AvatarFallback>{member.name[0]}</AvatarFallback>
          </Avatar>
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-popover',
              online ? 'bg-emerald-500' : 'border border-muted-foreground/40'
            )}
          />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-sm font-medium text-foreground">{member.name}</span>
          {member.title && (
            <span className="block truncate text-xs text-muted-foreground">{member.title}</span>
          )}
        </span>
        {loading && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </button>
    </li>
  );
}
