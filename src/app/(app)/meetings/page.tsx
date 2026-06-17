import type { Metadata } from 'next';
import { MeetingsContent } from './meetings-content';

export const metadata: Metadata = { title: 'Meetings' };

export default function MeetingsPage() {
  return <MeetingsContent />;
}
