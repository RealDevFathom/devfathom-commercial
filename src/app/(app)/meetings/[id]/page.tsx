import type { Metadata } from 'next';
import { MeetingDetail } from '@/components/meetings/meeting-detail';

export const metadata: Metadata = { title: 'Meeting' };

export default async function MeetingDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <MeetingDetail meetingId={id} />;
}
