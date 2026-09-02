/**
 * The onboarding readiness checklist — one shared surface for every vertical.
 *
 * Built here for pharmacy (WHA-1198, PLAT-03) and deliberately free of any
 * pharmacy vocabulary: it renders rows a caller has already resolved, so the
 * restaurant reuse (WHA-1195) supplies its own rows and copy without touching
 * this file. Nothing here imports a gate enum, a vertical, or a module key.
 *
 * The UX rules it exists to satisfy:
 *
 * - **13** — a precondition is a checklist of rows with links, not one sentence.
 * - **9** — a data surface ships loading, empty and error states; the loading
 *   state is {@link ReadinessChecklistSkeleton}, the empty state is below.
 * - **2/12** — a row links only where a page exists; where none does, the row
 *   still says what to do rather than offering a link into nothing.
 * - **Accessibility** — status is a labelled pill with a dot, never colour
 *   alone, and the whole thing is an ordered list so the walk order is real
 *   structure rather than visual order.
 *
 * No client state: it takes an optional already-rendered node per row for the
 * caller's own control, so it works unchanged in a server or a client tree.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Check, CircleAlert, Minus } from 'lucide-react';

import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';

export type ReadinessChecklistState = 'DONE' | 'NEEDS_YOU' | 'OPTIONAL';

export type ReadinessChecklistRow = {
  key: string;
  step: number;
  label: string;
  state: ReadinessChecklistState;
  /** One line: how it was satisfied, or exactly what to do next. */
  why: string;
  href: string | null;
  linkLabel: string | null;
};

const PRESENTATION: Record<
  ReadinessChecklistState,
  { text: string; tone: 'success' | 'warning' | 'neutral'; Icon: typeof Check }
> = {
  DONE: { text: 'Done', tone: 'success', Icon: Check },
  NEEDS_YOU: { text: 'Needs you', tone: 'warning', Icon: CircleAlert },
  OPTIONAL: { text: 'Optional', tone: 'neutral', Icon: Minus },
};

export function ReadinessChecklistItem({
  row,
  action,
}: {
  row: ReadinessChecklistRow;
  /** The caller's own control for this row, rendered under the guidance line. */
  action?: ReactNode;
}) {
  const presentation = PRESENTATION[row.state];
  const { Icon } = presentation;
  return (
    <li
      className="flex min-w-0 gap-3 border-b border-border-subtle py-4 last:border-b-0"
      data-state={row.state}
      data-step={row.step}
      id={`readiness-step-${row.step}`}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border',
          row.state === 'DONE'
            ? 'border-success/30 bg-success/10 text-success'
            : row.state === 'NEEDS_YOU'
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-border-subtle bg-muted text-text-muted'
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="font-medium text-text-strong">
            <span className="font-mono text-xs text-text-faint">
              Step {row.step}
              <span className="sr-only">:</span>
            </span>{' '}
            {row.label}
          </h3>
          <StatusPill status={presentation.text} tone={presentation.tone} />
        </div>
        <p className="text-sm text-text-muted">{row.why}</p>
        {/*
          The link is underlined at rest, not only on hover: `--primary` is ink
          in the light theme, so a colour-only link is indistinguishable from
          bold body copy — the underline has to carry the affordance.
        */}
        {row.href && row.linkLabel ? (
          <Link
            className="inline-flex min-h-9 items-center text-sm font-medium text-primary underline underline-offset-4 hover:text-accent-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            href={row.href}
          >
            {row.linkLabel}
            <span className="sr-only"> — {row.label}</span>
          </Link>
        ) : null}
        {action}
      </div>
    </li>
  );
}

export function ReadinessChecklist({
  rows,
  actions,
  eyebrow,
  title,
  description,
  emptyMessage = 'There is nothing to set up here yet.',
}: {
  rows: readonly ReadinessChecklistRow[];
  /** Optional per-row control, keyed by the row's `key`. */
  actions?: Record<string, ReactNode>;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  emptyMessage?: string;
}) {
  const done = rows.filter((row) => row.state === 'DONE').length;
  return (
    <SectionCard
      eyebrow={eyebrow}
      title={title}
      titleLevel={2}
      actions={
        rows.length > 0 ? (
          <span className="font-mono text-xs tabular-nums text-text-muted">
            {done}/{rows.length} done
          </span>
        ) : null
      }
    >
      {description ? <p className="mb-4 text-sm text-text-muted">{description}</p> : null}
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">{emptyMessage}</p>
      ) : (
        <ol className="min-w-0" data-slot="readiness-checklist">
          {rows.map((row) => (
            <ReadinessChecklistItem action={actions?.[row.key]} key={row.key} row={row} />
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

/** The loading state, in the same card geometry as the loaded content. */
export function ReadinessChecklistSkeleton({ rowCount = 6 }: { rowCount?: number }) {
  return (
    <SectionCard title="Loading your setup steps" titleLevel={2}>
      <ol className="min-w-0" aria-hidden>
        {Array.from({ length: rowCount }, (_, index) => (
          <li className="flex gap-3 border-b border-border-subtle py-4 last:border-b-0" key={index}>
            <span className="mt-0.5 size-7 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-48 max-w-full animate-pulse rounded bg-muted" />
              <div className="h-3 w-full max-w-md animate-pulse rounded bg-muted" />
            </div>
          </li>
        ))}
      </ol>
      <p className="sr-only">Loading your setup steps.</p>
    </SectionCard>
  );
}
