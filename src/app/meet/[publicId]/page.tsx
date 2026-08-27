import type { Metadata } from 'next';
import { MeetingLobby } from '@/components/meetings/meeting-lobby';

export const metadata: Metadata = { title: 'Join meeting' };
export const dynamic = 'force-dynamic';

export default async function PublicMeetingPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  return <MeetingLobby publicId={publicId} />;
}
