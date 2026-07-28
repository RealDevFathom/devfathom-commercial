import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { AuditContent } from './audit-content';

export const metadata: Metadata = {
  title: 'Audit Log',
};

export default async function AuditLogPage() {
  const session = (await resolveTenantActor())?.session;
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  return <AuditContent />;
}
