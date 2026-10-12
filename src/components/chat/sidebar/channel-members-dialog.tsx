'use client';

import { useState } from 'react';
import { X, UserPlus, Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useSession } from 'next-auth/react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useIsOnline } from '@/lib/chat/realtime-store';
import type { ChatChannelMemberLite } from '@/lib/chat/contract';

export function ChannelMembersDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const [showAdd, setShowAdd] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]);

  const { data: members, isLoading } = trpc.chat.getMembers.useQuery(
    { channelId },
    { enabled: open }
  );

  const { data: team } = trpc.team.getAll.useQuery(undefined, {
    enabled: open && showAdd,
  });

  const addMembers = trpc.chat.addMembers.useMutation({
    onSuccess: () => {
      utils.chat.getMembers.invalidate({ channelId });
      utils.chat.getChannels.invalidate();
      toast.success('Members added');
      setSelectedToAdd([]);
      setShowAdd(false);
      setAddSearch('');
    },
    onError: (err) => toast.error(err.message ?? 'Could not add members'),
  });

  const removeMember = trpc.chat.removeMember.useMutation({
    onSuccess: () => {
      utils.chat.getMembers.invalidate({ channelId });
      utils.chat.getChannels.invalidate();
      toast.success('Member removed');
    },
    onError: (err) => toast.error(err.message ?? 'Could not remove member'),
  });

  const viewerId = session?.user?.id;
  const viewerMember = members?.find((m) => m.id === viewerId);
  const isElevated = viewerMember?.role === 'OWNER' || viewerMember?.role === 'ADMIN';

  // Exclude current members from add picker
  const memberIds = new Set(members?.map((m) => m.id) ?? []);
  const addSearchQ = addSearch.toLowerCase().trim();
  const candidateTeam = team?.filter((m) => {
    if (memberIds.has(m.id)) return false;
    if (!addSearchQ) return true;
    return m.name.toLowerCase().includes(addSearchQ);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" />
            Members
            {members && (
              <Badge variant="secondary" className="ml-1 font-mono text-xs">
                {members.length}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-72">
          {isLoading ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <ul className="space-y-0.5 p-1">
              {members?.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  canRemove={isElevated && member.id !== viewerId}
                  removing={removeMember.isPending}
                  onRemove={() => removeMember.mutate({ channelId, userId: member.id })}
                />
              ))}
            </ul>
          )}
        </ScrollArea>

        {/* Add people — elevated viewer only */}
        {isElevated && (
          <>
            <Separator />
            {showAdd ? (
              <div className="space-y-2">
                <Input
                  autoFocus
                  placeholder="Search teammates..."
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                />
                <ScrollArea className="h-40 rounded-lg border border-border/60 bg-secondary/30">
                  <div className="space-y-0.5 p-1">
                    {candidateTeam?.map((m) => (
                      <label
                        key={m.id}
                        className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary"
                      >
                        <Checkbox
                          checked={selectedToAdd.includes(m.id)}
                          onCheckedChange={(v) =>
                            setSelectedToAdd((prev) =>
                              v ? [...prev, m.id] : prev.filter((id) => id !== m.id)
                            )
                          }
                        />
                        <Avatar size="sm">
                          <AvatarImage src={m.avatar ?? undefined} />
                          <AvatarFallback>{m.name[0]}</AvatarFallback>
                        </Avatar>
                        <span className="text-sm text-foreground">{m.name}</span>
                      </label>
                    ))}
                    {candidateTeam?.length === 0 && (
                      <p className="py-4 text-center text-xs text-muted-foreground">
                        {addSearchQ ? 'No results.' : 'Everyone is already a member.'}
                      </p>
                    )}
                  </div>
                </ScrollArea>
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowAdd(false);
                      setSelectedToAdd([]);
                      setAddSearch('');
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={selectedToAdd.length === 0 || addMembers.isPending}
                    onClick={() => addMembers.mutate({ channelId, userIds: selectedToAdd })}
                  >
                    {addMembers.isPending && <Loader2 className="animate-spin" />}
                    Add{selectedToAdd.length > 0 ? ` ${selectedToAdd.length}` : ''} member
                    {selectedToAdd.length !== 1 ? 's' : ''}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAdd(true)}
                className="w-full"
              >
                <UserPlus className="size-3.5" />
                Add people
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  canRemove,
  removing,
  onRemove,
}: {
  member: ChatChannelMemberLite;
  canRemove: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const online = useIsOnline(member.id);
  const roleLabel = member.role === 'OWNER' ? 'Owner' : member.role === 'ADMIN' ? 'Admin' : null;

  return (
    <li className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary/50">
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

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{member.name}</span>
      </span>

      {roleLabel && (
        <Badge variant="secondary" className="h-4 shrink-0 text-[10px]">
          {roleLabel}
        </Badge>
      )}

      {canRemove && (
        <button
          onClick={onRemove}
          disabled={removing}
          title="Remove from channel"
          className="invisible flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 group-hover:visible"
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}
