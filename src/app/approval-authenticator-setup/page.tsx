import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { approvalAuthenticatorPartySelect } from '@/lib/approval-authenticator-party';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { ApprovalAuthenticatorSetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up your authenticator' };

/**
 * DEV-961: the only screen a member who can approve sees until they set up their
 * authenticator app for approvals. The server refuses every other page and API call.
 */
export default async function ApprovalAuthenticatorSetupPage() {
  const actor = await resolveTenantActor();
  if (!actor?.session.user?.id) redirect('/login');
  if (actor.session.user.mustChangePassword === true) redirect('/change-password');
  if (actor.session.user.approvalAuthenticatorSetupRequired !== true) redirect('/dashboard');
  // A member signed in by single sign-on has no password; a fresh sign-in stands in for it.
  const account = await withTenantDb(actor.organization.id, (db) =>
    db.user.findFirst({
      where: { id: actor.session.user.id, organizationId: actor.organization.id },
      select: { password: true, ...approvalAuthenticatorPartySelect() },
    })
  );
  // The owner may instead switch approvals to permanent PINs (checked again on the server).
  const isOwner = Boolean(account && hasAllCapabilityAccess(account));

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen max-w-lg flex-col justify-center bg-surface-page px-4 py-10"
    >
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
        Account security
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-strong">
        Set up your authenticator app
      </h1>
      <p className="mt-2 text-sm text-text-body">
        You approve refunds, discounts or other actions for your team. Your organization uses a code
        from an authenticator app for approvals instead of a fixed PIN. Your account opens once the
        app is set up.
      </p>
      <ApprovalAuthenticatorSetupForm
        passwordless={Boolean(account && !account.password)}
        isOwner={isOwner}
      />
    </main>
  );
}
