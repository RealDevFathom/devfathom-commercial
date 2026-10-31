'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  Video,
  Plus,
  X,
  Loader2,
  Trash2,
  Clock,
  MapPin,
  Users,
  RefreshCw,
  Calendar,
  Pencil,
  Check,
  UserCheck,
  UserX,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { TimePicker } from '@/components/ui/time-picker';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { computePunctuality } from '@/lib/meeting-occurrence';
import { MEETING_TIME_ORDER_MESSAGE, isValidMeetingTimeRange } from '@/lib/meetings/time-range';
import { addDays, differenceInCalendarDays, format, isToday, isTomorrow } from 'date-fns';

const recurrenceLabels: Record<string, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  monthly: 'Monthly',
};

export function MeetingsContent() {
  const utils = trpc.useUtils();
  const { data: upcoming, isLoading: loadingUpcoming } = trpc.meetings.getUpcoming.useQuery();
  // Past is retrieved server-side, one bounded page at a time, and paginates
  // independently of Upcoming (#44). It used to be derived client-side from
  // `getAll`, which is ordered furthest-future first: on a busy calendar every
  // early page was future-only, so the Past section stayed empty until the user
  // had paged through the whole future calendar.
  const {
    data: pastPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.meetings.getPast.useInfiniteQuery({}, { getNextPageParam: (last) => last.nextCursor });
  const { data: team } = trpc.team.getAll.useQuery();

  const deleteMeeting = trpc.meetings.delete.useMutation({
    onSuccess: () => {
      utils.meetings.getUpcoming.invalidate();
      utils.meetings.getPast.invalidate();
    },
  });
  const createMeeting = trpc.meetings.create.useMutation({
    onSuccess: () => {
      utils.meetings.getUpcoming.invalidate();
      utils.meetings.getPast.invalidate();
      setShowCreate(false);
    },
  });

  const [showCreate, setShowCreate] = useState(false);

  // Stable delete handler so memoized MeetingCards don't re-render when an
  // unrelated piece of parent state changes. mutate is referentially stable.
  const handleDelete = useCallback((id: string) => deleteMeeting.mutate({ id }), [deleteMeeting]);

  const pastMeetings = useMemo(() => pastPages?.pages.flatMap((p) => p.items) ?? [], [pastPages]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="WORKSPACE"
        heading="Meetings"
        description={
          <>{upcoming?.length ?? 0} upcoming &middot; Schedule and manage your meetings.</>
        }
        actions={
          <Button size="lg" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> Schedule Meeting
          </Button>
        }
      />

      {/* Create form */}
      {showCreate && (
        <CreateMeetingForm
          onSubmit={createMeeting.mutate}
          onClose={() => setShowCreate(false)}
          isPending={createMeeting.isPending}
          team={team}
        />
      )}

      {/* Upcoming meetings */}
      <div>
        <h2 className="font-display text-[15px] font-semibold text-foreground mb-3 flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
            <Calendar className="h-3.5 w-3.5 text-primary" />
          </div>
          Upcoming
        </h2>
        {loadingUpcoming ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : !upcoming?.length ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
            <Video className="h-10 w-10 text-muted-foreground/20" />
            <p className="mt-3 text-sm text-muted-foreground">No upcoming meetings</p>
            <button
              onClick={() => setShowCreate(true)}
              className="mt-3 text-xs font-medium text-primary hover:underline"
            >
              Schedule one
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {upcoming.map((m) => (
              <MeetingCard key={m.id} meeting={m} onDelete={handleDelete} team={team} />
            ))}
          </div>
        )}
      </div>

      {/* Past meetings — their own server-side query and their own cursor, so
          the first page holds past meetings however large the future calendar
          is, and paging through them leaves Upcoming untouched. */}
      {(pastMeetings.length > 0 || hasNextPage) && (
        <div>
          <h2 className="font-display text-[15px] font-semibold text-muted-foreground mb-3 flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-secondary">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            Past
          </h2>
          <div className="space-y-2">
            {pastMeetings.map((m) => (
              <MeetingCard key={m.id} meeting={m} onDelete={handleDelete} isPast />
            ))}
          </div>
          {hasNextPage && (
            <div className="mt-3 flex flex-col items-center gap-1.5">
              <p className="text-xs text-muted-foreground">
                {pastMeetings.length} past meetings loaded — more remain.
              </p>
              <button
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
              >
                {isFetchingNextPage ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const CreateMeetingForm = memo(function CreateMeetingForm({
  onSubmit,
  onClose,
  isPending,
  team,
}: {
  onSubmit: (input: {
    title: string;
    description?: string;
    startTime: Date;
    endTime: Date;
    location?: string;
    recurrence: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
    attendeeIds: string[];
  }) => void;
  onClose: () => void;
  isPending: boolean;
  team?: Array<{ id: string; name: string; avatar: string | null }>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [recurrence, setRecurrence] = useState<'daily' | 'weekly' | 'biweekly' | 'monthly' | ''>(
    ''
  );
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const hasCompleteTimeRange = Boolean(date && startTime && endTime);
  const hasInvalidTimeRange =
    hasCompleteTimeRange &&
    !isValidMeetingTimeRange(new Date(`${date}T${startTime}`), new Date(`${date}T${endTime}`));

  const handleCreate = () => {
    if (!title.trim() || !hasCompleteTimeRange || hasInvalidTimeRange) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      startTime: new Date(`${date}T${startTime}`),
      endTime: new Date(`${date}T${endTime}`),
      location: location || undefined,
      recurrence: recurrence || null,
      attendeeIds,
    });
  };

  return (
    <Card className="border-primary/20">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Video className="h-4 w-4 text-primary" /> New Meeting
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Title *</label>
            <input
              autoFocus
              aria-label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sprint Planning"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Google Meet, Zoom, Office..."
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this meeting about?"
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Date *</label>
            <input
              type="date"
              aria-label="Date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
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
            <label className="block text-xs font-medium text-foreground mb-1">End *</label>
            <TimePicker
              value={endTime}
              onChange={setEndTime}
              aria-label="End time"
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
        {hasInvalidTimeRange && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {MEETING_TIME_ORDER_MESSAGE}
          </p>
        )}

        {/* Recurrence */}
        <div>
          <label className="block text-xs font-medium text-foreground mb-1.5">Repeat</label>
          <div className="flex gap-1.5">
            {[
              { value: '' as const, label: 'One-time' },
              { value: 'daily' as const, label: 'Daily' },
              { value: 'weekly' as const, label: 'Weekly' },
              { value: 'biweekly' as const, label: 'Bi-weekly' },
              { value: 'monthly' as const, label: 'Monthly' },
            ].map((opt) => (
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

        {/* Attendees */}
        {team && (
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">
              Attendees ({attendeeIds.length} selected)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {team.map((m) => (
                <button
                  key={m.id}
                  onClick={() =>
                    setAttendeeIds((prev) =>
                      prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                    )
                  }
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    attendeeIds.includes(m.id)
                      ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Avatar className="h-4 w-4">
                    <AvatarImage src={m.avatar ?? undefined} />
                    <AvatarFallback className="text-[6px] bg-muted">{m.name[0]}</AvatarFallback>
                  </Avatar>
                  {m.name.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!title.trim() || !hasCompleteTimeRange || hasInvalidTimeRange || isPending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Schedule
          </button>
        </div>
      </CardContent>
    </Card>
  );
});

const MeetingCard = memo(function MeetingCard({
  meeting,
  onDelete,
  isPast,
  team,
}: {
  meeting: {
    id: string;
    title: string;
    description: string | null;
    startTime: Date;
    endTime: Date;
    location: string | null;
    recurrence: string | null;
    attendees: Array<{
      joinedAt?: Date | null;
      user: { id: string; name: string; avatar: string | null };
    }>;
  };
  onDelete: (id: string) => void;
  isPast?: boolean;
  team?: Array<{ id: string; name: string; avatar: string | null }>;
}) {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const [isEditing, setIsEditing] = useState(false);
  const [showAttendance, setShowAttendance] = useState(false);
  const [renderedAt] = useState(() => Date.now());

  const [eTitle, setETitle] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eDate, setEDate] = useState('');
  const [eStart, setEStart] = useState('');
  const [eEnd, setEEnd] = useState('');
  const [eLoc, setELoc] = useState('');
  const [eRecurrence, setERecurrence] = useState<'daily' | 'weekly' | 'biweekly' | 'monthly' | ''>(
    ''
  );
  const [eAttendees, setEAttendees] = useState<string[]>([]);

  const updateMeeting = trpc.meetings.update.useMutation({
    onSuccess: () => {
      utils.meetings.getUpcoming.invalidate();
      utils.meetings.getPast.invalidate();
      setIsEditing(false);
    },
  });

  // Memoize the derived occurrence dates so they keep a stable identity across
  // re-renders (these feed the attendance computation below).
  const start = useMemo(() => new Date(meeting.startTime), [meeting.startTime]);
  const end = useMemo(() => new Date(meeting.endTime), [meeting.endTime]);

  // Preserve the calendar-day span of overnight/multi-day meetings, including
  // when moving their date. Set the end date before applying its local time.
  const editEndDate = eDate
    ? format(
        addDays(new Date(`${eDate}T00:00`), differenceInCalendarDays(end, start)),
        'yyyy-MM-dd'
      )
    : '';
  const editStartTime = new Date(`${eDate}T${eStart}`);
  const editEndTime = new Date(`${editEndDate}T${eEnd}`);
  const hasCompleteEditTimeRange = Boolean(eDate && eStart && eEnd);
  const hasInvalidEditTimeRange =
    hasCompleteEditTimeRange && !isValidMeetingTimeRange(editStartTime, editEndTime);

  // Precompute per-attendee punctuality once per attendee/occurrence change
  // instead of on every render of the attendance panel.
  const attendanceRows = useMemo(
    () =>
      meeting.attendees.map((a) => {
        const joined = !!a.joinedAt;
        const joinedAt = joined ? new Date(a.joinedAt as Date) : null;
        // Use the shared helper so recurring meetings compare against the
        // actual occurrence start, not the original meeting startTime.
        const p = computePunctuality(
          { startTime: start, recurrence: meeting.recurrence },
          joinedAt
        );
        const punctuality = p
          ? { label: p.label, tone: p.isOnTime ? 'text-emerald-500' : 'text-amber-500' }
          : null;
        return { user: a.user, joined, joinedAt, punctuality };
      }),
    [meeting.attendees, meeting.recurrence, start]
  );

  const startEdit = () => {
    const s = new Date(meeting.startTime);
    const e = new Date(meeting.endTime);
    setETitle(meeting.title);
    setEDesc(meeting.description || '');
    setEDate(format(s, 'yyyy-MM-dd'));
    setEStart(format(s, 'HH:mm'));
    setEEnd(format(e, 'HH:mm'));
    setELoc(meeting.location || '');
    setERecurrence((meeting.recurrence as typeof eRecurrence) || '');
    setEAttendees(meeting.attendees.map((a) => a.user.id));
    setIsEditing(true);
  };

  const handleSave = () => {
    if (!eTitle.trim() || !hasCompleteEditTimeRange || hasInvalidEditTimeRange) return;
    updateMeeting.mutate({
      id: meeting.id,
      title: eTitle.trim(),
      description: eDesc.trim() || null,
      startTime: editStartTime,
      endTime: editEndTime,
      location: eLoc || null,
      recurrence: eRecurrence || null,
      attendeeIds: eAttendees,
    });
  };

  if (isEditing) {
    return (
      <Card className="border-primary/20">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">Edit Meeting</h3>
            <button
              onClick={() => setIsEditing(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-foreground mb-1">Title</label>
              <input
                value={eTitle}
                onChange={(e) => setETitle(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-foreground mb-1">Location</label>
              <input
                value={eLoc}
                onChange={(e) => setELoc(e.target.value)}
                placeholder="Google Meet..."
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-foreground mb-1">Date</label>
              <input
                type="date"
                value={eDate}
                onChange={(e) => setEDate(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-foreground mb-1">Start</label>
              <TimePicker
                value={eStart}
                onChange={setEStart}
                aria-label="Start time"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-foreground mb-1">End</label>
              <TimePicker
                value={eEnd}
                onChange={setEEnd}
                aria-label="End time"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
          </div>
          {hasInvalidEditTimeRange && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {MEETING_TIME_ORDER_MESSAGE}
            </p>
          )}
          <div>
            <label className="block text-[10px] font-medium text-foreground mb-1">Repeat</label>
            <div className="flex gap-1">
              {[
                { value: '' as const, label: 'Once' },
                { value: 'daily' as const, label: 'Daily' },
                { value: 'weekly' as const, label: 'Weekly' },
                { value: 'biweekly' as const, label: 'Bi-wk' },
                { value: 'monthly' as const, label: 'Monthly' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setERecurrence(opt.value)}
                  className={cn(
                    'rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                    eRecurrence === opt.value
                      ? 'bg-foreground text-background'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {team && (
            <div>
              <label className="block text-[10px] font-medium text-foreground mb-1">
                Attendees
              </label>
              <div className="flex flex-wrap gap-1">
                {team.map((m) => (
                  <button
                    key={m.id}
                    onClick={() =>
                      setEAttendees((prev) =>
                        prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                      )
                    }
                    className={cn(
                      'rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors',
                      eAttendees.includes(m.id)
                        ? 'bg-primary/10 text-primary'
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
              onClick={() => setIsEditing(false)}
              className="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={
                !eTitle.trim() ||
                !hasCompleteEditTimeRange ||
                hasInvalidEditTimeRange ||
                updateMeeting.isPending
              }
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
            >
              {updateMeeting.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasStarted = renderedAt >= start.getTime();
  const dateLabel = isToday(start)
    ? 'Today'
    : isTomorrow(start)
      ? 'Tomorrow'
      : format(start, 'EEE, MMM d');

  const joinedCount = meeting.attendees.filter((a) => a.joinedAt).length;
  const totalCount = meeting.attendees.length;

  return (
    <div
      className={cn(
        'group rounded-xl border border-border/60 bg-card transition-colors hover:border-border',
        isPast && 'opacity-60'
      )}
    >
      <div className="flex items-center gap-4 p-4">
        <div className="shrink-0 w-20 text-center">
          <p
            className={cn('text-xs font-medium', isPast ? 'text-muted-foreground' : 'text-primary')}
          >
            {dateLabel}
          </p>
          <p className="font-display text-lg font-bold text-foreground leading-tight">
            {format(start, 'h:mm')}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {format(start, 'a')} – {format(end, 'h:mm a')}
          </p>
        </div>

        <div className="h-10 w-px bg-border/60" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/meetings/${meeting.id}`}
              className={cn(
                'text-sm font-semibold truncate hover:underline',
                isPast ? 'text-muted-foreground' : 'text-foreground'
              )}
              title="View meeting & attendance report"
            >
              {meeting.title}
            </Link>
            {meeting.recurrence && (
              <span className="rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-500 shrink-0 flex items-center gap-0.5">
                <RefreshCw className="h-2.5 w-2.5" />
                {recurrenceLabels[meeting.recurrence] || meeting.recurrence}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            {meeting.location && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {meeting.location}
              </span>
            )}
            <button
              onClick={() => setShowAttendance((v) => !v)}
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              title="Show attendance"
            >
              <Users className="h-3 w-3" />
              {hasStarted ? `${joinedCount}/${totalCount} joined` : `${totalCount} invited`}
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', showAttendance && 'rotate-180')}
              />
            </button>
          </div>
          {meeting.description && (
            <p className="text-xs text-muted-foreground mt-1 truncate">{meeting.description}</p>
          )}
        </div>

        <div className="hidden sm:flex -space-x-1.5 shrink-0">
          {meeting.attendees.slice(0, 4).map((a) => {
            const joined = !!a.joinedAt;
            return (
              <div key={a.user.id} className="relative">
                <Avatar
                  className={cn(
                    'h-7 w-7 border-2 transition-colors',
                    joined ? 'border-emerald-500' : 'border-card'
                  )}
                  title={
                    joined
                      ? `${a.user.name} · joined ${format(new Date(a.joinedAt!), 'h:mm a')}`
                      : `${a.user.name} · not joined`
                  }
                >
                  <AvatarImage src={a.user.avatar ?? undefined} />
                  <AvatarFallback className="text-[9px] bg-secondary font-medium">
                    {a.user.name[0]}
                  </AvatarFallback>
                </Avatar>
                {joined && (
                  <div className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-card">
                    <Check className="h-2 w-2 text-white" strokeWidth={3} />
                  </div>
                )}
              </div>
            );
          })}
          {meeting.attendees.length > 4 && (
            <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-card bg-secondary text-[9px] font-semibold text-muted-foreground">
              +{meeting.attendees.length - 4}
            </div>
          )}
        </div>

        {/* Sends an attendee to the occurrence list, because the room is
            occurrence-scoped and the series alone does not name one. */}
        {(() => {
          const isAttendee = meeting.attendees.some((a) => a.user.id === currentUserId);
          const hasEnded = renderedAt >= end.getTime();
          if (!isAttendee || hasEnded) return null;
          return (
            <Link
              href={`/meetings/${meeting.id}#occurrences`}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
              title="Join in-app video call"
            >
              <Video className="h-3.5 w-3.5" />
              Join call
            </Link>
          );
        })()}

        <div className="flex items-center gap-0.5">
          <button
            onClick={startEdit}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/0 group-hover:text-muted-foreground hover:!bg-secondary hover:!text-foreground transition-all shrink-0"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onDelete(meeting.id)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-500 hover:!bg-red-500/10 transition-all shrink-0"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Expandable attendance panel */}
      {showAttendance && (
        <div className="border-t border-border/60 px-4 pb-4 pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Attendance {hasStarted && `· ${joinedCount} of ${totalCount} joined`}
          </p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {attendanceRows.map(({ user, joined, joinedAt, punctuality }) => {
              return (
                <div
                  key={user.id}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5',
                    joined
                      ? 'border-emerald-500/20 bg-emerald-500/5'
                      : 'border-border/60 bg-background/50'
                  )}
                >
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={user.avatar ?? undefined} />
                    <AvatarFallback className="text-[9px] bg-secondary font-medium">
                      {user.name[0]}
                    </AvatarFallback>
                  </Avatar>
                  <p className="flex-1 text-xs font-medium text-foreground truncate">{user.name}</p>
                  {joined ? (
                    <>
                      <span
                        className={cn('text-[10px] font-medium tabular-nums', punctuality?.tone)}
                      >
                        {punctuality?.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {format(joinedAt!, 'h:mm a')}
                      </span>
                      <UserCheck className="h-3 w-3 text-emerald-500 shrink-0" />
                    </>
                  ) : (
                    <>
                      <span className="text-[10px] text-muted-foreground">
                        {hasStarted ? (isPast ? 'did not join' : 'not joined yet') : 'invited'}
                      </span>
                      <UserX className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
