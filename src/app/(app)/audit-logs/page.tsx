import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { AuditContent } from './audit-content';

export const metadata: Metadata = {
  title: 'Audit Log',
};

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await resolveTenantActor();
  const session = actor?.session;
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  const query = await searchParams;
  const initialFilters = {
    actorId: typeof query.actorId === 'string' ? query.actorId : '',
    search: typeof query.search === 'string' ? query.search : '',
    branchId: typeof query.branchId === 'string' ? query.branchId : '',
  };
  return (
    <AuditContent
      key={JSON.stringify(initialFilters)}
      initialFilters={initialFilters}
      timeZone={actor?.organization?.timezone ?? null}
      pharmacy={actor?.organization?.vertical === 'PHARMACY'}
    />
  );
}
