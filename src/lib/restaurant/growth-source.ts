import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prepareGrowthInput, type GrowthInput } from '@/lib/ai/growth-recommendations';
import { restaurantComparisonWindows } from './financial-comparison';
import { restaurantGrowthEvidenceInput } from './growth-evidence';
import { authorizeRestaurantGrowth, GrowthReviewError, type GrowthActor } from './growth-review';

const stamp = z
  .string()
  .regex(/^\d+(?:\.\d{1,6})?$/)
  .refine((value) => Number.isFinite(new Date(Number(value) * 1000).getTime()));
const id = z.string().min(1);
const booking = z
  .object({
    id,
    customerId: id.nullable(),
    customer: id.nullable(),
    anonymized: z.boolean(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    revision: z.number().int().nonnegative(),
    updated: stamp,
    customerUpdated: stamp.nullable(),
    quoteId: id.nullable(),
    approvedId: id.nullable(),
    quoteRevision: z.number().int().nullable(),
    quoteHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    quoteCreated: stamp.nullable(),
    approvalId: id.nullable(),
    approvalRevision: z.number().int().nullable(),
    approvalCreated: stamp.nullable(),
    eventId: id.nullable(),
    sequence: z.number().int().nullable(),
    eventCreated: stamp.nullable(),
    transitionId: id.nullable(),
    transitionTo: z.string().nullable(),
    transitionCreated: stamp.nullable(),
  })
  .strict();
const sourceSchema = z
  .object({
    currency: z.enum(['USD', 'PKR']),
    periods: z
      .array(
        z
          .object({
            period: z.enum(['CURRENT', 'COMPARISON']),
            bookings: z.array(booking).max(201),
          })
          .strict()
      )
      .length(2),
  })
  .strict();
export const growthProvenanceSchema = z
  .object({
    policy: z.literal('restaurant-catering-confirmed-v1'),
    scope: z.object({ organizationId: id, branchId: id }).strict(),
    request: restaurantGrowthEvidenceInput,
    periodBasis: z.literal('CATERING_EVENT_DATE_CURRENT_STATUS'),
    currencyBasis: z.literal('CURRENT_ORGANIZATION_COUNT_ONLY'),
    source: sourceSchema,
  })
  .strict();
export type GrowthProvenance = z.infer<typeof growthProvenanceSchema>;

// JSONB changes object key order. Array order is deliberate source membership order.
export function growthSourceHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, v]) => [key, canonical(v)])
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function cateringGrowthInput(provenance: GrowthProvenance): GrowthInput {
  const p = growthProvenanceSchema.parse(provenance);
  const windows = restaurantComparisonWindows({ ...p.request, branchIds: [p.request.branchId] });
  if (
    p.request.branchId !== p.scope.branchId ||
    p.source.periods[0].period !== 'CURRENT' ||
    p.source.periods[1].period !== 'COMPARISON'
  )
    throw new Error('Invalid source scope');
  const period = (range: { from: string; to: string }) => ({
    from: range.from + 'T00:00:00.000Z',
    cutoff: new Date(Date.parse(range.to + 'T00:00:00.000Z') + 86400000).toISOString(),
  });
  const current = period(windows.current),
    comparison = period(windows.previous);
  const facts: GrowthInput['facts'] = [];
  for (const [index, entry] of p.source.periods.entries()) {
    const rows = entry.bookings,
      range = index === 0 ? current : comparison;
    const customers = new Set(rows.map((row) => row.customer));
    if (
      !rows.length ||
      rows.length > 200 ||
      customers.size < 10 ||
      new Set(rows.map((row) => row.id)).size !== rows.length ||
      rows.some(
        (row) =>
          !row.customer ||
          row.customer !== row.customerId ||
          row.anonymized ||
          !row.customerUpdated ||
          row.date < range.from.slice(0, 10) ||
          row.date >= range.cutoff.slice(0, 10) ||
          !row.quoteId ||
          row.quoteId !== row.approvedId ||
          row.quoteRevision !== row.revision ||
          !row.quoteHash ||
          !row.quoteCreated ||
          !row.approvalId ||
          row.approvalRevision !== row.revision ||
          !row.approvalCreated ||
          !row.eventId ||
          !row.sequence ||
          !row.eventCreated ||
          !row.transitionId ||
          row.transitionTo !== 'CONFIRMED' ||
          !row.transitionCreated
      )
    )
      continue;
    const watermark = Math.max(
      ...rows.flatMap((row) =>
        [
          row.updated,
          row.customerUpdated!,
          row.quoteCreated!,
          row.approvalCreated!,
          row.eventCreated!,
          row.transitionCreated!,
        ].map(Number)
      )
    );
    facts.push({
      ref: index === 0 ? 'e1' : 'e2',
      metric: 'catering_confirmed_count',
      value: String(rows.length),
      period: entry.period,
      cohortSize: customers.size,
      coverage: 'COMPLETE',
      freshAt: new Date(watermark * 1000).toISOString(),
    });
  }
  return prepareGrowthInput({
    vertical: 'RESTAURANT',
    currency: p.source.currency,
    current,
    comparison,
    facts,
    actions: facts.length ? [{ ref: 'a1', kind: 'CATERING_REVIEW' }] : [],
  });
}

/** One SQL snapshot; no customer names, contacts, quote prose or payloads are selected. */
export async function readRestaurantGrowthSource(h: GrowthActor, raw: unknown) {
  const request = restaurantGrowthEvidenceInput.parse(raw);
  const windows = restaurantComparisonWindows({ ...request, branchIds: [request.branchId] });
  await authorizeRestaurantGrowth(h, request.branchId, false);
  if (!(await h.can('catering:read'))) throw new GrowthReviewError('DENIED');
  const result = await h.db.$queryRawUnsafe<Array<{ source: unknown }>>(
    `
    WITH periods(label,first,last) AS (VALUES ('CURRENT',$3::date,$4::date),('COMPARISON',$5::date,$6::date))
    SELECT jsonb_build_object('currency',org.currency,
      'periods',(SELECT jsonb_agg(jsonb_build_object('period',p.label,'bookings',(
        SELECT COALESCE(jsonb_agg(row.value ORDER BY row.id),'[]'::jsonb) FROM (
          SELECT o.id, jsonb_build_object(
            'id',o.id,'customerId',o."customerId",'customer',c.id,'anonymized',c."anonymizedAt" IS NOT NULL,
            'date',o."eventDate"::text,'revision',o.revision,'updated',extract(epoch from o."updatedAt")::text,
            'customerUpdated',extract(epoch from c."updatedAt")::text,
            'quoteId',q.id,'approvedId',o."approvedQuoteRevisionId",'quoteRevision',q.revision,'quoteHash',q."contentHash",'quoteCreated',extract(epoch from q."createdAt")::text,
            'approvalId',a.id,'approvalRevision',a."orderRevision",'approvalCreated',extract(epoch from a."createdAt")::text,
            'eventId',e.id,'sequence',e.sequence,'eventCreated',extract(epoch from e."createdAt")::text,
            'transitionId',t.id,'transitionTo',t.payload->>'to','transitionCreated',extract(epoch from t."createdAt")::text

          ) AS value
          FROM restaurant_catering_orders o
          LEFT JOIN restaurant_customers c ON c."organizationId"=$1 AND c.id=o."customerId"
          LEFT JOIN restaurant_catering_quote_revisions q ON q."organizationId"=$1 AND q."orderId"=o.id AND q.id=o."confirmedQuoteRevisionId"
          LEFT JOIN restaurant_catering_quote_approvals a ON a."organizationId"=$1 AND a."orderId"=o.id AND a."quoteRevisionId"=q.id
          LEFT JOIN LATERAL (SELECT id,sequence,"createdAt" FROM restaurant_catering_events WHERE "organizationId"=$1 AND "orderId"=o.id ORDER BY sequence DESC LIMIT 1) e ON true
          LEFT JOIN LATERAL (SELECT id,payload,"createdAt" FROM restaurant_catering_events WHERE "organizationId"=$1 AND "orderId"=o.id AND "eventType"='STATUS_TRANSITIONED' ORDER BY sequence DESC LIMIT 1) t ON true
          WHERE o."organizationId"=$1 AND o."branchId"=$2 AND o.status='CONFIRMED' AND o."eventDate" BETWEEN p.first AND p.last
          ORDER BY o.id LIMIT 201
        ) row)) ORDER BY p.first DESC) FROM periods p)
    ) AS source FROM organizations org WHERE org.id=$1 AND org.vertical='RESTAURANT'`,
    h.ctx.organizationId,
    request.branchId,
    windows.current.from,
    windows.current.to,
    windows.previous.from,
    windows.previous.to
  );
  if (result.length !== 1) throw new Error('Missing Restaurant source');
  const provenance = growthProvenanceSchema.parse({
    policy: 'restaurant-catering-confirmed-v1',
    scope: { organizationId: h.ctx.organizationId, branchId: request.branchId },
    request,
    periodBasis: 'CATERING_EVENT_DATE_CURRENT_STATUS',
    currencyBasis: 'CURRENT_ORGANIZATION_COUNT_ONLY',
    source: result[0].source,
  });
  return {
    provenance,
    sourceHash: growthSourceHash(provenance),
    input: cateringGrowthInput(provenance),
  };
}

/** Must run inside the review transaction. Matches catering transitions and customer privacy/consent writers. */
export async function lockRestaurantGrowthSource(
  h: GrowthActor,
  request: z.infer<typeof restaurantGrowthEvidenceInput>
) {
  await h.db.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    `catering:branch:${h.ctx.organizationId}:${request.branchId}`
  );
  const windows = restaurantComparisonWindows({ ...request, branchIds: [request.branchId] });
  const orders = await h.db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM restaurant_catering_orders WHERE "organizationId"=$1 AND "branchId"=$2 AND status='CONFIRMED' AND "eventDate" BETWEEN $3::date AND $4::date ORDER BY id`,
    h.ctx.organizationId,
    request.branchId,
    windows.previous.from,
    windows.current.to
  );
  // Delivery edits append hashed events under the order lock without taking the branch lock.
  for (const order of orders)
    await h.db.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', order.id);
  await h.db.$queryRawUnsafe(
    `SELECT c.id FROM restaurant_customers c WHERE c."organizationId"=$1 AND EXISTS (
    SELECT 1 FROM restaurant_catering_orders o WHERE o."organizationId"=$1 AND o."branchId"=$2 AND o.status='CONFIRMED' AND o."customerId"=c.id AND o."eventDate" BETWEEN $3::date AND $4::date
  ) ORDER BY c.id FOR UPDATE`,
    h.ctx.organizationId,
    request.branchId,
    windows.previous.from,
    windows.current.to
  );
}
