'use client';

// IMP-RT-01 — per-meeting attendance reporting. Surfaces meetings.getAttendanceReport
// (held-occurrence count + per-person attendance rate from MeetingAttendanceLog) on a
// dedicated meeting page, alongside the meeting details and a join-call link.

import Link from 'next/link';
import { ArrowLeft, Video, Calendar, MapPin, Repeat, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function fmtDateTime(d: Date | string) {
  return new Date(d).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function MeetingDetail({ meetingId }: { meetingId: string }) {
  const meetingQ = trpc.meetings.getById.useQuery({ id: meetingId });
  const reportQ = trpc.meetings.getAttendanceReport.useQuery({ meetingId });

  if (meetingQ.isLoading) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-sm text-muted-foreground">
        Loading meeting…
      </div>
    );
  }

  if (meetingQ.error || !meetingQ.data) {
    return (
      <div className="max-w-3xl mx-auto space-y-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">
          {meetingQ.error?.data?.code === 'FORBIDDEN'
            ? "You don't have access to this meeting."
            : 'Meeting not found.'}
        </p>
        <Link href="/meetings" className="text-sm text-primary hover:underline">
          Back to meetings
        </Link>
      </div>
    );
  }

  const meeting = meetingQ.data;
  const report = reportQ.data;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="space-y-4">
        <Link
          href="/meetings"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Meetings
        </Link>
        <PageHeader
          eyebrow="WORKSPACE"
          heading={meeting.title}
          description={meeting.description ?? undefined}
          className="mb-0"
          actions={
            <Button
              size="lg"
              className="h-10 px-4"
              nativeButton={false}
              render={<Link href={`/meetings/${meetingId}/call`} />}
            >
              <Video className="h-4 w-4" />
              Join call
            </Button>
          }
        />
      </div>

      {/* Meeting meta */}
      <Card className="border-border/60">
        <CardContent className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Meta icon={Calendar} label="When">
            {fmtDateTime(meeting.startTime)} – {fmtDateTime(meeting.endTime)}
          </Meta>
          <Meta icon={MapPin} label="Where">
            {meeting.location || '—'}
          </Meta>
          <Meta icon={Repeat} label="Recurrence">
            {meeting.recurrence ? (
              <span className="capitalize">{meeting.recurrence}</span>
            ) : (
              'One-time'
            )}
          </Meta>
        </CardContent>
      </Card>

      {/* Attendance report */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold text-foreground">Attendance</h2>
          {report && (
            <span className="text-xs text-muted-foreground">
              · {report.heldOccurrences} occurrence{report.heldOccurrences === 1 ? '' : 's'} held
            </span>
          )}
        </div>

        {reportQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading attendance…</p>
        ) : !report || report.attendees.length === 0 ? (
          <Card className="border-border/60">
            <CardContent className="p-6 text-sm text-muted-foreground">
              No attendance has been recorded yet. Joins are logged when members open the call.
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/60">
            <CardContent className="p-0 divide-y divide-border/60">
              {report.attendees.map((a) => (
                <div key={a.user.id} className="flex items-center gap-3 p-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-xs font-semibold text-foreground">
                    {a.user.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.user.avatar} alt={a.user.name} className="h-full w-full object-cover" />
                    ) : (
                      initials(a.user.name)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{a.user.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Attended {a.attended} of {report.heldOccurrences}
                      {a.lastJoinedAt && <> · last {fmtDateTime(a.lastJoinedAt)}</>}
                    </p>
                  </div>
                  <div className="w-32 shrink-0">
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className={cn(
                          'text-xs font-semibold',
                          a.rate >= 75
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : a.rate >= 40
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-500'
                        )}
                      >
                        {a.rate}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          a.rate >= 75 ? 'bg-emerald-500' : a.rate >= 40 ? 'bg-amber-500' : 'bg-red-500'
                        )}
                        style={{ width: `${Math.min(100, a.rate)}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Meta({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-sm text-foreground">{children}</p>
      </div>
    </div>
  );
}
