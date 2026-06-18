import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { HRContent } from './hr-content';

export const metadata: Metadata = { title: 'HR & Leave' };

export default async function HRPage() {
  const session = await auth();
  // The HR console is for people-ops: ADMINs and the HR role.
  const role = session?.user?.role;
  if (role !== 'ADMIN' && role !== 'HR') {
    redirect('/dashboard');
  }
  return <HRContent />;
}
