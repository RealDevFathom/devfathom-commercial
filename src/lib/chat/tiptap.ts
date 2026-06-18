/**
 * Shared Tiptap helpers for chat rich messages.
 *
 * Used by the composer (produce), the message renderer (consume), and the
 * backend (authoritatively derive plaintext + mention ids from contentJson —
 * NEVER trust client-sent `content`/`mentionIds`). Pure + dependency-light.
 */
import type { TiptapDoc, TiptapNode } from './contract';

/** Tiptap node name for an @mention (matches @tiptap/extension-mention). */
export const MENTION_NODE = 'mention';

/** Flatten a Tiptap doc to plaintext. Mentions become `@Label`; blocks break. */
export function tiptapToPlainText(doc: unknown): string {
  const root = doc as TiptapNode | null | undefined;
  if (!root || typeof root !== 'object') return '';
  const out: string[] = [];
  walk(root, out);
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function walk(node: TiptapNode, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'text' && typeof node.text === 'string') {
    out.push(node.text);
    return;
  }
  if (node.type === MENTION_NODE) {
    const label = (node.attrs?.label as string) || (node.attrs?.id as string) || 'unknown';
    out.push(`@${label}`);
    return;
  }
  if (node.type === 'hardBreak') {
    out.push('\n');
    return;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, out);
  }
  const t = node.type ?? '';
  if (
    t === 'paragraph' ||
    t === 'heading' ||
    t.endsWith('List') ||
    t === 'listItem' ||
    t === 'blockquote' ||
    t === 'codeBlock'
  ) {
    out.push('\n');
  }
}

/** Collect mentioned user ids from a Tiptap doc (deduped, order-preserving). */
export function extractMentionIds(doc: unknown): string[] {
  const ids = new Set<string>();
  collectMentions(doc as TiptapNode | null | undefined, ids);
  return [...ids];
}

function collectMentions(node: TiptapNode | null | undefined, ids: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === MENTION_NODE) {
    const id = node.attrs?.id;
    if (typeof id === 'string' && id) ids.add(id);
  }
  if (Array.isArray(node.content)) {
    for (const c of node.content) collectMentions(c, ids);
  }
}

/** True when a Tiptap doc has no visible content (empty composer). */
export function isEmptyDoc(doc: unknown): boolean {
  return tiptapToPlainText(doc).length === 0;
}

/** Build a minimal Tiptap doc from plaintext (legacy/system messages). */
export function plainTextToTiptap(text: string): TiptapDoc {
  return {
    type: 'doc',
    content: (text || '').split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}
