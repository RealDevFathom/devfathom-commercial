import type { ScopedDb } from './scoped-db';
import { tenantHostUrl } from './host-routing';
import { appUrl } from '@/lib/email';

/** Resolve from the authenticated tenant, never from the requesting agency host. */
export async function tenantInviteUrl(db: ScopedDb, organizationId: string, token: string) {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      slug: true,
      domains: {
        where: { kind: 'APP', verificationStatus: 'VERIFIED' },
        orderBy: [{ isPrimary: 'desc' }, { host: 'asc' }],
        take: 1,
        select: { host: true },
      },
    },
  });
  if (!organization) throw new Error('Invitation workspace not found.');
  const path = `/invite/${token}`;
  const domain = organization.domains[0];
  if (domain) return `https://${domain.host}${path}`;
  return tenantHostUrl(organization.slug, path) ?? `${appUrl()}${path}`;
}
