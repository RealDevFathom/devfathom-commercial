import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generateGrowthRecommendations, type GrowthResult } from '@/lib/ai/growth-recommendations';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { restaurantGrowthEvidenceInput } from './growth-evidence';
import { restaurantComparisonWindows } from './financial-comparison';
import { lockRestaurantGrowthSource, readRestaurantGrowthSource } from './growth-source';
import { authorizeRestaurantGrowth, GrowthReviewError, type GrowthActor } from './growth-review';
export const growthGenerateInput = restaurantGrowthEvidenceInput
  .extend({ requestId: z.uuid() })
  .strict();
export const growthListInput = z.object({ branchId: z.string().min(1).max(200) }).strict();
const summary = z.object({
  id: z.string(),
  status: z.enum(['READY', 'UNAVAILABLE', 'INVALID', 'INSUFFICIENT_DATA']),
  createdAt: z.coerce.date(),
});
export type GrowthList =
  | {
      status: 'AVAILABLE';
      items: Array<{ id: string; status: string; createdAt: string }>;
      truncated: boolean;
    }
  | { status: 'DENIED' | 'UNAVAILABLE' };
export async function listRestaurantGrowth(h: GrowthActor, raw: unknown): Promise<GrowthList> {
  const input = growthListInput.parse(raw);
  try {
    return await h.db.$transaction(async (tx) => {
      await authorizeRestaurantGrowth({ ...h, db: tx as ScopedDb }, input.branchId, false);
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_branch_id',$1,true)`,
        input.branchId
      );
      const rows = z
        .array(summary)
        .max(21)
        .parse(
          await tx.$queryRawUnsafe(
            `SELECT id,status,"createdAt" FROM growth_insights WHERE "organizationId"=$1 AND "branchId"=$2 AND vertical='RESTAURANT' ORDER BY "createdAt" DESC,id DESC LIMIT 21`,
            h.ctx.organizationId,
            input.branchId
          )
        );
      return {
        status: 'AVAILABLE' as const,
        items: rows.slice(0, 20).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        truncated: rows.length > 20,
      };
    });
  } catch (error) {
    return {
      status:
        error instanceof GrowthReviewError && error.code === 'DENIED' ? 'DENIED' : 'UNAVAILABLE',
    };
  }
}
/** Clients supply only dates/branch/request ID; shared generator owns model selection/validation. */
export async function generateRestaurantGrowth(h: GrowthActor, raw: unknown) {
  const input = growthGenerateInput.parse(raw);
  const request = { branchId: input.branchId, from: input.from, to: input.to };
  restaurantComparisonWindows({ ...request, branchIds: [request.branchId] });
  const fingerprint = JSON.stringify({ actorId: h.ctx.userId, input });
  const id =
    'restaurant-growth-' +
    createHash('sha256')
      .update(JSON.stringify([h.ctx.organizationId, input.branchId, h.ctx.userId, input.requestId]))
      .digest('hex');
  return h.db.$transaction(async (tx) => {
    const actor = { ...h, db: tx as ScopedDb };
    await authorizeRestaurantGrowth(actor, input.branchId, true);
    if (!(await h.can('catering:read'))) throw new GrowthReviewError('DENIED');
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_branch_id',$1,true)`, input.branchId);
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, id);
    const previous = await tx.$queryRawUnsafe<
      Array<{
        snapshot: { fingerprint?: string; _restaurant?: { fingerprint: string } };
        status: string;
      }>
    >(
      `SELECT snapshot,status FROM growth_insights WHERE "organizationId"=$1 AND "branchId"=$2 AND id=$3 AND vertical='RESTAURANT'`,
      h.ctx.organizationId,
      input.branchId,
      id
    );
    if (previous.length) {
      const saved = previous[0].snapshot;
      if ((saved._restaurant?.fingerprint ?? saved.fingerprint) !== fingerprint)
        throw new GrowthReviewError('CONFLICT');
      return { insightId: id, status: previous[0].status };
    }
    let source: Awaited<ReturnType<typeof readRestaurantGrowthSource>> | null = null;
    let failureReason: string | null = null;
    try {
      source = await readRestaurantGrowthSource(actor, request);
    } catch (error) {
      if (error instanceof GrowthReviewError) throw error;
      failureReason = 'SOURCE_UNAVAILABLE';
    }
    let result: GrowthResult | null = source
      ? await generateGrowthRecommendations(source.input)
      : null;
    if (result?.status === 'READY') {
      await lockRestaurantGrowthSource(actor, request);
      let current: typeof source = null;
      try {
        current = await readRestaurantGrowthSource(actor, request);
      } catch (error) {
        if (error instanceof GrowthReviewError) throw error;
      }
      if (current?.sourceHash !== source!.sourceHash) {
        result = { ...result, status: 'UNAVAILABLE', failureCode: 'SPARSE', output: null };
        failureReason = 'SOURCE_CHANGED_DURING_GENERATION';
      }
    }
    await authorizeRestaurantGrowth(actor, input.branchId, true);
    if (!(await h.can('catering:read'))) throw new GrowthReviewError('DENIED');
    const snapshot = {
      ...(result?.input ?? {}),
      _restaurant: {
        version: 'restaurant-growth-v2',
        fingerprint,
        provenance: source?.provenance ?? null,
        sourceHash: source?.sourceHash ?? null,
        failureReason:
          failureReason ??
          (result?.status === 'INSUFFICIENT_DATA'
            ? 'NO_QUALIFYING_CATERING_PERIOD'
            : (result?.failureCode ?? null)),
      },
    };
    const status = result?.status ?? 'UNAVAILABLE';
    const hash = result?.inputHash ?? createHash('sha256').update('null').digest('hex');
    await tx.$executeRawUnsafe(
      `INSERT INTO growth_insights (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,"failureCode",provider,model,snapshot,output) VALUES ($1,$2,$3,'RESTAURANT',$4,1,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
      id,
      h.ctx.organizationId,
      input.branchId,
      h.ctx.userId,
      hash,
      status,
      result ? result.failureCode : 'SPARSE',
      result?.provider ?? null,
      result?.model ?? null,
      JSON.stringify(snapshot),
      result?.output ? JSON.stringify(result.output) : null
    );
    return { insightId: id, status };
  });
}
