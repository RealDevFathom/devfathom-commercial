'use client';

/**
 * A single message row, Slack-style (left avatar, full-width content).
 *
 * `grouped` rows are tight and hide the avatar/name/timestamp (a hover time
 * shows in the gutter instead). Handles: deleted tombstone, edited tag, mention
 * highlight, attachments (image thumbs vs file chips), reactions, the thread
 * affordance, inline editing, and the hover action bar.
 */
import * as React from 'react';
import { useSession } from 'next-auth/react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { FileText, Download } from 'lucide-react';

import type { ChatMessage } from '@/lib/chat/contract';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageContent } from './message-content';
import { MessageActions } from './message-actions';
import { ReactionBar } from './reaction-bar';
import { MessageEditor } from './message-editor';
import { ThreadPanel } from './thread-panel';

function initials(name: string): string {
  return (
    name
      .split(' ')
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function MessageItem({
  message,
  grouped,
  channelId,
  inThread = false,
}: {
  message: ChatMessage;
  grouped: boolean;
  channelId: string;
  /** Rendered inside the thread panel — suppress the nested thread affordance. */
  inThread?: boolean;
}) {
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';
  const [editing, setEditing] = React.useState(false);
  const [threadOpen, setThreadOpen] = React.useState(false);

  const date = new Date(message.createdAt);
  const mentionsMe = !!myId && message.mentionIds.includes(myId);
  const showThread = !inThread && message.replyCount > 0;

  if (message.deletedAt) {
    return (
      <div
        className={cn(
          'flex gap-3 border-l-2 border-transparent px-4',
          grouped ? 'py-0.5' : 'mt-3 py-0.5'
        )}
      >
        <div className="w-9 shrink-0" />
        <p className="text-sm italic text-muted-foreground/70">This message was deleted</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative flex gap-3 rounded-md border-l-2 border-transparent px-4 transition-colors hover:bg-muted/40',
        grouped ? 'py-0.5' : 'mt-3 py-1',
        mentionsMe && 'border-brass/70 bg-brass/[0.04] hover:bg-brass/[0.07]'
      )}
    >
      {/* Gutter: avatar for a group's first message, hover-time for the rest. */}
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="hidden pt-0.5 text-right text-[10px] leading-5 text-muted-foreground tabular-nums group-hover:block">
            {format(date, 'h:mm')}
          </span>
        ) : (
          <Avatar className="mt-0.5 size-9">
            <AvatarImage src={message.sender.avatar ?? undefined} alt={message.sender.name} />
            <AvatarFallback className="bg-secondary text-[11px] font-medium">
              {initials(message.sender.name)}
            </AvatarFallback>
          </Avatar>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-foreground">{message.sender.name}</span>
            <Tooltip>
              <TooltipTrigger
                render={<time className="cursor-default text-[11px] text-muted-foreground" />}
              >
                {format(date, 'h:mm a')}
              </TooltipTrigger>
              <TooltipContent>{format(date, 'EEEE, MMMM d, yyyy · h:mm a')}</TooltipContent>
            </Tooltip>
          </div>
        )}

        {editing ? (
          <MessageEditor message={message} onDone={() => setEditing(false)} />
        ) : (
          <>
            <span className="align-baseline">
              <MessageContent doc={message.contentJson} fallback={message.content} />
            </span>
            {message.isEdited && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="ml-1 inline-block cursor-default text-[10px] text-muted-foreground" />
                  }
                >
                  (edited)
                </TooltipTrigger>
                {message.editedAt && (
                  <TooltipContent>
                    Edited {format(new Date(message.editedAt), 'MMM d, h:mm a')}
                  </TooltipContent>
                )}
              </Tooltip>
            )}

            {message.attachments.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-2">
                {message.attachments.map((att) => {
                  const isImage = !!att.type && att.type.startsWith('image/');
                  if (isImage) {
                    return (
                      <a
                        key={att.id}
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block overflow-hidden rounded-lg border border-border/60"
                        title={att.name}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={att.url}
                          alt={att.name}
                          loading="lazy"
                          className="max-h-64 max-w-xs object-cover transition-opacity hover:opacity-90"
                        />
                      </a>
                    );
                  }
                  return (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={att.name}
                      className="group/att flex max-w-xs items-center gap-2.5 rounded-lg border border-border/60 bg-card px-3 py-2 transition-colors hover:border-border hover:bg-muted/50"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <FileText className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {att.name}
                        </span>
                        {att.size != null && (
                          <span className="block text-[11px] text-muted-foreground">
                            {formatBytes(att.size)}
                          </span>
                        )}
                      </span>
                      <Download className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover/att:text-foreground" />
                    </a>
                  );
                })}
              </div>
            )}

            <ReactionBar message={message} channelId={channelId} />

            {showThread && (
              <button
                type="button"
                onClick={() => setThreadOpen(true)}
                aria-label={`Open thread, ${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`}
                className="mt-1.5 inline-flex items-center gap-2 rounded-lg border border-border/60 bg-card py-1 pr-3 pl-1.5 transition-colors hover:border-border hover:bg-muted/50"
              >
                <span className="flex -space-x-1.5">
                  {message.threadParticipants.slice(0, 3).map((p) => (
                    <Avatar key={p.id} className="size-5 ring-2 ring-card">
                      <AvatarImage src={p.avatar ?? undefined} alt={p.name} />
                      <AvatarFallback className="bg-secondary text-[8px] font-medium">
                        {initials(p.name)}
                      </AvatarFallback>
                    </Avatar>
                  ))}
                </span>
                <span className="text-xs font-semibold text-primary">
                  {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
                </span>
                {message.lastReplyAt && (
                  <span className="text-[11px] text-muted-foreground">
                    Last reply{' '}
                    {formatDistanceToNowStrict(new Date(message.lastReplyAt), { addSuffix: true })}
                  </span>
                )}
              </button>
            )}
          </>
        )}
      </div>

      {!editing && (
        <MessageActions
          message={message}
          channelId={channelId}
          onReplyInThread={() => setThreadOpen(true)}
          onEdit={() => setEditing(true)}
          hideReplyInThread={inThread}
        />
      )}

      {!inThread && (
        <ThreadPanel
          channelId={channelId}
          parentId={message.id}
          open={threadOpen}
          onOpenChange={setThreadOpen}
        />
      )}
    </div>
  );
}
