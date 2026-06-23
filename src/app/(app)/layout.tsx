import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AppShell } from '@/components/layout/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // SEC-03 / AUTH-02: a single server-side auth guard for every /(app) page. The
  // edge proxy only checks cookie PRESENCE, so a stale/forged session cookie would
  // otherwise slip through and render a broken shell; verifying the session here
  // (auth() validates the JWT) sends it to a clean /login redirect instead, and
  // pages no longer each have to remember to call auth() themselves.
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  return <AppShell>{children}</AppShell>;
}
