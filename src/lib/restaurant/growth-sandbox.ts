import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { appendCustomerConsent } from './customers';
import {
  authorizeRestaurantGrowth,
  GrowthReviewError,
  readRestaurantGrowthReview,
  type GrowthActor,
  type RestaurantGrowthBinding,
} from './growth-review';

const admissionSchema = z
  .object({
    environment: z.literal('TEST_SANDBOX'),
    database: z.string().regex(/^restaurant_growth_test_[a-z0-9_]+$/),
    port: z.number().int().min(1024).max(65535),
    policyVersion: z.string().min(1).max(80),
    timeZone: z.string().min(1).max(80),
    quietStart: z.number().int().min(0).max(23),
    quietEnd: z.number().int().min(0).max(23),
    campaignCap: z.number().int().min(1).max(50),
    recipientBranchDailyCap: z.number().int().min(1).max(3),
  })
  .strict();
export type GrowthSandboxAdmission = z.infer<typeof admissionSchema>;
const requestSchema = z
  .object({
    branchId: z.string().min(1).max(200),
    draftId: z.string().min(1).max(200),
    requestId: z.uuid(),
    cutoff: z.iso.datetime(),
  })
  .strict();
const attemptSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  fingerprint: z.string(),
  state: z.enum(['CAPTURED', 'UNKNOWN']),
});

const GROWTH_OPT_OUT_CONFIRMATION =
  'You will no longer receive WhatsApp growth messages. Reply START to opt back in.\n' +
  'آپ کو اب واٹس ایپ پر گروتھ پیغامات نہیں ملیں گے۔ دوبارہ شروع کرنے کے لیے START لکھیں۔';

function isGrowthStop(text: string) {
  const normalized = text.normalize('NFKC').trim().toLowerCase();
  return normalized === 'stop' || normalized === 'بند';
}
async function admit(db: ScopedDb, raw: GrowthSandboxAdmission) {
  const admission = admissionSchema.parse(raw);
  const rows = await db.$queryRawUnsafe<
    Array<{
      database: string;
      address: string;
      port: number;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>
  >(
    `SELECT current_database() AS database,host(inet_server_addr()) AS address,inet_server_port() AS port,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`
  );
  const server = rows[0];
  if (
    !server ||
    server.database !== admission.database ||
    server.port !== admission.port ||
    !['127.0.0.1', '::1'].includes(server.address) ||
    server.rolsuper ||
    server.rolbypassrls
  )
    throw new GrowthReviewError('DENIED');
  // The installed Prisma PG adapter expects UTC for Date arguments and timestamptz decoding.
  await db.$queryRawUnsafe("SELECT set_config('TimeZone','UTC',true)");
  return admission;
}
export function growthSandboxQuiet(now: Date, policy: GrowthSandboxAdmission) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: policy.timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now)
  );
  return (
    policy.quietStart === policy.quietEnd ||
    (policy.quietStart < policy.quietEnd
      ? hour >= policy.quietStart && hour < policy.quietEnd
      : hour >= policy.quietStart || hour < policy.quietEnd)
  );
}
async function lockScope(h: GrowthActor, branchId: string) {
  await authorizeRestaurantGrowth(h, branchId, true);
  if (!(await h.can('customers:manage'))) throw new GrowthReviewError('DENIED');
  await h.db.$queryRawUnsafe(`SELECT set_config('app.current_branch_id',$1,true)`, branchId);
  // Organization lock serializes sandbox capture and STOP.
  await h.db.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
    'restaurant-growth-sandbox:' + h.ctx.organizationId
  );
}
/** Internal only. No router, provider or live sender. Fixture registry is server owned. */
export async function captureRestaurantGrowthDraft(
  h: GrowthActor,
  raw: unknown,
  admission: GrowthSandboxAdmission,
  binding: RestaurantGrowthBinding
) {
  const input = requestSchema.parse(raw);
  return h.db.$transaction(async (tx) => {
    const actor = { ...h, db: tx as ScopedDb };
    const policy = await admit(actor.db, admission);
    await lockScope(actor, input.branchId);
    const nowRows = await tx.$queryRawUnsafe<Array<{ now: Date }>>(
      'SELECT clock_timestamp() AS now'
    );
    const now = new Date(nowRows[0].now);
    if (
      Date.parse(input.cutoff) > now.getTime() ||
      now.getTime() - Date.parse(input.cutoff) > 86400000
    )
      throw new GrowthReviewError('INVALID');
    const drafts = await tx.$queryRawUnsafe<
      Array<{ insightId: string; recommendation: number; reviewId: string; action: string }>
    >(
      `SELECT "insightId",recommendation,"reviewId",action FROM restaurant_growth_drafts WHERE "organizationId"=$1 AND "branchId"=$2 AND id=$3 AND status='DRAFT'`,
      h.ctx.organizationId,
      input.branchId,
      input.draftId
    );
    const draft = drafts[0];
    if (!draft || draft.action !== 'LOYALTY_REVIEW') throw new GrowthReviewError('DENIED');
    // Same real current-evidence gate as review. TEST_DOUBLE binding belongs only in tests.
    const view = await readRestaurantGrowthReview(
      actor,
      { branchId: input.branchId, insightId: draft.insightId },
      binding
    );
    if (
      view.status !== 'READY' ||
      !view.reviews.some(
        (r) =>
          r.recommendation === draft.recommendation &&
          r.decision === 'APPROVE' &&
          r.draftId === input.draftId
      )
    )
      throw new GrowthReviewError('STALE');
    const fingerprint = JSON.stringify({
      actorId: h.ctx.userId,
      input,
      policy,
      reviewId: draft.reviewId,
    });
    const previous = z
      .array(attemptSchema)
      .max(50)
      .parse(
        await tx.$queryRawUnsafe(
          `SELECT id,"customerId",fingerprint,state FROM restaurant_growth_attempts WHERE "organizationId"=$1 AND "branchId"=$2 AND "draftId"=$3 ORDER BY id LIMIT 51`,
          h.ctx.organizationId,
          input.branchId,
          input.draftId
        )
      );
    if (previous.length) {
      if (previous.some((row) => row.fingerprint !== fingerprint))
        throw new GrowthReviewError('CONFLICT');
      return {
        environment: 'TEST_SANDBOX' as const,
        attemptIds: previous.map((row) => row.id),
        replayed: true,
      };
    }
    if (growthSandboxQuiet(now, policy))
      return {
        environment: 'TEST_SANDBOX' as const,
        attemptIds: [],
        reason: 'QUIET_HOURS' as const,
      };
    const fixtures = await tx.$queryRawUnsafe<Array<{ customerId: string }>>(
      `SELECT f."customerId" FROM restaurant_growth_fixtures f JOIN restaurant_customers c ON c.id=f."customerId" AND c."organizationId"=f."organizationId" JOIN restaurant_loyalty_accounts l ON l."customerId"=c.id AND l."organizationId"=c."organizationId" WHERE f."organizationId"=$1 AND f."branchId"=$2 AND c."anonymizedAt" IS NULL AND l.active=true ORDER BY f."customerId" LIMIT 51`,
      h.ctx.organizationId,
      input.branchId
    );
    if (fixtures.length > 50) throw new GrowthReviewError('UNAVAILABLE');
    const attempts: string[] = [];
    for (const fixture of fixtures) {
      if (attempts.length >= policy.campaignCap) break;
      const customerId = fixture.customerId;
      // Re-read current permission immediately before insertion; no cached audience.
      // This internal sandbox serializes STOP and capture using the same organization lock.
      const eligible = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT c.id FROM restaurant_customers c JOIN restaurant_loyalty_accounts l ON l."organizationId"=c."organizationId" AND l."customerId"=c.id WHERE c."organizationId"=$1 AND c.id=$2 AND c."anonymizedAt" IS NULL AND l.active=true FOR UPDATE OF c,l`,
        h.ctx.organizationId,
        customerId
      );
      if (eligible.length !== 1) continue;
      const currentClock = await tx.$queryRawUnsafe<Array<{ now: Date }>>(
        'SELECT clock_timestamp() AS now'
      );
      const permissionAt = new Date(currentClock[0].now);
      if (growthSandboxQuiet(permissionAt, policy)) break;
      const consent = await tx.customerConsent.findFirst({
        where: {
          organizationId: h.ctx.organizationId,
          customerId,
          channel: 'WHATSAPP',
          occurredAt: { lte: permissionAt },
        },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { granted: true },
      });
      if (!consent?.granted) continue;
      const counts = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM restaurant_growth_attempts WHERE "organizationId"=$1 AND "customerId"=$2 AND "createdAt">=$3 AND "branchId"=$4`,
        h.ctx.organizationId,
        customerId,
        new Date(now.getTime() - 86400000),
        input.branchId
      );
      if (counts[0].count >= policy.recipientBranchDailyCap) continue;
      const id = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO restaurant_growth_attempts (id,"organizationId","branchId","draftId","reviewId","customerId","requestId",fingerprint,cutoff,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CAPTURED')`,
        id,
        h.ctx.organizationId,
        input.branchId,
        input.draftId,
        draft.reviewId,
        customerId,
        input.requestId,
        fingerprint,
        new Date(input.cutoff)
      );
      attempts.push(id);
    }
    return { environment: 'TEST_SANDBOX' as const, attemptIds: attempts, replayed: false };
  });
}
export async function stopRestaurantGrowthSandbox(
  h: GrowthActor,
  raw: unknown,
  admission: GrowthSandboxAdmission
) {
  const input = z
    .object({
      branchId: z.string().min(1).max(200),
      customerId: z.string().min(1).max(200),
      eventId: z.uuid(),
      text: z.string().max(20),
    })
    .strict()
    .parse(raw);
  if (!isGrowthStop(input.text)) throw new GrowthReviewError('INVALID');
  return h.db.$transaction(async (tx) => {
    const actor = { ...h, db: tx as ScopedDb };
    const policy = await admit(actor.db, admission);
    await lockScope(actor, input.branchId);
    const fixtures = await tx.$queryRawUnsafe<unknown[]>(
      `SELECT "customerId" FROM restaurant_growth_fixtures WHERE "organizationId"=$1 AND "branchId"=$2 AND "customerId"=$3`,
      h.ctx.organizationId,
      input.branchId,
      input.customerId
    );
    if (fixtures.length !== 1) throw new GrowthReviewError('DENIED');
    await tx.$queryRawUnsafe(
      `SELECT id FROM restaurant_customers WHERE "organizationId"=$1 AND id=$2 FOR UPDATE`,
      h.ctx.organizationId,
      input.customerId
    );
    const consent = await appendCustomerConsent(actor.db, {
      customerId: input.customerId,
      channel: 'WHATSAPP',
      granted: false,
      source: 'TEST_SANDBOX_STOP',
      actorId: h.ctx.userId,
      policyVersion: policy.policyVersion,
      idempotencyKey: 'restaurant-growth-stop:' + input.eventId,
    });
    return { ...consent, confirmation: GROWTH_OPT_OUT_CONFIRMATION };
  });
}
/** Bounded, internal operational receipt diagnostic. No attribution write or money guess. */
export async function diagnoseRestaurantGrowthSandbox(
  h: GrowthActor,
  raw: unknown,
  admission: GrowthSandboxAdmission
) {
  const input = z
    .object({ branchId: z.string().min(1).max(200), attemptId: z.uuid(), cutoff: z.iso.datetime() })
    .strict()
    .parse(raw);
  return h.db.$transaction(async (tx) => {
    const actor = { ...h, db: tx as ScopedDb };
    await admit(actor.db, admission);
    await lockScope(actor, input.branchId);
    const receipts = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT b.id FROM restaurant_growth_attempts a JOIN restaurant_growth_receipt_events e ON e."attemptId"=a.id AND e."organizationId"=a."organizationId" AND e."branchId"=a."branchId" AND e."customerId"=a."customerId" JOIN restaurant_bills b ON b.id=e."billId" AND b."organizationId"=a."organizationId" AND b."branchId"=a."branchId" JOIN restaurant_orders o ON o.id=b."orderId" AND o."organizationId"=a."organizationId" AND o."branchId"=a."branchId" AND o."customerId"=a."customerId" WHERE a."organizationId"=$1 AND a."branchId"=$2 AND a.id=$3 AND a.state='CAPTURED' AND e."createdAt"<=$4 AND b.status='SETTLED' AND b."receiptNumber" IS NOT NULL AND b."settledAt">=a."createdAt" AND b."settledAt"<=$4 AND $4>=a.cutoff AND $4<=clock_timestamp() ORDER BY b.id LIMIT 101`,
      h.ctx.organizationId,
      input.branchId,
      input.attemptId,
      new Date(input.cutoff)
    );
    if (receipts.length > 100) throw new GrowthReviewError('UNAVAILABLE');
    return {
      environment: 'TEST_SANDBOX' as const,
      observational: true,
      cutoff: input.cutoff,
      evidenceReceiptIds: receipts.map((row) => row.id),
      messageCost: null,
      postedMarginMinor: null,
      settledSalesMinor: null,
      limitation:
        'Operational numbered settled receipts only. Per-receipt posted Finance/refund reconciliation unavailable; money and margin withheld.',
    };
  });
}
