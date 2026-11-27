import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveOrganizationForRequest, isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { WALLET_CLASS_SUFFIX_PATTERN } from '@/lib/wallet/google';

export async function GET(request: Request, context: { params: Promise<{ suffix: string }> }) {
  const { suffix } = await context.params;
  if (!WALLET_CLASS_SUFFIX_PATTERN.test(suffix)) return new Response(null, { status: 404 });
  const org = await resolveOrganizationForRequest(request);
  if (!org || !isTenantLifecycleAccessible(org.status)) return new Response(null, { status: 404 });
  const config = await withTenantDb(org.id, async (db) => {
    const grant = await resolveOrganizationEntitlements(org.id, db);
    const module =
      org.vertical === 'PHARMACY'
        ? 'pharmacy-crm'
        : org.vertical === 'RESTAURANT'
          ? 'restaurant-loyalty'
          : null;
    if (!module || !hasModule(grant, module)) return null;
    return db.walletTenantConfig.findFirst({
      where: { organizationId: org.id, googleClassSuffix: suffix, enabled: true },
      select: { logoPng: true },
    });
  });
  if (!config) return new Response(null, { status: 404 });
  const bytes = config.logoPng ?? (await readFile(join(process.cwd(), 'public/favicon.png')));
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
