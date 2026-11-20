'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { trpc } from '@/lib/trpc';

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channelId: string) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [topic, setTopic] = useState('');
  const [type, setType] = useState<'GROUP' | 'PROJECT'>('GROUP');
  const [isPrivate, setIsPrivate] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState('');

  const { data: team } = trpc.team.getAll.useQuery(undefined, { enabled: open });

  const createChannel = trpc.chat.createChannel.useMutation({
    onSuccess: (channel) => {
      utils.chat.getChannels.invalidate();
      toast.success(`#${channel.name ?? 'channel'} created`);
      onCreated(channel.id);
      resetForm();
    },
    onError: (err) => toast.error(err.message ?? 'Could not create channel'),
  });

  function resetForm() {
    setName('');
    setDescription('');
    setTopic('');
    setType('GROUP');
    setIsPrivate(false);
    setSelectedMembers([]);
    setMemberSearch('');
  }

  const memberSearchQ = memberSearch.toLowerCase().trim();
  const filteredTeam = memberSearchQ
    ? team?.filter((m) => m.name.toLowerCase().includes(memberSearchQ))
    : team;

  const handleSubmit = () => {
    if (!name.trim()) return;
    createChannel.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      topic: topic.trim() || undefined,
      type,
      isPrivate,
      memberIds: selectedMembers,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!createChannel.isPending) onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              autoFocus
              placeholder="e.g. design-feedback"
              value={name}
              onChange={(e) =>
                setName(
                  e.target.value
                    .toLowerCase()
                    .replace(/\s+/g, '-')
                    .replace(/[^a-z0-9-]/g, '')
                )
              }
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">Description</label>
            <Input
              placeholder="What's this channel about?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Topic */}
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">Topic</label>
            <Input
              placeholder="Current focus or status"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>

          {/* Type + Privacy row */}
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-foreground">Type</label>
              <StudioSelect
                value={type}
                onChange={(e) => setType(e.target.value as 'GROUP' | 'PROJECT')}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="GROUP">Group</option>
                <option value="PROJECT">Project</option>
              </StudioSelect>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-foreground">Private</label>
              <div className="flex h-8 items-center">
                <Switch checked={isPrivate} onCheckedChange={setIsPrivate} size="sm" />
              </div>
            </div>
          </div>

          {/* Member picker */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">Add members</label>
            <Input
              placeholder="Search teammates..."
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              className="mb-2"
            />
            <ScrollArea className="h-36 rounded-lg border border-border/60 bg-secondary/30">
              <div className="space-y-0.5 p-1.5">
                {filteredTeam?.map((member) => {
                  const checked = selectedMembers.includes(member.id);
                  return (
                    <label
                      key={member.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          setSelectedMembers((prev) =>
                            v ? [...prev, member.id] : prev.filter((id) => id !== member.id)
                          )
                        }
                      />
                      <Avatar size="sm">
                        <AvatarImage src={member.avatar ?? undefined} />
                        <AvatarFallback>{member.name[0]}</AvatarFallback>
                      </Avatar>
                      <span className="flex-1 text-sm text-foreground">{member.name}</span>
                      {member.title && (
                        <span className="max-w-[100px] truncate text-xs text-muted-foreground">
                          {member.title}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </ScrollArea>
            {selectedMembers.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedMembers.length} member
                {selectedMembers.length !== 1 ? 's' : ''} selected
              </p>
            )}
          </div>
        </div>

        <DialogFooter showCloseButton>
          <Button onClick={handleSubmit} disabled={!name.trim() || createChannel.isPending}>
            {createChannel.isPending && <Loader2 className="animate-spin" />}
            Create Channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
