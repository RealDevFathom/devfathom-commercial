import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { TeamStatsContent } from './stats-content';

export const metadata: Metadata = {
  title: 'Team Insights',
};

export default async function TeamStatsPage() {
  const session = await auth();
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  return <TeamStatsContent />;
}
