'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Minus,
  Undo2,
  Redo2,
  Link as LinkIcon,
  Table as TableIcon,
  Loader2,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { NoteLink } from './note-link-extension';
import { NoteLinkList, type NoteLinkListHandle, type NoteLinkItem } from './note-link-list';

export interface NoteEditorProps {
  initialContent?: unknown;
  editable: boolean;
  /** Called (debounced) when the content changes. */
  onChange?: (json: unknown) => void;
  /** Called when the user picks "Create new" from the [[ popup. */
  onCreateLinkedNote?: (title: string) => Promise<{ id: string; title: string }>;
  /** Optional saving indicator state from the parent. */
  saving?: boolean;
}

const DEFAULT_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

export function NoteEditor({
  initialContent,
  editable,
  onChange,
  onCreateLinkedNote,
  saving,
}: NoteEditorProps) {
  const utils = trpc.useUtils();
  // We hold a ref to the latest create handler so the suggestion plugin
  // (which is built once with the editor) always sees the freshest version.
  const createRef = useRef(onCreateLinkedNote);
  useEffect(() => {
    createRef.current = onCreateLinkedNote;
  }, [onCreateLinkedNote]);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { class: 'note-codeblock' } },
      }),
      // IMP-NOTE-05: with autolink on, restrict the recognised link protocols to
      // http/https/mailto (cheap defense-in-depth against javascript:/data: URLs).
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      NoteLink.configure({
        HTMLAttributes: { class: 'note-link' },
        suggestion: {
          char: '[[',
          allowSpaces: true,
          startOfLine: false,
          items: async ({ query }) => {
            if (!query.trim()) return [];
            return utils.notes.search.fetch({ query });
          },
          render: () => {
            let component: ReactRenderer<NoteLinkListHandle> | null = null;
            let popup: HTMLDivElement | null = null;

            const positionPopup = (rect: DOMRect | null) => {
              if (!popup || !rect) return;
              popup.style.top = `${rect.bottom + 6}px`;
              popup.style.left = `${rect.left}px`;
            };

            const handlePick = async (
              item: NoteLinkItem,
              editor: import('@tiptap/core').Editor,
              range: { from: number; to: number }
            ) => {
              let id = item.id;
              let title = item.title;
              if (item.isCreate) {
                const create = createRef.current;
                if (!create) return;
                const created = await create(title);
                id = created.id;
                title = created.title;
              }
              editor
                .chain()
                .focus()
                .insertContentAt(range, [
                  { type: 'noteLink', attrs: { id, title } },
                  { type: 'text', text: ' ' },
                ])
                .run();
            };

            return {
              onStart: (props) => {
                popup = document.createElement('div');
                popup.style.position = 'fixed';
                popup.style.zIndex = '9999';
                document.body.appendChild(popup);
                component = new ReactRenderer<
                  NoteLinkListHandle,
                  React.ComponentProps<typeof NoteLinkList>
                >(NoteLinkList, {
                  props: {
                    items: props.items as NoteLinkItem[],
                    query: props.query,
                    command: (item: NoteLinkItem) => handlePick(item, props.editor, props.range),
                  },
                  editor: props.editor,
                });
                popup.appendChild(component.element);
                positionPopup(props.clientRect?.() ?? null);
              },
              onUpdate: (props) => {
                component?.updateProps({
                  items: props.items as NoteLinkItem[],
                  query: props.query,
                  command: (item: NoteLinkItem) => handlePick(item, props.editor, props.range),
                });
                positionPopup(props.clientRect?.() ?? null);
              },
              onKeyDown: (props) => {
                if (props.event.key === 'Escape') {
                  popup?.remove();
                  popup = null;
                  component?.destroy();
                  component = null;
                  return true;
                }
                return component?.ref?.onKeyDown(props.event) ?? false;
              },
              onExit: () => {
                popup?.remove();
                popup = null;
                component?.destroy();
                component = null;
              },
            };
          },
        },
      }),
    ],
    [utils]
  );

  const editor = useEditor({
    extensions,
    // initialContent is only read when this component mounts. The parent should
    // pass a stable `key={noteId}` so React remounts the editor when switching
    // notes — this avoids the old sync effect that was stomping the cursor on
    // every query refetch.
    content: initialContent ?? DEFAULT_DOC,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'note-prose focus:outline-none min-h-[calc(100vh-22rem)] px-2 py-3 text-[15px] leading-relaxed text-foreground',
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.(editor.getJSON());
    },
  });

  // Update editable state when prop changes (e.g. visibility change removes edit perm)
  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  if (!editor) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading editor…
      </div>
    );
  }

  return (
    // min-w-0 so this wrapper can shrink inside its flex/grid parent —
    // otherwise long content in the editor would stretch the container.
    <div className="space-y-3 min-w-0 max-w-full overflow-hidden">
      {editable && <EditorToolbar editor={editor} saving={saving} />}
      <EditorContent editor={editor} />
    </div>
  );
}

function EditorToolbar({
  editor,
  saving,
}: {
  editor: import('@tiptap/react').Editor;
  saving?: boolean;
}) {
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const btn = (active: boolean) =>
    cn(
      'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
      active
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
    );

  const insertLink = () => {
    if (!linkUrl.trim()) {
      setLinkInputOpen(false);
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl.trim() }).run();
    setLinkUrl('');
    setLinkInputOpen(false);
  };

  return (
    <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-card/80 px-2 py-1.5 backdrop-blur">
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={btn(editor.isActive('bold'))}
        title="Bold (⌘B)"
      >
        <Bold className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={btn(editor.isActive('italic'))}
        title="Italic (⌘I)"
      >
        <Italic className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={btn(editor.isActive('strike'))}
        title="Strikethrough"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={btn(editor.isActive('code'))}
        title="Inline code"
      >
        <Code className="h-3.5 w-3.5" />
      </button>

      <span className="mx-1 h-5 w-px bg-border" />

      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        className={btn(editor.isActive('heading', { level: 1 }))}
        title="Heading 1"
      >
        <Heading1 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        className={btn(editor.isActive('heading', { level: 2 }))}
        title="Heading 2"
      >
        <Heading2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        className={btn(editor.isActive('heading', { level: 3 }))}
        title="Heading 3"
      >
        <Heading3 className="h-3.5 w-3.5" />
      </button>

      <span className="mx-1 h-5 w-px bg-border" />

      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={btn(editor.isActive('bulletList'))}
        title="Bullet list"
      >
        <List className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={btn(editor.isActive('orderedList'))}
        title="Ordered list"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        className={btn(editor.isActive('blockquote'))}
        title="Quote"
      >
        <Quote className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        className={btn(false)}
        title="Divider"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>

      <span className="mx-1 h-5 w-px bg-border" />

      <button
        type="button"
        onClick={() => setLinkInputOpen((v) => !v)}
        className={btn(editor.isActive('link') || linkInputOpen)}
        title="Insert link"
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
        className={btn(false)}
        title="Insert table"
      >
        <TableIcon className="h-3.5 w-3.5" />
      </button>

      <span className="mx-1 h-5 w-px bg-border" />

      <button
        type="button"
        onClick={() => editor.chain().focus().undo().run()}
        className={btn(false)}
        title="Undo"
      >
        <Undo2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().redo().run()}
        className={btn(false)}
        title="Redo"
      >
        <Redo2 className="h-3.5 w-3.5" />
      </button>

      {saving && (
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving…
        </div>
      )}

      {linkInputOpen && (
        <div className="basis-full flex items-center gap-2 mt-1.5 pl-1">
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') insertLink();
              if (e.key === 'Escape') {
                setLinkInputOpen(false);
                setLinkUrl('');
              }
            }}
            placeholder="https://…"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="button"
            onClick={insertLink}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().unsetLink().run();
              setLinkInputOpen(false);
            }}
            className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
