import { cn } from '@/lib/utils';
import { format } from 'date-fns';

/**
 * Shared project design language — status colours, progress + deadline helpers,
 * and the two atoms (StatusBadge, ProgressBar) used by both the Projects list
 * and the project detail page. Single source of truth so a colour tweak lands
 * everywhere.
 */

export type StatusStyle = { label: string; dot: string; text: string; bg: string; rail: string };

export const statusConfig: Record<string, StatusStyle> = {
  ACTIVE: {
    label: 'Active',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500/10',
    rail: 'bg-emerald-500',
  },
  IN_DEVELOPMENT: {
    label: 'In Development',
    dot: 'bg-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-500/10',
    rail: 'bg-blue-500',
  },
  ON_HOLD: {
    label: 'On Hold',
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/10',
    rail: 'bg-amber-500',
  },
  COMPLETED: {
    label: 'Completed',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    bg: 'bg-muted',
    rail: 'bg-muted-foreground/40',
  },
  CANCELLED: {
    label: 'Cancelled',
    dot: 'bg-red-500',
    text: 'text-red-500',
    bg: 'bg-red-500/10',
    rail: 'bg-red-500',
  },
};

export const STATUS_ORDER = ['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;

// Milestone completion → a progress reading. Null when there are no milestones,
// so callers omit the bar rather than imply 0%.
export function getProgress(p: {
  milestones: { completedAt: Date | null }[];
}): { done: number; total: number; pct: number } | null {
  const total = p.milestones.length;
  if (total === 0) return null;
  const done = p.milestones.filter((m) => m.completedAt).length;
  return { done, total, pct: Math.round((done / total) * 100) };
}

// The next date that matters: soonest incomplete milestone, else project end date.
export function getDeadline(p: {
  milestones: { completedAt: Date | null; dueDate: Date }[];
  endDate: Date | null;
}): Date | null {
  const next = p.milestones
    .filter((m) => !m.completedAt)
    .map((m) => new Date(m.dueDate).getTime())
    .sort((a, b) => a - b)[0];
  if (next != null) return new Date(next);
  return p.endDate ? new Date(p.endDate) : null;
}

// Short, urgency-coloured deadline label.
export function deadlineMeta(date: Date): { label: string; tone: string } {
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (days < 0)
    return { label: `${Math.abs(days)}d overdue`, tone: 'text-red-600 dark:text-red-400' };
  if (days === 0) return { label: 'Due today', tone: 'text-red-600 dark:text-red-400' };
  if (days <= 3) return { label: `Due in ${days}d`, tone: 'text-red-600 dark:text-red-400' };
  if (days <= 14) return { label: `${days}d left`, tone: 'text-amber-600 dark:text-amber-400' };
  return { label: format(date, 'MMM d'), tone: 'text-muted-foreground' };
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = statusConfig[status] ?? statusConfig.ACTIVE;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
        s.bg,
        s.text,
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
