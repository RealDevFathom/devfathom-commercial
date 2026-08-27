import Link from 'next/link';
import { CalendarClock, Video } from 'lucide-react';
import { canAccessMeeting } from '@/lib/authz';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';

export async function OccurrenceJoinLinks({ meetingId }: { meetingId: string }) {
  const actor = await resolveTenantActor({});
  if (!actor) return null;
  const occurrences = await withTenantDb(actor.organization.id, async (db) => {
    if (!(await canAccessMeeting(db, actor.session.user.id, actor.session.user.role, meetingId)))
      return null;
    return db.meetingOccurrence.findMany({
      where: {
        meetingId,
        cancelledAt: null,
        status: { notIn: ['DRAFT', 'ENDED', 'CANCELLED'] },
        joinClosesAt: { gte: new Date() },
      },
      orderBy: { scheduledStart: 'asc' },
      take: 5,
      select: {
        id: true,
        publicId: true,
        scheduledStart: true,
        scheduledEnd: true,
        joinOpensAt: true,
      },
    });
  });
  if (!occurrences) return null;

  return (
    <SectionCard
      id="occurrences"
      eyebrow="OCCURRENCES"
      title="Join an occurrence"
      className="scroll-mt-6"
    >
      {occurrences.length ? (
        <ul className="divide-y divide-border-subtle">
          {occurrences.map((occurrence) => {
            const open = occurrence.joinOpensAt <= new Date();
            return (
              <li
                key={occurrence.id}
                className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex items-start gap-3">
                  <CalendarClock className="mt-0.5 size-4 text-text-muted" />
                  <div>
                    <p className="text-sm font-medium text-text-strong">
                      {occurrence.scheduledStart.toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                    <p className="text-xs text-text-muted">
                      Ends{' '}
                      {occurrence.scheduledEnd.toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                </div>
                <Button
                  nativeButton={false}
                  render={<Link href={`/meet/${occurrence.publicId}`} />}
                  disabled={!open}
                >
                  <Video /> {open ? 'Open lobby' : 'Lobby opens later'}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-text-muted">No upcoming joinable occurrences are available.</p>
      )}
    </SectionCard>
  );
}
