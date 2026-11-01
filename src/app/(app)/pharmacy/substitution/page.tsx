import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SubstitutionConsole } from '@/components/pharmacy/dispensing/substitution-console';
import { can, subjectFromSession } from '@/lib/abac';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy substitution' };

/**
 * The substitution workspace exists only for members holding a dispensing or
 * safety capability, the same rule as its rail entry. Anyone else is sent to
 * their own home rather than shown a locked workspace or a permission error.
 * The workspace procedures keep their own server-side checks.
 */
async function clinicalAccess(): Promise<boolean> {
  const actor = await resolveTenantActor();
  if (!actor?.session.user) return false;
  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  const user = ctx.session?.user;
  if (!user) return false;
  const subject = subjectFromSession(user);
  const options = { db: ctx.db, source: 'TRPC' as const };
  const [dispense, safety] = await Promise.all([
    can(subject, 'pharmacy:dispense', undefined, options),
    can(subject, 'pharmacy:safety', undefined, options),
  ]);
  return dispense || safety;
}

export default async function SubstitutionPage() {
  if (!(await clinicalAccess())) redirect('/dashboard');
  return <SubstitutionConsole />;
}
