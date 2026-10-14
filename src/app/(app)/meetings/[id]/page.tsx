import type { Metadata } from 'next';
import { MeetingDetail } from '@/components/meetings/meeting-detail';
import { OccurrenceJoinLinks } from '@/components/meetings/occurrence-join-links';

export const metadata: Metadata = { title: 'Meeting' };

export default async function MeetingDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <MeetingDetail meetingId={id} />
      <OccurrenceJoinLinks meetingId={id} />
    </div>
  );
}
