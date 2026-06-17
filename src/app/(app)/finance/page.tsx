import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { FinanceContent } from './finance-content';

export const metadata: Metadata = {
  title: 'Finance',
};

export default async function FinancePage() {
  const session = await auth();
  if (session?.user?.role !== 'ADMIN') {
    redirect('/dashboard');
  }
  return <FinanceContent />;
}
