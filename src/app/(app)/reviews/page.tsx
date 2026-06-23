import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { ReviewsContent } from './reviews-content';

export const metadata: Metadata = { title: 'Performance Reviews' };

export default async function ReviewsPage() {
  const session = await auth();
  // Open to every active employee: reviewers fill the reviews assigned to them and
  // subjects read submitted feedback. The cycle-management UI inside is gated to
  // HR/Admin (and enforced server-side by `hrProcedure`).
  if (!session?.user) {
    redirect('/login');
  }
  return <ReviewsContent />;
}
