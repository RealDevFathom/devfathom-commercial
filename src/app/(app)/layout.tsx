import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { AppShell } from '@/components/layout/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // SEC-03 / AUTH-02: a single server-side auth guard for every /(app) page. The
  // edge proxy only checks cookie PRESENCE, so a stale/forged session cookie would
  // otherwise slip through and render a broken shell; verifying the session here
  // (auth() validates the JWT) sends it to a clean /login redirect instead, and
  // pages no longer each have to remember to call auth() themselves.
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  // AUTH-01 / AUTH-03: a deactivated, deleted, or session-REVOKED token (its
  // tokenVersion was bumped on password change / lay-off / sign-out-everywhere)
  // is no longer allowed to render the app — send it to a clean re-login. Lenient
  // on a missing status to avoid locking out older valid tokens (mirrors ABAC).
  if (session.user.status && !ACTIVE_STATUSES.has(session.user.status)) redirect('/login');
  return <AppShell>{children}</AppShell>;
}
