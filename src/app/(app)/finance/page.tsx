import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { FinanceContent } from './finance-content';

export const metadata: Metadata = {
  title: 'Finance',
};

export default async function FinancePage() {
  const session = (await resolveTenantActor())?.session;
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  return <FinanceContent />;
}
