'use client';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/* Brand-styled renderers for the markdown the assistant emits (GFM tables,
   lists, code, links). Paragraphs use text-current so they inherit the
   message/bubble colour. Text blocks use dir="auto" so an Urdu answer with
   embedded Latin names and figures follows its own first strong character. */
const components: Components = {
  p: ({ children }) => (
    <p dir="auto" className="leading-relaxed text-current [&:not(:first-child)]:mt-2">
      {children}
    </p>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul dir="auto" className="my-1.5 list-disc space-y-0.5 ps-4">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol dir="auto" className="my-1.5 list-decimal space-y-0.5 ps-4">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li dir="auto" className="leading-relaxed">
      {children}
    </li>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = !!className?.includes('language-');
    return isBlock ? (
      <code className="font-mono text-[0.85em]">{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-muted/60 p-2.5 text-[12px] leading-relaxed">
      {children}
    </pre>
  ),
  h1: ({ children }) => (
    <h3 dir="auto" className="mb-1 mt-2 font-display text-[15px] font-semibold">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 dir="auto" className="mb-1 mt-2 font-display text-[15px] font-semibold">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h3 dir="auto" className="mb-1 mt-2 font-display text-sm font-semibold">
      {children}
    </h3>
  ),
  hr: () => <hr className="my-2.5 border-border" />,
  blockquote: ({ children }) => (
    <blockquote dir="auto" className="my-2 border-s-2 border-border ps-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-hidden overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th dir="auto" className="px-2.5 py-1.5 text-start font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td dir="auto" className="px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
};

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
  );
}
