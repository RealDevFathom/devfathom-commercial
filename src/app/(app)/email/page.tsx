import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Email' };

export default function EmailPage() {
  // The inbox is intentionally paused until OAuth and the mailbox schema are deployed.
  redirect('/dashboard');
}
