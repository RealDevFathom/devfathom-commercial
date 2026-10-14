import { mergeAttributes, Node } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';

export interface NoteLinkOptions {
  HTMLAttributes: Record<string, unknown>;
  suggestion: Omit<SuggestionOptions, 'editor'>;
}

export const NoteLinkPluginKey = new PluginKey('noteLink');

/**
 * A Tiptap node representing an inline reference to another note,
 * inserted via the `[[` trigger (Obsidian-style wiki-link).
 *
 * Stored attrs: { id, title }
 * Renders as: <a data-note-link href="/notes/:id">title</a>
 */
export const NoteLink = Node.create<NoteLinkOptions>({
  name: 'noteLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
      suggestion: {
        char: '[[',
        allowSpaces: true,
        startOfLine: false,
        pluginKey: NoteLinkPluginKey,
        command: ({ editor, range, props }) => {
          const node = props as { id: string; title: string };
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'noteLink', attrs: { id: node.id, title: node.title } },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
      },
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
      },
      title: {
        default: null,
        parseHTML: (el) =>
          (el as HTMLElement).getAttribute('data-title') ?? (el as HTMLElement).innerText,
        renderHTML: (attrs) => (attrs.title ? { 'data-title': attrs.title } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-note-link]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string | null;
    const title = (node.attrs.title as string | null) ?? 'Untitled';
    return [
      'a',
      mergeAttributes(
        {
          'data-note-link': '',
          href: id ? `/notes/${id}` : '#',
          class: 'note-link',
        },
        this.options.HTMLAttributes,
        HTMLAttributes
      ),
      `[[${title}]]`,
    ];
  },

  renderText({ node }) {
    return `[[${(node.attrs.title as string | null) ?? ''}]]`;
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
