import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const statusPillVariants = cva(
  'inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[0.625rem] font-semibold tracking-wide whitespace-nowrap uppercase',
  {
    variants: {
      tone: {
        success: 'bg-success/10 text-success',
        info: 'bg-primary/10 text-primary',
        warning: 'bg-warning/10 text-warning',
        danger: 'bg-destructive/10 text-destructive',
        neutral: 'bg-muted text-text-muted',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  }
);

type StatusTone = NonNullable<VariantProps<typeof statusPillVariants>['tone']>;

/** Common status strings → tone. Keys are normalized (lowercase, dash-joined). */
const STATUS_TONE: Record<string, StatusTone> = {
  // success / green
  paid: 'success',
  success: 'success',
  'on-track': 'success',
  active: 'success',
  completed: 'success',
  complete: 'success',
  approved: 'success',
  collected: 'success',
  done: 'success',
  live: 'success',
  // info / abyss (primary)
  sent: 'info',
  info: 'info',
  'in-progress': 'info',
  scheduled: 'info',
  open: 'info',
  // warning / amber
  pending: 'warning',
  warning: 'warning',
  'at-risk': 'warning',
  draft: 'warning',
  awaiting: 'warning',
  'in-review': 'warning',
  review: 'warning',
  // danger / red
  overdue: 'danger',
  danger: 'danger',
  blocked: 'danger',
  failed: 'danger',
  rejected: 'danger',
  cancelled: 'danger',
  canceled: 'danger',
};

function normalize(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

interface StatusPillProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** Status string — mapped to a tone via the table (paid/sent/pending/overdue…). */
  status: string;
  /** Explicit tone override (skips the lookup). */
  tone?: StatusTone;
  /** Override the displayed text (defaults to `status`, uppercased via CSS). */
  label?: React.ReactNode;
}

/**
 * StatusPill — mono uppercase chip with a leading colored dot. The one place
 * a pill shape is allowed. paid/on-track → green, sent → abyss, pending/at-risk
 * → amber, overdue/blocked → red, otherwise neutral.
 */
function StatusPill({ status, tone, label, className, ...props }: StatusPillProps) {
  const resolved: StatusTone = tone ?? STATUS_TONE[normalize(status)] ?? 'neutral';
  return (
    <span
      data-slot="status-pill"
      data-tone={resolved}
      className={cn(statusPillVariants({ tone: resolved }), className)}
      {...props}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {label ?? status}
    </span>
  );
}

export { StatusPill, statusPillVariants };
export type { StatusPillProps, StatusTone };
