'use client';

/**
 * Inline, self-contained Tiptap editor for editing a sent message.
 *
 * Seeded from `contentJson` (falling back to plaintext). On save we derive the
 * authoritative plaintext + mention ids from the editor JSON via the shared
 * tiptap helpers and call `chat.editMessage`. StarterKit covers the message
 * formatting; Link + Mention are included only so existing links/mentions
 * survive a round-trip instead of being stripped.
 */
import * as React from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Mention } from '@tiptap/extension-mention';
import { toast } from 'sonner';

import type { ChatMessage } from '@/lib/chat/contract';
import {
  tiptapToPlainText,
  extractMentionIds,
  plainTextToTiptap,
} from '@/lib/chat/tiptap';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function MessageEditor({
  message,
  onDone,
}: {
  message: ChatMessage;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();

  const editMessage = trpc.chat.editMessage.useMutation({
    onSuccess: () => {
      utils.chat.getMessages.invalidate({ channelId: message.channelId });
      utils.chat.getThread.invalidate();
      onDone();
    },
    onError: (err) => {
      toast.error(err.message || 'Could not save your edit');
    },
  });

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Mention,
    ],
    content: message.contentJson ?? plainTextToTiptap(message.content),
    immediatelyRender: false,
    autofocus: 'end',
    editorProps: {
      attributes: {
        class:
          'min-h-[2.25rem] max-h-64 overflow-y-auto px-3 py-2 text-[0.9375rem] leading-relaxed text-foreground focus:outline-none',
      },
    },
  });

  const save = React.useCallback(() => {
    if (!editor || editMessage.isPending) return;
    const json = editor.getJSON();
    const content = tiptapToPlainText(json);
    if (!content.trim()) {
      toast.error('Message can’t be empty — delete it instead');
      return;
    }
    editMessage.mutate({
      messageId: message.id,
      content,
      contentJson: json,
      mentionIds: extractMentionIds(json),
    });
  }, [editor, editMessage, message.id]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDone();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="mt-0.5" onKeyDown={handleKeyDown}>
      <div className="rounded-xl border border-border bg-background focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15 transition-colors">
        <EditorContent editor={editor} />
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Button size="xs" onClick={save} disabled={editMessage.isPending}>
          {editMessage.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDone} disabled={editMessage.isPending}>
          Cancel
        </Button>
        <span className="text-[11px] text-muted-foreground">
          <kbd className={cn('font-sans')}>Esc</kbd> to cancel ·{' '}
          <kbd className="font-sans">⌘↵</kbd> to save
        </span>
      </div>
    </div>
  );
}
