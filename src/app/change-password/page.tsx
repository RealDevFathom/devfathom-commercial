import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change password' };

export default async function ChangePasswordPage() {
  const actor = await resolveTenantActor();
  if (!actor?.session.user?.id) redirect('/login');
  if (actor.session.user.mustChangePassword !== true) redirect('/dashboard');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center bg-surface-page px-4 py-10">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
        Account
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-strong">
        Change your password
      </h1>
      <p className="mt-2 text-sm text-text-body">
        This temporary password has to be replaced before the rest of the workspace opens.
      </p>
      <ChangePasswordForm />
    </main>
  );
}
