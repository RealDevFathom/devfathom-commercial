import type { Metadata } from 'next';
import { MeetingCall } from '@/components/meetings/meeting-call';

export const metadata: Metadata = { title: 'Meeting Call' };

export default async function MeetingCallPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <MeetingCall meetingId={id} />;
}
