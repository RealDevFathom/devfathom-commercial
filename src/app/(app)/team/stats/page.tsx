import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { TeamStatsContent } from './stats-content';

export const metadata: Metadata = {
  title: 'Team Insights',
};

export default async function TeamStatsPage() {
  const session = (await resolveTenantActor())?.session;
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  return <TeamStatsContent />;
}
