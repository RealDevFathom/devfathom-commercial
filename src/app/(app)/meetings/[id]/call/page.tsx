import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Meeting Call' };

export default async function MeetingCallPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/meetings/${id}#occurrences`);
}
