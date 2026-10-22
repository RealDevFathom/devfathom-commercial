'use server';

import { z } from 'zod';
import { requirePlatformSession } from '@/lib/platform/auth';
import { backfillPharmacyCatalog } from '@/lib/pharmacy/catalog/backfill';
import { assertCanBackfillPharmacyCatalog } from '@/lib/pharmacy/catalog/platform-authz';

const inputSchema = z.union([
  z
    .object({
      organizationId: z.string().min(3).max(128),
      allPharmacy: z.never().optional(),
      apply: z.boolean(),
    })
    .strict(),
  z
    .object({
      allPharmacy: z.literal(true),
      organizationId: z.never().optional(),
      apply: z.boolean(),
    })
    .strict(),
]);
export async function backfillPharmacyCatalogAction(input: unknown) {
  const actor = await requirePlatformSession();
  // Central can() for the modeled platform actor, before any input parsing or
  // database access. The service repeats the same decision for non-HTTP callers.
  await assertCanBackfillPharmacyCatalog(actor);
  const parsed = inputSchema.parse(input);
  const target = parsed.allPharmacy
    ? { allPharmacy: true as const }
    : { organizationId: parsed.organizationId! };
  return backfillPharmacyCatalog(actor, target, parsed.apply);
}
