'use client';

import { useState } from 'react';
import { Bold, Italic, Strikethrough, Code, SquareCode, List, ListOrdered, Link2 } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { cn } from '@/lib/utils';

/**
 * Inline formatting toolbar for the message composer. Buttons are styled with
 * the same `btn()` helper look as note-editor.tsx's EditorToolbar. Operates on
 * the passed-in editor instance.
 */
export function ComposerToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const btn = (active: boolean) =>
    cn(
      'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
      active
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
    );

  const divider = <span className="mx-0.5 h-4 w-px bg-border" />;

  const insertLink = () => {
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().unsetLink().run();
      setLinkOpen(false);
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkUrl('');
    setLinkOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={btn(editor.isActive('bold'))}
        title="Bold (⌘B)"
      >
        <Bold className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={btn(editor.isActive('italic'))}
        title="Italic (⌘I)"
      >
        <Italic className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={btn(editor.isActive('strike'))}
        title="Strikethrough"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </button>

      {divider}

      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={btn(editor.isActive('code'))}
        title="Inline code"
      >
        <Code className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        className={btn(editor.isActive('codeBlock'))}
        title="Code block"
      >
        <SquareCode className="h-3.5 w-3.5" />
      </button>

      {divider}

      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={btn(editor.isActive('bulletList'))}
        title="Bulleted list"
      >
        <List className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={btn(editor.isActive('orderedList'))}
        title="Numbered list"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </button>

      {divider}

      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setLinkUrl(editor.getAttributes('link').href ?? '');
          setLinkOpen((v) => !v);
        }}
        className={btn(editor.isActive('link') || linkOpen)}
        title="Insert link"
      >
        <Link2 className="h-3.5 w-3.5" />
      </button>

      {linkOpen && (
        <div className="mt-1 flex basis-full items-center gap-2 pl-0.5">
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                insertLink();
              }
              if (e.key === 'Escape') {
                setLinkOpen(false);
                setLinkUrl('');
                editor.chain().focus().run();
              }
            }}
            placeholder="https://…"
            className="h-7 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="button"
            onClick={insertLink}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().unsetLink().run();
              setLinkOpen(false);
              setLinkUrl('');
            }}
            className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
