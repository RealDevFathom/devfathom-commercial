import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { createTenantDb, withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { tenantHostUrl } from '@/lib/tenancy/host-routing';
import { createGoogleWalletClient } from './google';
import { createWalletProviderDelivery, deliverWalletUpdates } from './balance-updates';
import { walletRuntime } from './modes';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';

// Uses the existing authorized outbox tick. TEST rows and legacy restaurant rows
// are excluded from the new provider path, including when the environment changes.
export async function drainBusinessWallets() {
  const runtime = walletRuntime();
  if (runtime.mode === 'TEST') return;
  const mode = runtime.mode,
    platforms = [...(runtime.google ? ['GOOGLE'] : []), ...(runtime.apns ? ['APPLE'] : [])];
  if (!platforms.length) return;
  const tenants = await withPlatformDb((db) =>
    db.$queryRaw<{ organizationId: string }[]>(Prisma.sql`
  SELECT u."organizationId" FROM restaurant_wallet_pass_updates u
  JOIN restaurant_wallet_passes p ON p.id=u."passId" AND p."organizationId"=u."organizationId"
  JOIN restaurant_wallet_tenant_config c ON c."organizationId"=p."organizationId"
  JOIN organizations o ON o.id=c."organizationId" AND o.status='ACTIVE'
  WHERE (u.status='PENDING' OR (u.status='FAILED' AND u.attempts<8)) AND u."nextAttemptAt"<=now() AND p."issuerMode"=${mode}
    AND p.platform::text IN (${Prisma.join(platforms)}) AND (c.enabled OR p.status='REVOKED')
  GROUP BY u."organizationId" ORDER BY min(u."nextAttemptAt") LIMIT 10`)
  );
  const googleClient = runtime.google
    ? createGoogleWalletClient({ credentials: runtime.google })
    : undefined;
  for (const { organizationId } of tenants) {
    await withTenantDb(
      organizationId,
      async (db) => {
        // Only competing workers take this advisory lock. Claims and acknowledgements use
        // independent short transactions, so an issuer call never holds a sale's outbox row.
        const [lock] = await db.$queryRaw<
          { held: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${'wallet-delivery:' + organizationId},0)) AS held`;
        if (!lock?.held) return;
        const ent = await resolveOrganizationEntitlements(organizationId, db);
        const module =
          ent.vertical === 'PHARMACY'
            ? 'pharmacy-crm'
            : ent.vertical === 'RESTAURANT'
              ? 'restaurant-loyalty'
              : null;
        if (!module || !hasModule(ent, module)) return;
        const deliveryDb = createTenantDb(organizationId);
        async function refreshGoogleDesign() {
          const design = await deliveryDb.walletTenantConfig.findUniqueOrThrow({
            where: { organizationId },
          });
          const business = await deliveryDb.organization.findUniqueOrThrow({
            where: { id: organizationId },
            select: { slug: true },
          });
          const logoUri = tenantHostUrl(
            business.slug,
            '/api/wallet/logo/' + design.googleClassSuffix + '?v=' + design.updatedAt.getTime()
          );
          if (!logoUri || !googleClient) throw new Error('Google Wallet design unavailable.');
          await googleClient.ensureLoyaltyClass({
            classSuffix: design.googleClassSuffix,
            refreshBrand: true,
            brand: {
              programDisplayName: design.programDisplayName,
              backgroundColor: design.backgroundColor,
              logoUri,
            },
          });
        }
        await deliverWalletUpdates(
          deliveryDb,
          createWalletProviderDelivery({
            db: deliveryDb,
            googleClient,
            appleCredentials: runtime.apns,
            refreshGoogleDesign,
          }),
          {
            limit: 1,
            mode,
            platforms,
            scope: (work) => withTenantDb(organizationId, work, { skipDrain: true }),
          }
        );
      },
      { skipDrain: true }
    );
  }
}
