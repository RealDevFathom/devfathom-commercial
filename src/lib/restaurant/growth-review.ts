import 'server-only';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AssistantHelpers } from '@/lib/ai/context';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  growthReadInput,
  growthReviewInput,
  growthSettings,
  reviewProjection,
  RESTAURANT_GROWTH_ACTIONS,
  type GrowthView,
} from './growth-review-contract';

/** Provisional shared-storage shape read on October 7. No shared implementation copied.
 * Coordinator supplies the accepted shared validator plus Restaurant evidence lineage
 * resolver here. No default, generator, provider or fabricated READY fallback exists.
 */
export interface RestaurantGrowthBinding {
  validatePersisted(snapshot: unknown, output: unknown): unknown;
  evidenceIsCurrent(
    db: ScopedDb,
    scope: { organizationId: string; branchId: string },
    hash: string,
    snapshot: unknown
  ): Promise<boolean>;
}
const rowSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  branchId: z.string(),
  vertical: z.literal('RESTAURANT'),
  schemaVersion: z.literal(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['READY', 'UNAVAILABLE', 'INVALID', 'INSUFFICIENT_DATA']),
  failureCode: z.string().nullable(),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  snapshot: z.unknown(),
  output: z.unknown(),
});
const reviewRow = z.object({
  recommendation: z.number().int().min(0).max(2),
  revision: z.number().int().min(1),
  decision: z.enum(['EDIT', 'REJECT', 'APPROVE']),
  settings: growthSettings,
  draftId: z.string().nullable(),
});
export class GrowthReviewError extends Error {
  constructor(public readonly code: 'DENIED' | 'UNAVAILABLE' | 'INVALID' | 'CONFLICT' | 'STALE') {
    super(code);
  }
}
export type GrowthActor = Pick<AssistantHelpers, 'ctx' | 'can' | 'db'>;
export async function authorizeRestaurantGrowth(h: GrowthActor, branchId: string, write: boolean) {
  if (
    h.ctx.vertical !== 'RESTAURANT' ||
    !h.ctx.enabledModules?.includes('restaurant-core') ||
    !h.ctx.enabledModules.includes('restaurant-pos') ||
    !(await h.can('reports:financial')) ||
    (write && !(await h.can('restaurant:configure')))
  )
    throw new GrowthReviewError('DENIED');
  const organization = await h.db.organization.findFirst({
    where: { id: h.ctx.organizationId },
    select: { vertical: true },
  });
  const branch = await h.db.restaurantBranch.findFirst({
    where: { id: branchId, organizationId: h.ctx.organizationId, active: true },
    select: { id: true },
  });
  if (organization?.vertical !== 'RESTAURANT' || branch?.id !== branchId)
    throw new GrowthReviewError('DENIED');
  if (!(await h.can('restaurant:configure'))) {
    const staff = await h.db.restaurantStaffProfile.findFirst({
      where: { organizationId: h.ctx.organizationId, userId: h.ctx.userId, status: 'ACTIVE' },
      select: { primaryBranchId: true },
    });
    const assignment = await h.db.restaurantBranchAssignment.findFirst({
      where: { organizationId: h.ctx.organizationId, userId: h.ctx.userId, branchId },
      select: { branchId: true },
    });
    if (staff?.primaryBranchId !== branchId && assignment?.branchId !== branchId)
      throw new GrowthReviewError('DENIED');
  }
}
async function readInTransaction(
  h: GrowthActor,
  input: z.infer<typeof growthReadInput>,
  binding: RestaurantGrowthBinding | null
): Promise<GrowthView> {
  await authorizeRestaurantGrowth(h, input.branchId, false);
  await h.db.$queryRawUnsafe(`SELECT set_config('app.current_branch_id',$1,true)`, input.branchId);
  const rows = await h.db.$queryRawUnsafe<unknown[]>(
    `SELECT id,"organizationId","branchId",vertical,"schemaVersion","inputHash",status,"failureCode",provider,model,snapshot,output FROM growth_insights WHERE "organizationId"=$1 AND "branchId"=$2 AND id=$3 AND vertical='RESTAURANT' LIMIT 1`,
    h.ctx.organizationId,
    input.branchId,
    input.insightId
  );
  if (!rows.length) return { status: 'NOT_FOUND' };
  const parsed = rowSchema.safeParse(rows[0]);
  if (!parsed.success) return { status: 'INVALID' };
  const row = parsed.data;
  if (
    row.organizationId !== h.ctx.organizationId ||
    row.branchId !== input.branchId ||
    row.id !== input.insightId
  )
    return { status: 'DENIED' };
  if (row.status !== 'READY') return { status: row.status };
  if (!row.provider || !row.model || row.failureCode !== null || !row.output)
    return { status: 'INVALID' };
  if (!binding) return { status: 'UNAVAILABLE' };
  const projection = reviewProjection.safeParse(
    binding.validatePersisted(row.snapshot, row.output)
  );
  if (!projection.success) return { status: 'INVALID' };
  const { current, comparison } = projection.data;
  if (
    ![current.from, current.cutoff, comparison.from, comparison.cutoff].every((value) =>
      value.endsWith('T00:00:00.000Z')
    )
  )
    return { status: 'INVALID' };
  for (const rec of projection.data.recommendations) {
    for (const fact of rec.evidence) {
      if (
        fact.unit !== (fact.key.endsWith('_minor') ? 'INTEGER_MINOR' : 'COUNT') ||
        fact.value.includes('.')
      )
        return { status: 'INVALID' };
    }
  }
  const duration = Date.parse(current.cutoff) - Date.parse(current.from);
  if (
    duration <= 0 ||
    duration > 45 * 86400000 ||
    Date.parse(comparison.cutoff) !== Date.parse(current.from) ||
    Date.parse(comparison.cutoff) - Date.parse(comparison.from) !== duration
  )
    return { status: 'INVALID' };
  if (
    !(await binding.evidenceIsCurrent(
      h.db,
      { organizationId: h.ctx.organizationId, branchId: input.branchId },
      row.inputHash,
      row.snapshot
    ))
  )
    return { status: 'STALE' };
  for (const recommendation of projection.data.recommendations) {
    const permission =
      recommendation.action === 'CATERING_REVIEW' ? 'catering:read' : 'restaurant:configure';
    if (!(await h.can(permission))) return { status: 'DENIED' };
  }
  const reviews = z
    .array(reviewRow)
    .max(3)
    .parse(
      await h.db.$queryRawUnsafe(
        `SELECT DISTINCT ON (recommendation) recommendation,revision,decision,settings,"draftId" FROM restaurant_growth_reviews WHERE "organizationId"=$1 AND "branchId"=$2 AND "insightId"=$3 ORDER BY recommendation,revision DESC LIMIT 3`,
        h.ctx.organizationId,
        input.branchId,
        input.insightId
      )
    );
  return {
    status: 'READY',
    insightId: row.id,
    branchId: row.branchId,
    hash: row.inputHash,
    version: 1,
    diagnostic: row.provider === 'TEST_DOUBLE',
    projection: projection.data,
    reviews,
  };
}
export async function readRestaurantGrowthReview(
  h: GrowthActor,
  raw: unknown,
  binding: RestaurantGrowthBinding | null = null
): Promise<GrowthView> {
  const input = growthReadInput.safeParse(raw);
  if (!input.success) return { status: 'INVALID' };
  try {
    return await h.db.$transaction((tx) =>
      readInTransaction({ ...h, db: tx as ScopedDb }, input.data, binding)
    );
  } catch (error) {
    return {
      status:
        error instanceof GrowthReviewError && error.code === 'DENIED' ? 'DENIED' : 'UNAVAILABLE',
    };
  }
}
export async function reviewRestaurantGrowth(
  h: GrowthActor,
  raw: unknown,
  binding: RestaurantGrowthBinding | null = null
) {
  const parsed = growthReviewInput.safeParse(raw);
  if (!parsed.success) throw new GrowthReviewError('INVALID');
  const input = parsed.data;
  return h.db.$transaction(async (tx) => {
    const actor = { ...h, db: tx as ScopedDb };
    await authorizeRestaurantGrowth(actor, input.branchId, true);
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_branch_id',$1,true)`, input.branchId);
    // All writers serialize on the same scoped insight; immutable source is never updated.
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text,0))`,
      h.ctx.organizationId,
      input.branchId,
      input.insightId
    );
    const view = await readInTransaction(actor, input, binding);
    if (view.status !== 'READY')
      throw new GrowthReviewError(view.status === 'STALE' ? 'STALE' : 'UNAVAILABLE');
    if (view.hash !== input.expectedHash || view.version !== input.expectedVersion)
      throw new GrowthReviewError('STALE');
    const rec = view.projection.recommendations[input.recommendation];
    if (!rec || RESTAURANT_GROWTH_ACTIONS[rec.action].objective !== input.settings.objective)
      throw new GrowthReviewError('INVALID');
    const fingerprint = JSON.stringify({ actorId: h.ctx.userId, input });
    const replay = await tx.$queryRawUnsafe<
      Array<{ fingerprint: string; draftId: string | null; id: string }>
    >(
      `SELECT fingerprint,"draftId",id FROM restaurant_growth_reviews WHERE "organizationId"=$1 AND "branchId"=$2 AND "insightId"=$3 AND "requestId"=$4 LIMIT 1`,
      h.ctx.organizationId,
      input.branchId,
      input.insightId,
      input.requestId
    );
    if (replay.length) {
      if (replay[0].fingerprint !== fingerprint) throw new GrowthReviewError('CONFLICT');
      return { reviewId: replay[0].id, draftId: replay[0].draftId };
    }
    const previous = view.reviews.find((r) => r.recommendation === input.recommendation);
    if (
      (previous?.revision ?? 0) !== input.expectedRevision ||
      (previous && previous.decision !== 'EDIT')
    )
      throw new GrowthReviewError('CONFLICT');
    await authorizeRestaurantGrowth(actor, input.branchId, true);
    const reviewId = randomUUID();
    const draftId = input.decision === 'APPROVE' ? randomUUID() : null;
    await tx.$executeRawUnsafe(
      `INSERT INTO restaurant_growth_reviews (id,"organizationId","branchId","insightId",recommendation,revision,decision,"actorId",settings,"draftId","requestId",fingerprint,"inputHash","schemaVersion") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,1)`,
      reviewId,
      h.ctx.organizationId,
      input.branchId,
      input.insightId,
      input.recommendation,
      input.expectedRevision + 1,
      input.decision,
      h.ctx.userId,
      JSON.stringify(input.settings),
      draftId,
      input.requestId,
      fingerprint,
      input.expectedHash
    );
    if (draftId)
      await tx.$executeRawUnsafe(
        `INSERT INTO restaurant_growth_drafts (id,"organizationId","branchId","insightId",recommendation,"reviewId",action,settings,"actorId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        draftId,
        h.ctx.organizationId,
        input.branchId,
        input.insightId,
        input.recommendation,
        reviewId,
        rec.action,
        JSON.stringify(input.settings),
        h.ctx.userId
      );
    return { reviewId, draftId };
  });
}
