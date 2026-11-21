import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { requireProviderRefundMappingAccess } from '@/server/routers/organization-pharmacy-settings';
import { createTRPCContext } from '@/server/trpc';
import { SettingsContent } from './settings-content';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const actor = await resolveTenantActor();
  if (actor?.organization.vertical !== 'PHARMACY') return <SettingsContent />;
  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  const allowed = await requireProviderRefundMappingAccess(ctx).then(
    () => true,
    () => false
  );
  return (
    <SettingsContent
      providerRefundSettings={
        allowed && (
          <SectionCard title="Card provider refunds" titleLevel={2}>
            <Link
              href="/pharmacy/settings/provider-refunds"
              className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
            >
              Set the provider refund account
            </Link>
          </SectionCard>
        )
      }
    />
  );
}
