import { redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { pendingOwnPinProfile } from '@/lib/restaurant/invited-staff';
import { SetPinForm } from './set-pin-form';

export default async function SetPinPage() {
  const actor = await resolveTenantActor();
  if (!actor?.session.user?.id) redirect('/login');
  const pending = await withTenantDb(actor.session.user.organizationId, (db) =>
    pendingOwnPinProfile(db, actor.session.user.id)
  );
  if (!pending) redirect('/dashboard');
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center bg-surface-page px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight text-text-strong">
        Set your operator PIN
      </h1>
      <p className="mt-2 text-sm text-text-body">
        Choose your own 4–8 digit PIN before opening the workspace.
      </p>
      <SetPinForm />
    </main>
  );
}
