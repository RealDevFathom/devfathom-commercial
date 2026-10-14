import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { growthInputSchema, prepareGrowthInput } from '@/lib/ai/growth-recommendations';
import { cateringGrowthInput, growthProvenanceSchema, growthSourceHash } from './growth-source';

export const restaurantGrowthMetadata = z
  .object({
    version: z.literal('restaurant-growth-v2'),
    fingerprint: z.string().min(1),
    provenance: growthProvenanceSchema.nullable(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    failureReason: z.string().nullable(),
  })
  .strict();
export function restaurantGrowthInputHash(input: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(prepareGrowthInput(input)))
    .digest('hex');
}
export function parseRestaurantGrowthSnapshot(snapshot: unknown) {
  const { _restaurant, ...raw } = z
    .object({ _restaurant: restaurantGrowthMetadata })
    .passthrough()
    .parse(snapshot);
  const input = prepareGrowthInput(raw);
  if (
    growthInputSchema.parse(raw).facts.length !== input.facts.length ||
    !_restaurant.provenance ||
    _restaurant.failureReason !== null ||
    growthSourceHash(_restaurant.provenance) !== _restaurant.sourceHash ||
    restaurantGrowthInputHash(cateringGrowthInput(_restaurant.provenance)) !==
      restaurantGrowthInputHash(input)
  )
    throw new Error('Invalid Restaurant source lineage');
  return { input, metadata: _restaurant };
}
