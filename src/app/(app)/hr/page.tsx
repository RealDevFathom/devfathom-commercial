import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { HRContent } from './hr-content';

export const metadata: Metadata = { title: 'HR & Leave' };

export default async function HRPage() {
  const session = await auth();
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  return <HRContent />;
}
