'use client';

import { useState, useEffect, useMemo, useCallback, useId } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  FolderKanban,
  CheckCircle2,
  FileText,
  DollarSign,
  ArrowUpRight,
  Clock,
  Activity,
  Video,
  Circle,
  MessageSquare,
  Paperclip,
  ChevronRight,
  Plus,
  X,
  Loader2,
  SlidersHorizontal,
  ArrowRight,
  CalendarDays,
  Sparkles,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { TimePicker } from '@/components/ui/time-picker';
import { Stat } from '@/components/ui/stat';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  followStartDate,
  meetingFormInstants,
  meetingFormTimeOrderError,
} from '@/lib/meetings/time-order';
import { formatDistanceToNow, format } from 'date-fns';
import { RevenueChart } from './revenue-chart';
import { moneyListLabel, diffByCurrency } from '@/lib/finance/currency';
import {
  assistantAvailabilityMessage,
  isAssistantAvailable,
  useAssistant,
} from '@/lib/assistant-store';

/* ============================================
   Next Meeting Countdown — real data
   ============================================ */
function NextMeetingBanner() {
  const utils = trpc.useUtils();
  const { data: meetings } = trpc.meetings.getUpcoming.useQuery();
  const { data: teamMembers } = trpc.team.getAll.useQuery();
  const meeting = meetings?.[0];

  const [isLive, setIsLive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [recurrence, setRecurrence] = useState<'daily' | 'weekly' | 'biweekly' | 'monthly' | ''>(
    ''
  );
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const timeErrorId = useId();

  const createMeeting = trpc.meetings.create.useMutation({
    onSuccess: () => {
      utils.meetings.getUpcoming.invalidate();
      setShowCreate(false);
      setTitle('');
      setDate('');
      setStartTime('');
      setEndDate('');
      setEndTime('');
      setLocation('');
      setRecurrence('');
      setAttendeeIds([]);
    },
  });

  // DEV-249: the same rule the server applies, checked as the times are picked
  // so a meeting that ends at or before it starts cannot be submitted. Both
  // sides are full instants, so a meeting that runs past midnight is allowed.
  const range = { startDate: date, startTime, endDate, endTime };
  const timeOrderError = meetingFormTimeOrderError(range);
  const formError = timeOrderError ?? createMeeting.error?.message ?? null;

  const closeCreate = () => {
    setShowCreate(false);
    // A refusal belongs to the attempt it answered, not the next form.
    createMeeting.reset();
  };

  const changeStartDate = (next: string) => {
    setEndDate(followStartDate(date, next, endDate));
    setDate(next);
  };

  const handleCreate = () => {
    if (!title.trim() || !date || !startTime || !endTime || timeOrderError) return;
    const instants = meetingFormInstants(range);
    createMeeting.mutate({
      title: title.trim(),
      description: undefined,
      startTime: instants.startTime,
      endTime: instants.endTime,
      location: location || undefined,
      recurrence: recurrence || null,
      attendeeIds,
    });
  };

  // The per-second tick lives in the <MeetingCountdown> leaf so it doesn't
  // re-render this whole banner every second. The leaf reports live/ended
  // transitions up via this callback; the state setter bails when unchanged,
  // so the banner only re-renders on an actual transition (not each tick).
  const handleLiveChange = useCallback((live: boolean) => {
    setIsLive((prev) => (prev === live ? prev : live));
  }, []);

  // Refetch upcoming meetings when one transitions from live → ended
  // so the banner moves on to the next meeting automatically.
  useEffect(() => {
    if (!meeting) return;
    const endMs = new Date(meeting.endTime).getTime() - Date.now();
    if (endMs <= 0) return;
    const t = setTimeout(() => utils.meetings.getUpcoming.invalidate(), endMs + 1000);
    return () => clearTimeout(t);
  }, [meeting, utils]);

  const attendeeNames = useMemo(
    () =>
      meeting?.attendees
        .slice(0, 3)
        .map((a) => a.user.name.split(' ')[0])
        .join(', ') ?? '',
    [meeting]
  );
  const extra = useMemo(
    () => (meeting && meeting.attendees.length > 3 ? ` +${meeting.attendees.length - 3}` : ''),
    [meeting]
  );

  // No meeting — show schedule button
  if (!meeting && !showCreate) {
    return (
      <div className="studio-meeting-card flex items-center justify-between border border-dashed border-border bg-card/50 p-4 sm:p-5">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Video className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-[15px] font-semibold text-foreground">No upcoming meetings</p>
            <p className="text-[13px] text-muted-foreground">Schedule one to get started</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" /> Schedule
        </button>
      </div>
    );
  }

  // Create meeting form
  if (showCreate) {
    return (
      <div className="studio-meeting-card space-y-4 border border-primary/20 bg-card p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Video className="h-4 w-4 text-primary" /> Schedule Meeting
          </h3>
          <button onClick={closeCreate} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-foreground mb-1">Title *</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sprint Planning"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-foreground mb-1">Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Google Meet, Zoom..."
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Start date *</label>
            <input
              type="date"
              aria-label="Start date"
              value={date}
              onChange={(e) => changeStartDate(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Start *</label>
            <TimePicker
              value={startTime}
              onChange={setStartTime}
              aria-label="Start time"
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">End date *</label>
            <input
              type="date"
              aria-label="End date"
              value={endDate}
              min={date || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              aria-invalid={timeOrderError ? true : undefined}
              aria-describedby={timeOrderError ? timeErrorId : undefined}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">End *</label>
            <TimePicker
              value={endTime}
              onChange={setEndTime}
              aria-label="End time"
              invalid={!!timeOrderError}
              aria-describedby={timeOrderError ? timeErrorId : undefined}
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
        {formError && (
          <p id={timeErrorId} role="alert" className="text-xs text-destructive">
            {formError}
          </p>
        )}
        {/* Recurrence */}
        <div>
          <label className="block text-xs font-medium text-foreground mb-1.5">Repeat</label>
          <div className="flex gap-1.5">
            {(
              [
                { value: '', label: 'One-time' },
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'biweekly', label: 'Bi-weekly' },
                { value: 'monthly', label: 'Monthly' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRecurrence(opt.value)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors',
                  recurrence === opt.value
                    ? 'bg-foreground text-background'
                    : 'bg-secondary text-muted-foreground hover:text-foreground'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {teamMembers && (
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Attendees</label>
            <div className="flex flex-wrap gap-1.5">
              {teamMembers.map((m) => (
                <button
                  key={m.id}
                  onClick={() =>
                    setAttendeeIds((prev) =>
                      prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                    )
                  }
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors',
                    attendeeIds.includes(m.id)
                      ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                  )}
                >
                  {m.name.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={closeCreate}
            className="rounded-xl px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={
              !title.trim() ||
              !date ||
              !startTime ||
              !endTime ||
              !!timeOrderError ||
              createMeeting.isPending
            }
            className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-40"
          >
            {createMeeting.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{' '}
            Schedule
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'studio-meeting-card flex items-center justify-between border p-4 transition-colors sm:p-5',
        isLive ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border/60 bg-card'
      )}
    >
      <div className="flex items-center gap-4">
        <div
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
            isLive ? 'bg-emerald-500/15' : 'bg-primary/10'
          )}
        >
          <Video className={cn('h-5 w-5', isLive ? 'text-emerald-500' : 'text-primary')} />
        </div>
        <div>
          <p className="text-[13px] text-muted-foreground flex items-center gap-1.5">
            {isLive ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="font-semibold uppercase tracking-wider text-emerald-500">
                  Live now
                </span>
              </>
            ) : (
              <>Next meeting</>
            )}
            {meeting!.recurrence && (
              <span className="ml-1 rounded-full bg-accent-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-brand">
                {meeting!.recurrence}
              </span>
            )}
          </p>
          <p className="text-[15px] font-semibold text-foreground mt-0.5">
            {meeting!.title}
            <span className="font-normal text-muted-foreground"> with </span>
            {attendeeNames}
            {extra}
          </p>
        </div>
      </div>

      <div className="hidden sm:flex items-center gap-5">
        <MeetingCountdown meeting={meeting!} variant="desktop" onLiveChange={handleLiveChange} />
        {isLive && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/80">
            elapsed
          </span>
        )}
        <Link
          href={`/meetings/${meeting!.id}/call`}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          {isLive ? 'Join now' : 'Join call'}
        </Link>
      </div>

      <MeetingCountdown meeting={meeting!} variant="mobile" />
    </div>
  );
}

/* ============================================
   Meeting Countdown — leaf that owns the 1s tick
   ============================================ */
/**
 * Owns the per-second setInterval + timeLeft state and renders ONLY the digit
 * nodes, so the ~1Hz tick re-renders just this leaf rather than the entire
 * banner. Live/ended transitions are reported up via onLiveChange (which the
 * parent uses for banner-wide styling); the desktop instance is always mounted
 * (CSS `hidden sm:flex`), so it drives onLiveChange across all viewports.
 */
function MeetingCountdown({
  meeting,
  variant,
  onLiveChange,
}: {
  meeting: { startTime: Date | string; endTime: Date | string };
  variant: 'desktop' | 'mobile';
  onLiveChange?: (live: boolean) => void;
}) {
  const [timeLeft, setTimeLeft] = useState({ hours: 0, minutes: 0, seconds: 0 });
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const start = new Date(meeting.startTime).getTime();
      const end = new Date(meeting.endTime).getTime();
      const live = now >= start && now < end;
      setIsLive(live);
      onLiveChange?.(live);
      // When upcoming: count down to start. When live: count up from start.
      // When ended: should get filtered out by the backend, but guard with Math.max.
      const diff = live ? now - start : Math.max(0, start - now);
      setTimeLeft({
        hours: Math.floor(diff / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [meeting, onLiveChange]);

  if (variant === 'mobile') {
    return (
      <div className="flex sm:hidden items-baseline gap-0.5 shrink-0">
        <span
          className={cn(
            'font-display text-lg font-bold',
            isLive ? 'text-emerald-500' : 'text-foreground'
          )}
        >
          {pad(timeLeft.hours)}
        </span>
        <span className="text-muted-foreground/50 text-sm">:</span>
        <span
          className={cn(
            'font-display text-lg font-bold',
            isLive ? 'text-emerald-500' : 'text-foreground'
          )}
        >
          {pad(timeLeft.minutes)}
        </span>
        <span className="text-muted-foreground/50 text-sm">:</span>
        <span
          className={cn(
            'font-display text-lg font-bold',
            isLive ? 'text-emerald-500/70' : 'text-muted-foreground'
          )}
        >
          {pad(timeLeft.seconds)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-1">
      <TimeUnit value={timeLeft.hours} label="hr" live={isLive} />
      <span className="text-muted-foreground/40 font-display text-lg font-bold -mx-0.5">:</span>
      <TimeUnit value={timeLeft.minutes} label="min" live={isLive} />
      <span className="text-muted-foreground/40 font-display text-lg font-bold -mx-0.5">:</span>
      <TimeUnit value={timeLeft.seconds} label="sec" live={isLive} />
    </div>
  );
}

function TimeUnit({
  value,
  label,
  live = false,
}: {
  value: number;
  label: string;
  live?: boolean;
}) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={cn(
          'font-display text-2xl font-bold tracking-tight leading-none tabular-nums',
          live ? 'text-emerald-500' : 'text-foreground'
        )}
      >
        {pad(value)}
      </span>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">
        {label}
      </span>
    </div>
  );
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

// getTimeDiff inlined into NextMeetingBanner useEffect

/* ============================================
   KPI Card
   ============================================ */
function KPICard({
  title,
  value,
  change,
  changeLabel,
  icon: Icon,
  trend,
}: {
  title: string;
  value: string;
  change?: string;
  changeLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: 'up' | 'down' | 'neutral';
}) {
  const deltaDirection = trend === 'up' ? 'up' : trend === 'down' ? 'down' : 'flat';

  return (
    <div className="studio-kpi-card bg-card p-5 sm:p-6">
      <span className="studio-kpi-icon">
        <Icon aria-hidden className="h-4 w-4" />
      </span>
      <Stat
        className="pr-8"
        label={title}
        value={value}
        valueClassName="break-words text-[clamp(1.5rem,7vw,2rem)]"
        delta={change}
        deltaDirection={deltaDirection}
        sub={changeLabel}
      />
    </div>
  );
}

/* ============================================
   My Tasks — personal task list
   ============================================ */
const TASK_PRIORITY_CONFIG: Record<string, { color: string; label: string }> = {
  URGENT: { color: 'text-red-500', label: 'Urgent' },
  HIGH: { color: 'text-accent-brand', label: 'High' },
  MEDIUM: { color: 'text-amber-500', label: 'Medium' },
  LOW: { color: 'text-muted-foreground', label: 'Low' },
};

const TASK_COLUMN_CONFIG: Record<string, string> = {
  Backlog: 'bg-muted text-muted-foreground',
  'To Do': 'bg-muted text-foreground',
  'In Progress': 'bg-accent-brand/10 text-accent-brand',
  Review: 'bg-foreground/10 text-foreground',
};

function TaskItem({
  task,
}: {
  task: {
    id: string;
    title: string;
    priority: string;
    dueDate: Date | null;
    column: { name: string; board: { id: string; projectId: string } };
    _count: { comments: number; checklists: number };
  };
}) {
  const prio = TASK_PRIORITY_CONFIG[task.priority] || TASK_PRIORITY_CONFIG.MEDIUM;
  const colClass = TASK_COLUMN_CONFIG[task.column.name] || 'bg-muted text-muted-foreground';
  const boardUrl = `/projects/${task.column.board.projectId}/board/${task.column.board.id}`;

  return (
    <Link href={boardUrl} className="group flex items-center gap-3 py-3 cursor-pointer">
      <Circle className={cn('h-4 w-4 shrink-0', prio.color)} strokeWidth={2.5} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
          {task.title}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span
            className={cn(
              'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium',
              colClass
            )}
          >
            {task.column.name}
          </span>
          {task.dueDate && (
            <span className="text-[11px] text-muted-foreground">
              {format(new Date(task.dueDate), 'MMM d')}
            </span>
          )}
          {task._count.comments > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {task._count.comments}
            </span>
          )}
          {task._count.checklists > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
              <Paperclip className="h-3 w-3" />
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </Link>
  );
}

/* ============================================
   Activity feed item
   ============================================ */
const ACTIVITY_COLORS: Record<string, string> = {
  task_completed: 'bg-emerald-500',
  invoice_sent: 'bg-accent-brand',
  invoice_paid: 'bg-foreground',
  contract_created: 'bg-amber-500',
  contract_updated: 'bg-amber-500',
  project_created: 'bg-primary',
  project_updated: 'bg-primary',
};

function ActivityItem({
  activity,
}: {
  activity: {
    id: string;
    type: string;
    message: string;
    createdAt: Date;
    user: { id: string; name: string; avatar: string | null; title: string };
  };
}) {
  return (
    <div className="flex items-start gap-3.5 py-3.5">
      <div className="relative">
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarImage src={activity.user.avatar ?? undefined} />
          <AvatarFallback className="text-[10px] bg-secondary text-foreground font-medium">
            {activity.user.name
              .split(' ')
              .map((n) => n[0])
              .join('')}
          </AvatarFallback>
        </Avatar>
        <div
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card',
            ACTIVITY_COLORS[activity.type] ?? 'bg-muted-foreground/40'
          )}
        />
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-sm text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground">{activity.user.name}</span>{' '}
          {activity.message.toLowerCase()}
        </p>
        <p className="text-[11px] text-muted-foreground/50">
          {formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true })}
        </p>
      </div>
    </div>
  );
}

/* ============================================
   Project card
   ============================================ */
const PROJECT_STATUS_CONFIG: Record<string, { bg: string; dot: string }> = {
  ACTIVE: {
    bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  IN_DEVELOPMENT: { bg: 'bg-accent-brand/10 text-accent-brand', dot: 'bg-accent-brand' },
  ON_HOLD: { bg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  COMPLETED: { bg: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
};

function ProjectCard({
  project,
}: {
  project: {
    id: string;
    name: string;
    status: string;
    type: string;
    client: { id: string; name: string } | null;
    members: Array<{ user: { id: string; name: string; avatar: string | null } }>;
  };
}) {
  const config = PROJECT_STATUS_CONFIG[project.status] || PROJECT_STATUS_CONFIG.ACTIVE;

  return (
    <Link href={`/projects/${project.id}`}>
      <Card className="studio-project-card group cursor-pointer border-border/60 transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                {project.name}
              </h3>
              <p className="text-xs text-muted-foreground truncate">
                {project.client
                  ? project.client.name
                  : project.type === 'INTERNAL'
                    ? 'Internal Product'
                    : ''}
              </p>
            </div>
            <div
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
                config.bg
              )}
            >
              <div className={cn('h-1.5 w-1.5 rounded-full', config.dot)} />
              {project.status.replace('_', ' ')}
            </div>
          </div>
          <div className="mt-5 flex items-center justify-between">
            <div className="flex -space-x-2">
              {project.members.slice(0, 4).map((member) => (
                <Avatar key={member.user.id} className="h-7 w-7 border-2 border-card">
                  <AvatarImage src={member.user.avatar ?? undefined} />
                  <AvatarFallback className="text-[10px] bg-secondary font-medium">
                    {member.user.name[0]}
                  </AvatarFallback>
                </Avatar>
              ))}
              {project.members.length > 4 && (
                <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-card bg-secondary text-[10px] font-semibold text-muted-foreground">
                  +{project.members.length - 4}
                </div>
              )}
            </div>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground/40 opacity-0 transition-all group-hover:opacity-100 group-hover:text-primary" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* ============================================
   Deadline item
   ============================================ */
function DeadlineItem({
  milestone,
}: {
  milestone: {
    id: string;
    name: string;
    dueDate: Date;
    project: { id: string; name: string; status: string };
  };
}) {
  const [nowMs] = useState(() => Date.now());
  const daysUntil = Math.ceil(
    (new Date(milestone.dueDate).getTime() - nowMs) / (1000 * 60 * 60 * 24)
  );
  const urgencyConfig =
    daysUntil <= 3
      ? { bg: 'bg-red-500/10 text-red-500' }
      : daysUntil <= 7
        ? { bg: 'bg-amber-500/10 text-amber-500' }
        : { bg: 'bg-emerald-500/10 text-emerald-500' };

  return (
    <Link
      href={`/projects/${milestone.project.id}`}
      className="flex items-center gap-3 py-3 group cursor-pointer"
    >
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl font-display',
          urgencyConfig.bg
        )}
      >
        <span className="text-sm font-bold leading-none">{daysUntil}</span>
        <span className="text-[9px] font-medium mt-0.5">days</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
          {milestone.name}
        </p>
        <p className="text-xs text-muted-foreground truncate">{milestone.project.name}</p>
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </Link>
  );
}

/* ============================================
   Skeleton loader
   ============================================ */
function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-end justify-between">
        <div>
          <Skeleton className="h-9 w-56 mb-2" />
          <Skeleton className="h-5 w-72" />
        </div>
        <Skeleton className="h-9 w-36 hidden sm:block" />
      </div>
      <Skeleton className="h-[76px] w-full rounded-2xl" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border-border/60">
            <CardContent className="p-6">
              <Skeleton className="h-4 w-28 mb-3" />
              <Skeleton className="h-9 w-20 mb-2" />
              <Skeleton className="h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <Card className="studio-panel lg:col-span-3 border-border/60">
          <CardContent className="p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-3">
                <Skeleton className="h-4 w-4 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2 border-border/60">
          <CardContent className="p-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 py-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ============================================
   Customizable widgets (IMP-DASH-02)
   ============================================ */
// Stable keys must match TOGGLEABLE_WIDGETS in src/server/routers/dashboard.ts.
// The Next Meeting banner, KPI cards, and admin Revenue chart are always-on.
const DASHBOARD_WIDGETS = [
  { key: 'myTasks', label: 'My Tasks' },
  { key: 'deadlines', label: 'Upcoming Deadlines' },
  { key: 'activity', label: 'Activity' },
  { key: 'projects', label: 'Active Projects' },
] as const;

/* ============================================
   Dashboard main
   ============================================ */
export function DashboardContent() {
  const { data: session } = useSession();
  const openAssistant = useAssistant((state) => state.setOpen);
  const assistantAvailable = useAssistant((state) =>
    isAssistantAvailable(state, session?.user.organizationId)
  );
  const assistantMessage = useAssistant((state) =>
    assistantAvailabilityMessage(state, session?.user.organizationId)
  );
  const utils = trpc.useUtils();
  const stats = trpc.dashboard.getStats.useQuery();
  const activity = trpc.dashboard.getRecentActivity.useQuery();
  const deadlines = trpc.dashboard.getUpcomingDeadlines.useQuery();
  const projects = trpc.dashboard.getProjectCards.useQuery();
  const myTasks = trpc.dashboard.getMyTasks.useQuery();
  const prefs = trpc.dashboard.getPreferences.useQuery();

  const [showCustomize, setShowCustomize] = useState(false);

  // Optimistically flip the checkbox so toggling feels instant; reconcile on
  // settle. Rollback on error keeps the UI honest if the write fails.
  const updatePrefs = trpc.dashboard.updatePreferences.useMutation({
    onMutate: async (next) => {
      await utils.dashboard.getPreferences.cancel();
      const prev = utils.dashboard.getPreferences.getData();
      utils.dashboard.getPreferences.setData(undefined, { hiddenWidgets: next.hiddenWidgets });
      return { prev };
    },
    onError: (_err, _next, context) => {
      if (context?.prev) utils.dashboard.getPreferences.setData(undefined, context.prev);
    },
    onSettled: () => utils.dashboard.getPreferences.invalidate(),
  });

  const hiddenWidgets = prefs.data?.hiddenWidgets ?? [];
  const isHidden = (key: string) => hiddenWidgets.includes(key);
  const toggleWidget = (key: string) => {
    const next = isHidden(key) ? hiddenWidgets.filter((k) => k !== key) : [...hiddenWidgets, key];
    updatePrefs.mutate({ hiddenWidgets: next });
  };

  if (stats.isLoading) return <DashboardSkeleton />;

  const isAdmin = stats.data?.isAdmin;
  const greeting = getGreeting();
  const firstName = session?.user?.name?.split(' ')[0] ?? 'there';

  return (
    <div className="studio-dashboard space-y-4 sm:space-y-5">
      <section className="studio-command-grid" aria-labelledby="dashboard-greeting">
        <div className="studio-date-panel">
          <span className="studio-date-number">{format(new Date(), 'd')}</span>
          <div>
            <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {format(new Date(), 'EEEE')}
            </span>
            <span className="mt-1 block text-sm text-foreground">
              {format(new Date(), 'MMMM yyyy')}
            </span>
          </div>
          <CalendarDays className="ml-auto h-5 w-5 text-accent-brand" aria-hidden />
        </div>

        <div className="studio-greeting-panel">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
              Your operating view
            </p>
            <h1
              id="dashboard-greeting"
              className="mt-2 text-[clamp(2rem,4.1vw,4.8rem)] font-medium leading-[0.94] tracking-[-0.065em] text-foreground"
            >
              {greeting}, {firstName}.
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">
              Delivery signals, open work, and the decisions that need you today.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openAssistant(true)}
            disabled={!assistantAvailable}
            title={assistantAvailable ? 'Open Ask Fathom chat' : assistantMessage}
            className="studio-prompt-button disabled:cursor-not-allowed disabled:opacity-50 disabled:transform-none motion-reduce:transform-none motion-reduce:transition-none"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-brand text-white">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-xs text-muted-foreground">
                {assistantAvailable ? 'Need a hand?' : assistantMessage}
              </span>
              <span className="block truncate text-sm font-semibold text-foreground">
                Ask Fathom anything
              </span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowCustomize((v) => !v)}
          aria-expanded={showCustomize}
          className={cn('studio-customize-button', showCustomize && 'is-active')}
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span>Arrange</span>
        </button>
      </section>

      {/* Customize widgets (IMP-DASH-02) */}
      {showCustomize && (
        <Card className="studio-panel border-border/60">
          <CardContent className="p-4">
            <p className="mb-3 text-xs font-medium text-muted-foreground">Show widgets</p>
            <div className="flex flex-wrap gap-x-6 gap-y-2.5">
              {DASHBOARD_WIDGETS.map((w) => (
                <label
                  key={w.key}
                  className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                >
                  <input
                    type="checkbox"
                    checked={!isHidden(w.key)}
                    onChange={() => toggleWidget(w.key)}
                    className="h-4 w-4 rounded border-border text-primary accent-primary focus:ring-2 focus:ring-primary/20"
                  />
                  {w.label}
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Next Meeting */}
      <NextMeetingBanner />

      {/* KPI Cards */}
      <div
        className={cn(
          'studio-kpi-grid grid grid-cols-1 gap-3 sm:gap-4',
          isAdmin ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'
        )}
      >
        {/* No month-over-month or quarter deltas are computed by `dashboard.getStats`;
            these cards show the figure alone rather than a placeholder trend. */}
        {isAdmin && (
          <KPICard
            title="Revenue This Month"
            value={moneyListLabel(stats.data?.revenue ?? [])}
            changeLabel="income recorded this month"
            icon={DollarSign}
          />
        )}
        <KPICard
          title="Active Projects"
          value={String(stats.data?.activeProjects ?? 0)}
          changeLabel="in progress"
          icon={FolderKanban}
        />
        <KPICard
          title="Tasks Completed"
          value={String(stats.data?.completedTasksThisWeek ?? 0)}
          changeLabel="this week"
          icon={CheckCircle2}
          trend="neutral"
        />
        {isAdmin ? (
          <KPICard
            title="Outstanding Invoices"
            value={String(stats.data?.outstandingInvoices ?? 0)}
            change={`${moneyListLabel(
              diffByCurrency(stats.data?.revenue ?? [], stats.data?.expenses ?? [])
            )} net`}
            changeLabel="this month"
            icon={FileText}
            trend={
              diffByCurrency(stats.data?.revenue ?? [], stats.data?.expenses ?? []).some(
                (p) => p.amount < 0
              )
                ? 'down'
                : 'up'
            }
          />
        ) : (
          <KPICard
            title="Pending Leaves"
            value={String(stats.data?.pendingLeaves ?? 0)}
            icon={Clock}
          />
        )}
      </div>

      {/* Revenue Chart — admin only */}
      {isAdmin && <RevenueChart />}

      {/* My Tasks + Upcoming Deadlines */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* My Tasks */}
        {!isHidden('myTasks') && (
          <Card className="lg:col-span-3 border-border/60">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
                  <div className="studio-section-icon">
                    <CheckCircle2 className="h-3.5 w-3.5 text-accent-brand" />
                  </div>
                  My Tasks
                </CardTitle>
                {myTasks.data && myTasks.data.length > 0 && (
                  <span className="text-xs text-muted-foreground">{myTasks.data.length} open</span>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <div className="divide-y divide-border/60">
                {myTasks.isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 py-3">
                      <Skeleton className="h-4 w-4 rounded-full" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                    </div>
                  ))
                ) : myTasks.data?.length ? (
                  myTasks.data.map(
                    (task: {
                      id: string;
                      title: string;
                      priority: string;
                      dueDate: Date | null;
                      column: { name: string; board: { id: string; projectId: string } };
                      labels: Array<{ label: { id: string; name: string; color: string } }>;
                      assignees: Array<{
                        user: { id: string; name: string; avatar: string | null };
                      }>;
                      _count: { comments: number; checklists: number };
                    }) => <TaskItem key={task.id} task={task} />
                  )
                ) : (
                  <div className="py-12 text-center">
                    <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500/20" />
                    <p className="mt-3 text-sm font-medium text-foreground">All caught up</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      No tasks assigned to you right now
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Upcoming Deadlines */}
        {!isHidden('deadlines') && (
          <Card className="studio-panel lg:col-span-2 border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
                <div className="studio-section-icon">
                  <Clock className="h-3.5 w-3.5 text-amber-500" />
                </div>
                Upcoming Deadlines
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <div className="divide-y divide-border/60">
                {deadlines.isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 py-3">
                      <Skeleton className="h-10 w-10 rounded-xl" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-36" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                    </div>
                  ))
                ) : deadlines.data?.length ? (
                  deadlines.data.map(
                    (milestone: {
                      id: string;
                      name: string;
                      dueDate: Date;
                      project: { id: string; name: string; status: string };
                    }) => <DeadlineItem key={milestone.id} milestone={milestone} />
                  )
                ) : (
                  <div className="py-12 text-center">
                    <Clock className="mx-auto h-10 w-10 text-muted-foreground/20" />
                    <p className="mt-3 text-sm text-muted-foreground">No upcoming deadlines</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Activity + Active Projects */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* Recent Activity */}
        {!isHidden('activity') && (
          <Card className="studio-panel lg:col-span-2 border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
                <div className="studio-section-icon">
                  <Activity className="h-3.5 w-3.5 text-accent-brand" />
                </div>
                Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <div className="divide-y divide-border/60">
                {activity.isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-3 py-3">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-3 w-52" />
                      </div>
                    </div>
                  ))
                ) : activity.data?.length ? (
                  activity.data
                    .slice(0, 6)
                    .map(
                      (item: {
                        id: string;
                        type: string;
                        message: string;
                        createdAt: Date;
                        user: { id: string; name: string; avatar: string | null; title: string };
                      }) => <ActivityItem key={item.id} activity={item} />
                    )
                ) : (
                  <div className="py-12 text-center">
                    <Activity className="mx-auto h-10 w-10 text-muted-foreground/20" />
                    <p className="mt-3 text-sm text-muted-foreground">No recent activity</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Active Projects */}
        {!isHidden('projects') && (
          <div className="lg:col-span-3">
            <h2 className="mb-4 flex items-center gap-2 px-1 font-display text-[15px] font-semibold text-foreground">
              <div className="studio-section-icon">
                <FolderKanban className="h-3.5 w-3.5 text-accent-brand" />
              </div>
              Active Projects
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {projects.isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i} className="border-border/60">
                    <CardContent className="p-5">
                      <Skeleton className="h-5 w-36 mb-2" />
                      <Skeleton className="h-3 w-24 mb-5" />
                      <div className="flex -space-x-2">
                        {Array.from({ length: 3 }).map((_, j) => (
                          <Skeleton key={j} className="h-7 w-7 rounded-full" />
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))
              ) : projects.data?.length ? (
                projects.data
                  .slice(0, 4)
                  .map(
                    (project: {
                      id: string;
                      name: string;
                      status: string;
                      type: string;
                      client: { id: string; name: string } | null;
                      members: Array<{ user: { id: string; name: string; avatar: string | null } }>;
                    }) => <ProjectCard key={project.id} project={project} />
                  )
              ) : (
                <Card className="col-span-full border-border/60">
                  <CardContent className="py-12 text-center">
                    <FolderKanban className="mx-auto h-10 w-10 text-muted-foreground/20" />
                    <p className="mt-3 text-sm text-muted-foreground">No active projects yet</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
