'use server';

import { z } from 'zod';
import { requirePlatformSession } from '@/lib/platform/auth';
import { backfillPharmacyCatalog } from '@/lib/pharmacy/catalog/backfill';
import { PlatformSecurityError } from '@/lib/platform/security';

const inputSchema = z.union([
  z.object({ organizationId: z.string().min(3).max(128), allPharmacy: z.never().optional(), apply: z.boolean() }).strict(),
  z.object({ allPharmacy: z.literal(true), organizationId: z.never().optional(), apply: z.boolean() }).strict(),
]);
export async function backfillPharmacyCatalogAction(input: unknown) {
  const actor = await requirePlatformSession();
  if (actor.role !== 'SUPER_ADMIN') throw new PlatformSecurityError('SuperAdmin access is required.', 403);
  const parsed = inputSchema.parse(input);
  const target = parsed.allPharmacy ? { allPharmacy: true as const } : { organizationId: parsed.organizationId! };
  return backfillPharmacyCatalog(actor, target, parsed.apply);
}
