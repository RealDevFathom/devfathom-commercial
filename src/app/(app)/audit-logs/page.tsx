import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AuditContent } from './audit-content';

export const metadata: Metadata = {
  title: 'Audit Log',
};

export default async function AuditLogPage() {
  const session = await auth();
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  return <AuditContent />;
}
