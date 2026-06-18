'use client';

/**
 * Static, XSS-safe renderer for a chat message's Tiptap JSON.
 *
 * Walks the document tree and emits React elements directly — NEVER
 * dangerouslySetInnerHTML. Only http/https/mailto links are turned into
 * anchors; everything else degrades to plain text. When the doc is empty we
 * fall back to the flattened plaintext with light URL auto-linking.
 */
import * as React from 'react';
import type { TiptapNode, TiptapDoc } from '@/lib/chat/contract';
import { isEmptyDoc } from '@/lib/chat/tiptap';
import { cn } from '@/lib/utils';

// Element-level typography lives on the wrapper so each emitted node stays clean.
const PROSE = cn(
  'text-[0.9375rem] leading-relaxed text-foreground break-words [overflow-wrap:anywhere]',
  '[&_p]:my-0 [&_p:not(:first-child)]:mt-2',
  '[&_a]:text-primary [&_a]:underline [&_a]:decoration-primary/40 [&_a]:underline-offset-2 hover:[&_a]:decoration-primary',
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border/60 [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre]:leading-relaxed',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground',
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li]:pl-0.5',
  '[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground'
);

const SAFE_HREF = /^(https?:|mailto:)/i;
// Conservative bare-URL matcher for the plaintext fallback (trailing punctuation trimmed).
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;!?")\]}])/gi;

/** Apply marks innermost→outermost so links wrap the whole styled run. */
const MARK_RANK: Record<string, number> = {
  code: 0,
  strike: 1,
  italic: 2,
  underline: 3,
  bold: 4,
  link: 9,
};

function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const href = raw.trim();
  return SAFE_HREF.test(href) ? href : null;
}

function renderText(node: TiptapNode, key: string): React.ReactNode {
  const text = node.text ?? '';
  if (!text) return null;
  const marks = Array.isArray(node.marks) ? [...node.marks] : [];
  marks.sort((a, b) => (MARK_RANK[a.type] ?? 5) - (MARK_RANK[b.type] ?? 5));

  let el: React.ReactNode = text;
  marks.forEach((mark, i) => {
    const k = `${key}~${i}`;
    switch (mark.type) {
      case 'bold':
        el = <strong key={k}>{el}</strong>;
        break;
      case 'italic':
        el = <em key={k}>{el}</em>;
        break;
      case 'strike':
        el = <s key={k}>{el}</s>;
        break;
      case 'underline':
        el = <u key={k}>{el}</u>;
        break;
      case 'code':
        el = <code key={k}>{el}</code>;
        break;
      case 'link': {
        const href = safeHref(mark.attrs?.href);
        // Unsafe protocols (javascript:, data:, …) render as plain text.
        if (href) {
          el = (
            <a key={k} href={href} target="_blank" rel="noopener noreferrer">
              {el}
            </a>
          );
        }
        break;
      }
      default:
        break;
    }
  });
  return <React.Fragment key={key}>{el}</React.Fragment>;
}

/** Flatten a node subtree to raw text (used for code blocks). */
function collectText(node: TiptapNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (Array.isArray(node.content)) return node.content.map(collectText).join('');
  return '';
}

function renderChildren(node: TiptapNode, key: string): React.ReactNode {
  if (!Array.isArray(node.content)) return null;
  return node.content.map((child, i) => renderNode(child, `${key}.${i}`));
}

function renderNode(node: TiptapNode | undefined, key: string): React.ReactNode {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'text':
      return renderText(node, key);
    case 'hardBreak':
      return <br key={key} />;
    case 'mention': {
      const label =
        (node.attrs?.label as string) || (node.attrs?.id as string) || 'unknown';
      return (
        <span key={key} className="rounded bg-primary/10 px-1 text-primary font-medium">
          @{label}
        </span>
      );
    }
    case 'paragraph':
      return <p key={key}>{renderChildren(node, key)}</p>;
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{collectText(node)}</code>
        </pre>
      );
    case 'bulletList':
      return <ul key={key}>{renderChildren(node, key)}</ul>;
    case 'orderedList':
      return <ol key={key}>{renderChildren(node, key)}</ol>;
    case 'listItem':
      return <li key={key}>{renderChildren(node, key)}</li>;
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node, key)}</blockquote>;
    case 'doc':
      return <React.Fragment key={key}>{renderChildren(node, key)}</React.Fragment>;
    default:
      // Unknown node — render its children so no text is silently dropped.
      return node.content ? (
        <React.Fragment key={key}>{renderChildren(node, key)}</React.Fragment>
      ) : null;
  }
}

/** Render plaintext, auto-linking bare http(s) URLs. */
function renderPlainWithLinks(text: string): React.ReactNode[] {
  if (!text) return [];
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(URL_RE)) {
    const idx = match.index ?? 0;
    const url = match[0];
    if (idx > last) out.push(text.slice(last, idx));
    out.push(
      <a key={`u${i++}`} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
    );
    last = idx + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MessageContent({
  doc,
  fallback,
}: {
  doc: TiptapDoc | null;
  fallback: string;
}) {
  const useDoc = doc && !isEmptyDoc(doc);
  return (
    <div className={PROSE}>
      {useDoc ? (
        renderNode(doc, 'root')
      ) : (
        <p className="whitespace-pre-wrap">{renderPlainWithLinks(fallback ?? '')}</p>
      )}
    </div>
  );
}
