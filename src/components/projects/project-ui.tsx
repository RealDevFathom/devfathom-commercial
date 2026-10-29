import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';

/**
 * Shared project design language — status tones, progress + deadline helpers,
 * and the two atoms (StatusBadge, ProgressBar) used by both the Projects list
 * and the project detail page. Single source of truth so a tone tweak lands
 * everywhere. All colour comes from the design tokens (no raw hex / palette).
 */

export type StatusStyle = {
  label: string;
  /** StatusPill tone for the health chip. */
  tone: StatusTone;
  dot: string;
  text: string;
  bg: string;
  rail: string;
};

export const statusConfig: Record<string, StatusStyle> = {
  ACTIVE: {
    label: 'Active',
    tone: 'success',
    dot: 'bg-success',
    text: 'text-success',
    bg: 'bg-success/10',
    rail: 'bg-success',
  },
  IN_DEVELOPMENT: {
    label: 'In Development',
    tone: 'info',
    dot: 'bg-primary',
    text: 'text-primary',
    bg: 'bg-primary/10',
    rail: 'bg-primary',
  },
  ON_HOLD: {
    label: 'On Hold',
    tone: 'warning',
    dot: 'bg-warning',
    text: 'text-warning',
    bg: 'bg-warning/10',
    rail: 'bg-warning',
  },
  COMPLETED: {
    label: 'Completed',
    tone: 'neutral',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    bg: 'bg-muted',
    rail: 'bg-muted-foreground/40',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'danger',
    dot: 'bg-destructive',
    text: 'text-destructive',
    bg: 'bg-destructive/10',
    rail: 'bg-destructive',
  },
};

export const STATUS_ORDER = [
  'ACTIVE',
  'IN_DEVELOPMENT',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
] as const;

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

// Short, urgency-coloured deadline label (tokenised tones).
export function deadlineMeta(date: Date): { label: string; tone: string } {
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: 'text-destructive' };
  if (days === 0) return { label: 'Due today', tone: 'text-destructive' };
  if (days <= 3) return { label: `Due in ${days}d`, tone: 'text-destructive' };
  if (days <= 14) return { label: `${days}d left`, tone: 'text-warning' };
  return { label: format(date, 'MMM d'), tone: 'text-text-muted' };
}

/** Health chip — mono uppercase StatusPill mapped from the project status. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = statusConfig[status] ?? statusConfig.ACTIVE;
  return <StatusPill status={status} tone={s.tone} label={s.label} className={className} />;
}

export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-surface-sunken', className)}>
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
