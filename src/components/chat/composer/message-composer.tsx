'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { useSession } from 'next-auth/react';
import { Paperclip, Send, X, Loader2, FileText, Mic } from 'lucide-react';
import { toast } from 'sonner';
import { browserUuid } from '@/lib/browser-uuid';
import { trpc } from '@/lib/trpc';
import { useChatTyping } from '@/lib/ably';
import { uploadAttachment } from '@/lib/chat/upload-client';
import { tiptapToPlainText, isEmptyDoc } from '@/lib/chat/tiptap';
import {
  MAX_ATTACHMENT_BYTES,
  type SendAttachmentInput,
  type ChatMessage,
  type TiptapDoc,
} from '@/lib/chat/contract';
import { cn } from '@/lib/utils';
import { createMentionExtension, ChatMentionPluginKey } from './mention-extension';
import { ComposerToolbar } from './composer-toolbar';
import { EmojiPicker } from './emoji-picker';
import { VoiceRecorder } from './voice-recorder';

export interface MessageComposerProps {
  channelId: string;
  /** Set for thread replies — the message is nested under this parent. */
  parentId?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  /** Fired after a send is dispatched (composer is already cleared). */
  onSent?: () => void;
}

// Restrained, primary-tinted child-element styling for the rich content. Kept
// local (Tailwind arbitrary-child selectors) so the composer renders correctly
// without depending on any global prose stylesheet.
const PROSE_CLASS = cn(
  'chat-composer-prose max-w-none px-3 py-2.5 text-sm leading-relaxed text-foreground focus:outline-none',
  '[&_p]:my-0 [&_strong]:font-semibold [&_em]:italic',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]',
  '[&_pre]:my-1.5 [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre]:text-xs [&_pre]:font-mono',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground'
);

const ICON_BTN =
  'flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground';

export function MessageComposer({
  channelId,
  parentId,
  placeholder,
  autoFocus,
  onSent,
}: MessageComposerProps) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const currentUserName = session?.user?.name ?? 'Someone';

  const utils = trpc.useUtils();
  const { emitTyping } = useChatTyping(currentUserId);

  const [attachments, setAttachments] = useState<SendAttachmentInput[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [isEmpty, setIsEmpty] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Refs let the editor's stable keydown/update handlers always see fresh logic.
  const submitRef = useRef<() => void>(() => {});
  const typingRef = useRef<() => void>(() => {});

  const sendMessage = trpc.chat.sendMessage.useMutation({
    // Optimistic: render the message INSTANTLY, then reconcile with the server
    // response. This hides the DB round-trip latency so sending feels instant.
    onMutate: async (vars) => {
      const tempId = `optimistic-${browserUuid()}`;
      const optimistic: ChatMessage = {
        id: tempId,
        channelId: vars.channelId,
        content: vars.content ?? '',
        contentJson: (vars.contentJson as TiptapDoc) ?? null,
        sender: {
          id: currentUserId ?? '',
          name: currentUserName,
          avatar: session?.user?.image ?? null,
          title: null,
        },
        parentId: vars.parentId ?? null,
        isEdited: false,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        reactions: [],
        attachments: (vars.attachments ?? []).map((a, i) => ({
          id: `${tempId}-att-${i}`,
          name: a.name,
          url: a.url,
          type: a.type ?? null,
          size: a.size ?? null,
          duration: a.duration ?? null,
        })),
        mentionIds: [],
        replyCount: 0,
        lastReplyAt: null,
        threadParticipants: [],
        isPinned: false,
        isSaved: false,
      };
      if (vars.parentId) {
        await utils.chat.getThread.cancel({ parentId: vars.parentId });
        utils.chat.getThread.setData({ parentId: vars.parentId }, (old) =>
          old ? { ...old, replies: [...old.replies, optimistic] } : old
        );
      } else {
        await utils.chat.getMessages.cancel({ channelId: vars.channelId });
        utils.chat.getMessages.setInfiniteData({ channelId: vars.channelId }, (old) => {
          if (!old || old.pages.length === 0) return old;
          const pages = old.pages.slice();
          pages[0] = { ...pages[0], items: [...pages[0].items, optimistic] };
          return { ...old, pages };
        });
      }
      return { tempId };
    },
    onSuccess: (message, vars, ctx) => {
      const tempId = ctx?.tempId;
      // Swap temp → real; if the realtime echo already inserted the real one,
      // just drop the temp (dedupe by real id).
      const reconcile = (items: ChatMessage[]) => {
        const withoutTemp = tempId ? items.filter((m) => m.id !== tempId) : items;
        return withoutTemp.some((m) => m.id === message.id)
          ? withoutTemp
          : [...withoutTemp, message];
      };
      if (message.parentId) {
        utils.chat.getThread.setData({ parentId: message.parentId }, (old) =>
          old ? { ...old, replies: reconcile(old.replies) } : old
        );
        return;
      }
      utils.chat.getMessages.setInfiniteData({ channelId: vars.channelId }, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p, i) =>
                i === 0
                  ? { ...p, items: reconcile(p.items) }
                  : tempId
                    ? { ...p, items: p.items.filter((m) => m.id !== tempId) }
                    : p
              ),
            }
          : old
      );
    },
    onError: (err, vars, ctx) => {
      const tempId = ctx?.tempId;
      if (tempId && vars.parentId) {
        utils.chat.getThread.setData({ parentId: vars.parentId }, (old) =>
          old ? { ...old, replies: old.replies.filter((m) => m.id !== tempId) } : old
        );
      } else if (tempId) {
        utils.chat.getMessages.setInfiniteData({ channelId: vars.channelId }, (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((p) => ({
                  ...p,
                  items: p.items.filter((m) => m.id !== tempId),
                })),
              }
            : old
        );
      }
      toast.error(err.message || 'Failed to send message');
    },
  });

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Chat messages: no headings / rules. Bundled Link is disabled so our
        // configured Link (below) is the single source of truth.
        heading: false,
        horizontalRule: false,
        link: false,
      }),
      Link.configure({ openOnClick: false, autolink: true }),
      createMentionExtension({
        channelId,
        getMentionTargets: (cid, query) =>
          utils.chat.getMentionTargets.fetch({ channelId: cid, q: query }),
      }),
    ],
    [channelId, utils]
  );

  const editor = useEditor(
    {
      extensions,
      content: '',
      autofocus: autoFocus ? 'end' : false,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: cn(PROSE_CLASS, 'min-h-[1.5rem]'),
          'aria-label': placeholder ?? 'Write a message',
        },
        handleKeyDown: (view, event) => {
          if (event.key !== 'Enter' || event.shiftKey) return false;
          // Don't submit mid-IME-composition.
          if (event.isComposing || event.keyCode === 229) return false;
          // Let the @-mention popup consume Enter while it's open.
          if (ChatMentionPluginKey.getState(view.state)?.active) return false;
          // Inside a code block, Enter inserts a newline — let it through.
          if (view.state.selection.$head.parent.type.name === 'codeBlock') return false;
          event.preventDefault();
          submitRef.current();
          return true;
        },
      },
      onUpdate: ({ editor: ed }) => {
        setIsEmpty(isEmptyDoc(ed.getJSON()));
        typingRef.current();
      },
    },
    // Recreate the editor (and thus rebind the channel-scoped mention source)
    // when the target channel changes.
    [channelId]
  );

  // Keep the typing emitter current for the editor's onUpdate closure.
  useEffect(() => {
    typingRef.current = () => {
      if (currentUserId) emitTyping(channelId, currentUserName);
    };
  }, [currentUserId, emitTyping, channelId, currentUserName]);

  const handleUploads = useCallback(async (files: FileList | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;

    for (const file of list) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name} is larger than 25 MB`);
        continue;
      }
      setUploadingCount((c) => c + 1);
      uploadAttachment(file)
        .then((att) => setAttachments((prev) => [...prev, att]))
        .catch((e) => toast.error(e instanceof Error ? e.message : 'Upload failed'))
        .finally(() => setUploadingCount((c) => c - 1));
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!editor) return;
    // Wait for in-flight uploads so they aren't dropped from the message.
    if (uploadingCount > 0) return;

    const contentJson = editor.getJSON();
    if (isEmptyDoc(contentJson) && attachments.length === 0) return;

    const content = tiptapToPlainText(contentJson);
    sendMessage.mutate({
      channelId,
      content,
      contentJson,
      parentId: parentId ?? undefined,
      attachments,
    });

    editor.commands.clearContent();
    setAttachments([]);
    setIsEmpty(true);
    onSent?.();
  }, [editor, uploadingCount, attachments, channelId, parentId, sendMessage, onSent]);

  useEffect(() => {
    submitRef.current = handleSubmit;
  }, [handleSubmit]);

  // A voice message is just a normal message carrying a single audio attachment
  // (and no text), so it reuses the same optimistic send path as everything else.
  const handleSendVoice = useCallback(
    (attachment: SendAttachmentInput) =>
      // Resolve only once the message is actually persisted. The VoiceRecorder
      // awaits this promise: on success we dismiss it (which revokes the blob),
      // and on failure it stays mounted so the user can retry the SAME clip.
      // The hook-level onError already rolls back the optimistic message + toasts.
      new Promise<void>((resolve, reject) => {
        sendMessage.mutate(
          {
            channelId,
            content: '',
            parentId: parentId ?? undefined,
            attachments: [attachment],
          },
          {
            onSuccess: () => {
              setVoiceOpen(false);
              onSent?.();
              resolve();
            },
            onError: (err) => reject(err),
          }
        );
      }),
    [sendMessage, channelId, parentId, onSent]
  );

  if (!editor) {
    return (
      <div className="flex h-[4.5rem] items-center justify-center rounded-xl border border-border/60 bg-card text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-3.5 animate-spin" />
        Loading composer…
      </div>
    );
  }

  const canSend = (!isEmpty || attachments.length > 0) && uploadingCount === 0;
  const hasPending = attachments.length > 0 || uploadingCount > 0;

  return (
    <div className="rounded-xl border border-border/60 bg-card transition-colors focus-within:border-border/80">
      {hasPending && (
        <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
          {attachments.map((att, i) => (
            <span
              key={att.url + i}
              className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-secondary/60 py-1 pl-2 pr-1 text-xs"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-[12rem] truncate text-foreground">{att.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`Remove ${att.name}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {Array.from({ length: uploadingCount }).map((_, i) => (
            <span
              key={`uploading-${i}`}
              className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-secondary/40 px-2 py-1 text-xs text-muted-foreground"
            >
              <Loader2 className="size-3.5 animate-spin" />
              Uploading…
            </span>
          ))}
        </div>
      )}

      {voiceOpen ? (
        <VoiceRecorder onSend={handleSendVoice} onCancel={() => setVoiceOpen(false)} />
      ) : (
        <>
          <div className="relative max-h-[40vh] overflow-y-auto">
            {isEmpty && (
              <div className="pointer-events-none absolute left-3 top-2.5 select-none text-sm text-muted-foreground/70">
                {placeholder ?? 'Write a message…'}
              </div>
            )}
            <EditorContent editor={editor} />
          </div>

          <div className="flex items-center gap-0.5 px-2 pb-1.5 pt-0.5">
            <ComposerToolbar editor={editor} />

            <span className="mx-1 h-4 w-px bg-border" />

            <EmojiPicker onPick={(emoji) => editor.chain().focus().insertContent(emoji).run()} />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={ICON_BTN}
              title="Attach a file"
              aria-label="Attach a file"
            >
              <Paperclip className="size-4" />
            </button>

            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              className={ICON_BTN}
              title="Record a voice message"
              aria-label="Record a voice message"
            >
              <Mic className="size-4" />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void handleUploads(e.target.files);
                e.target.value = '';
              }}
            />

            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend}
              title="Send message"
              aria-label="Send message"
              className={cn(
                'ml-auto flex size-8 items-center justify-center rounded-lg transition-colors',
                canSend
                  ? 'text-muted-foreground hover:bg-[#bc8850]/10 hover:text-[#bc8850] active:text-[#bc8850]'
                  : 'cursor-not-allowed text-muted-foreground/30'
              )}
            >
              {sendMessage.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
