import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import type { SetupChecklist } from '@/lib/onboarding/setup-evaluator';

const tone: Record<SetupChecklist['items'][number]['status'], StatusTone> = {
  Done: 'success',
  'Needs you': 'warning',
  Optional: 'neutral',
};

export function FirstRunChecklist({ checklist }: { checklist: SetupChecklist }) {
  if (checklist.complete) return null;

  const completeCount = checklist.items.filter((item) => item.status === 'Done').length;
  return (
    <SectionCard
      eyebrow="First run"
      title="Open for your first sale"
      titleLevel={2}
      actions={
        <span className="font-mono text-xs text-text-muted tabular-nums">
          {completeCount}/{checklist.items.length}
        </span>
      }
      className="mb-5"
      data-testid="first-run-checklist"
    >
      <p className="mb-1 max-w-2xl text-sm leading-6 text-text-muted">
        Follow these links in order. Progress updates automatically from your workspace data.
      </p>
      <ol className="divide-y divide-border-subtle">
        {checklist.items.map((item) => (
          <li
            key={item.key}
            className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-sm font-semibold text-text-strong">
                  {item.label}
                </h3>
                <StatusPill status={item.status} tone={tone[item.status]} />
              </div>
              <p className="mt-1 text-sm leading-5 text-text-muted">{item.why}</p>
            </div>
            <Link
              href={item.href}
              className="group inline-flex min-h-11 items-center gap-2 rounded-sm px-1 text-sm font-semibold text-text-strong underline decoration-border-strong underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.actionLabel}
              <ArrowRight
                className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
