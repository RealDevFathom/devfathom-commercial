import 'server-only';

import { createHash } from 'node:crypto';
import { Prisma, type PharmacyCampaignDeliveryEvent } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockCustomerConsent } from './consent-writer';
import { whatsappMarketingPause } from './whatsapp/account-quality';
import {
  marketingConsent,
  requireCaptureWindow,
  reviewMarketingCampaign,
  MarketingWorkflowError,
  type MarketingScope,
} from './marketing-service';
import { z } from 'zod';

export const sandboxDispatchInput = z
  .object({
    branchId: z.string().min(1).max(128),
    campaignId: z.string().min(1).max(128),
    requestKey: z.string().min(1).max(128),
    retry: z.boolean().default(false),
    outcome: z.enum(['DELIVERED', 'REJECTED', 'TIMEOUT', 'FAULT']).default('DELIVERED'),
  })
  .strict();
export type DeliveryEvidence = Pick<PharmacyCampaignDeliveryEvent, 'state' | 'reason'>;
export function reconcileDelivery(events: DeliveryEvidence[]) {
  const accepted = events.some((e) => e.state === 'PROVIDER_ACCEPTED');
  const delivered = events.some((e) => e.state === 'DELIVERED');
  const failed = events.some((e) => e.state === 'FAILED');
  const unknown = events.some((e) => e.state === 'UNKNOWN');
  const suppressed = events.some((e) => e.state === 'SUPPRESSED');
  const rejected = events.some((e) => e.state === 'FAILED' && e.reason === 'DEFINITE_REJECTION');
  const contradictory = (delivered && failed) || (rejected && accepted);
  return {
    accepted,
    delivered,
    failed,
    suppressed,
    contradictory,
    unknown: contradictory || unknown || (!delivered && !failed && !suppressed),
    retryable: rejected && !accepted && !delivered && !unknown && !suppressed && !contradictory,
  };
}
/** Rejections in an earlier retry are not contradictions in a later attempt. */
export function reconcileCapture(attempts: Array<{ events: DeliveryEvidence[] }>) {
  const states = attempts.map((a) => reconcileDelivery(a.events));
  const contradictory = states.some((s) => s.contradictory);
  const delivered = states.some((s) => s.delivered);
  return {
    accepted: states.some((s) => s.accepted),
    delivered,
    failed: states.some((s) => s.failed),
    suppressed: states.some((s) => s.suppressed),
    contradictory,
    unknown: contradictory || (!delivered && (!states.length || states.some((s) => s.unknown))),
  };
}
export type MarketingTransaction = <T>(
  run: (db: ScopedDb, scope: MarketingScope) => Promise<T>
) => Promise<T>;

export const dueSandboxInput = z
  .object({
    branchId: z.string().min(1).max(128),
    requestKey: z.string().min(1).max(128),
    campaignIds: z.array(z.string().min(1).max(128)).min(1).max(5),
    outcome: z.enum(['DELIVERED', 'REJECTED', 'TIMEOUT', 'FAULT']).default('DELIVERED'),
  })
  .strict();

/** Operator-invoked bounded batch; capture, consent and per-attempt rules stay authoritative. */
export async function dispatchDueSandboxCampaigns(
  transaction: MarketingTransaction,
  raw: z.input<typeof dueSandboxInput>,
  now = new Date()
) {
  const input = dueSandboxInput.parse(raw);
  const due = await transaction((db, scope) =>
    db.pharmacyCampaign.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        id: { in: input.campaignIds },
        status: 'CAPTURED',
        ownerApprovedAt: { not: null },
        scheduledAt: { lte: now },
      },
      select: { id: true },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 5,
    })
  );
  if (
    new Set(input.campaignIds).size !== input.campaignIds.length ||
    due.length !== input.campaignIds.length
  )
    throw new MarketingWorkflowError(
      'Choose up to five due, approved, captured campaigns in this branch.'
    );
  const results = [];
  for (const campaign of due.slice(0, 5)) {
    results.push({
      campaignId: campaign.id,
      result: await dispatchSandboxCampaign(
        transaction,
        {
          branchId: input.branchId,
          campaignId: campaign.id,
          requestKey: eventKey('due-batch', input.requestKey, campaign.id),
          outcome: input.outcome,
          retry: false,
        },
        now
      ),
    });
  }
  return { simulated: true as const, hasMore: due.length > 5, results };
}
const eventKey = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Must commit before invoking any adapter. Replays never reacquire an execution lease. */
export async function reserveSandboxAttempt(
  db: ScopedDb,
  scope: MarketingScope,
  captureId: string,
  input: z.infer<typeof sandboxDispatchInput>,
  now: Date
) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_campaign_captures
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
    AND id = ${captureId} FOR UPDATE`);
  const capture = await db.pharmacyCampaignCapture.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      campaignId: input.campaignId,
      id: captureId,
      channel: 'WHATSAPP',
    },
  });
  if (!capture) throw new MarketingWorkflowError('Capture unavailable in this branch.');
  const prior = await db.pharmacyCampaignDispatchAttempt.findMany({
    where: { organizationId: scope.organizationId, captureId },
    include: { events: true },
    orderBy: { attemptNumber: 'desc' },
  });
  const replay = prior.find((a) => a.requestKey === input.requestKey);
  if (replay) return { attempt: replay, execute: false };
  if (
    prior.length &&
    (!input.retry ||
      !reconcileDelivery(prior[0].events).retryable ||
      prior.some((a) =>
        a.events.some((e) => ['PROVIDER_ACCEPTED', 'DELIVERED', 'UNKNOWN'].includes(e.state))
      ))
  )
    return { attempt: prior[0], execute: false };
  if (!prior.length && input.retry)
    throw new MarketingWorkflowError('Only a confirmed rejection can be retried.');
  await lockCustomerConsent(db, scope.organizationId, capture.customerId);
  const { campaign, frequencyCap } = await reviewMarketingCampaign(db, scope, capture.campaignId);
  if (campaign.status !== 'CAPTURED')
    throw new MarketingWorkflowError('Capture the approved campaign first.');
  let reason: string | null = await marketingConsent(db, scope, capture.customerId, now);
  try {
    requireCaptureWindow(campaign, scope, now);
  } catch (error) {
    if (!(error instanceof MarketingWorkflowError)) throw error;
    reason = 'WINDOW_CLOSED';
  }
  // Current capture consumes one place; count other captures across campaigns/branches.
  const others = await db.pharmacyCampaignCapture.count({
    where: {
      organizationId: scope.organizationId,
      customerId: capture.customerId,
      channel: 'WHATSAPP',
      id: { not: capture.id },
      capturedAt: { gte: new Date(now.getTime() - frequencyCap.windowDays * 86400000), lte: now },
    },
  });
  if (others >= frequencyCap.max) reason = 'FREQUENCY_CAP';
  const attempt = await db.pharmacyCampaignDispatchAttempt.create({
    data: {
      organizationId: scope.organizationId,
      captureId,
      requestKey: input.requestKey,
      attemptNumber: (prior[0]?.attemptNumber ?? 0) + 1,
      provider: 'sandbox',
      senderId: 'sandbox-local-v1',
      sandboxOutcome: input.outcome,
      reservedAt: now,
    },
    include: { events: true },
  });
  if (reason)
    await db.pharmacyCampaignDeliveryEvent.create({
      data: {
        organizationId: scope.organizationId,
        attemptId: attempt.id,
        provider: 'sandbox',
        senderId: attempt.senderId,
        eventKey: eventKey(attempt.id, 'SUPPRESSED'),
        state: 'SUPPRESSED',
        reason,
        occurredAt: now,
      },
    });
  return { attempt, execute: !reason };
}

/** Pure deterministic adapter: no provider config, phone, template payload, network or environment. */
export function sandboxAdapter(attemptId: string, outcome: string) {
  if (outcome === 'FAULT') throw new Error('Sandbox adapter fault');
  if (outcome === 'TIMEOUT')
    return { state: 'UNKNOWN' as const, reason: 'TRANSPORT_UNKNOWN', messageId: null };
  if (outcome === 'REJECTED')
    return { state: 'FAILED' as const, reason: 'DEFINITE_REJECTION', messageId: null };
  return { state: 'PROVIDER_ACCEPTED' as const, reason: null, messageId: `sandbox:${attemptId}` };
}

/** Fresh transactions are required; do not pass the request's nested transaction facade. */
export async function dispatchSandboxCampaign(
  transaction: MarketingTransaction,
  raw: z.input<typeof sandboxDispatchInput>,
  now = new Date()
) {
  const input = sandboxDispatchInput.parse(raw);
  const captures = await transaction(async (db, scope) => {
    // DEV-22: a WhatsApp account block or quality flag pauses every marketing send.
    const pause = await whatsappMarketingPause(db, scope.organizationId, now);
    if (pause.paused)
      throw new MarketingWorkflowError(
        `Marketing sends are paused: WhatsApp reported ${pause.reason}. Review or appeal the account first.`
      );
    const rows = await db.pharmacyCampaignCapture.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        campaignId: input.campaignId,
      },
      select: { id: true },
      orderBy: { customerId: 'asc' },
      take: 501,
    });
    if (rows.length > 500) throw new MarketingWorkflowError('Sandbox audience exceeds the limit.');
    return rows;
  });
  for (const capture of captures) {
    const reservation = await transaction((db, scope) =>
      reserveSandboxAttempt(db, scope, capture.id, input, now)
    );
    if (!reservation.execute) continue;
    const { attempt } = reservation;
    let outcome: ReturnType<typeof sandboxAdapter>;
    try {
      outcome = sandboxAdapter(attempt.id, attempt.sandboxOutcome!);
    } catch {
      outcome = { state: 'UNKNOWN', reason: 'ADAPTER_FAULT', messageId: null };
    }
    // A persistence failure propagates. NEVER rewrite acceptance as rejection or invoke adapter again.
    await transaction(async (db, scope) => {
      const accepted = await db.pharmacyCampaignDeliveryEvent.create({
        data: {
          organizationId: scope.organizationId,
          attemptId: attempt.id,
          provider: 'sandbox',
          senderId: attempt.senderId,
          eventKey: eventKey(attempt.id, outcome.state),
          state: outcome.state,
          reason: outcome.reason,
          providerMessageId: outcome.messageId,
          occurredAt: now,
        },
      });
      if (outcome.state === 'PROVIDER_ACCEPTED')
        await db.pharmacyCampaignDeliveryEvent.create({
          data: {
            organizationId: scope.organizationId,
            attemptId: attempt.id,
            provider: 'sandbox',
            senderId: attempt.senderId,
            eventKey: eventKey(attempt.id, 'DELIVERED'),
            state: 'DELIVERED',
            acceptanceId: accepted.id,
            providerMessageId: outcome.messageId,
            occurredAt: now,
          },
        });
    });
  }
  return transaction((db, scope) => campaignDeliveryHistory(db, scope, input.campaignId));
}

export async function campaignDeliveryHistory(
  db: ScopedDb,
  scope: MarketingScope,
  campaignId: string
) {
  const rows = await db.pharmacyCampaignDispatchAttempt.findMany({
    where: {
      organizationId: scope.organizationId,
      provider: 'sandbox',
      capture: { branchId: scope.branchId, campaignId },
    },
    include: { events: true },
    orderBy: [{ reservedAt: 'desc' }, { id: 'asc' }],
  });
  return {
    mode: 'SANDBOX' as const,
    attempted: rows.filter((a) => !a.events.some((e) => e.state === 'SUPPRESSED')).length,
    accepted: rows.filter((a) => a.provider === 'sandbox' && reconcileDelivery(a.events).accepted)
      .length,
    delivered: rows.filter((a) => a.provider === 'sandbox' && reconcileDelivery(a.events).delivered)
      .length,
    failed: rows.filter((a) => reconcileDelivery(a.events).failed).length,
    unknown: rows.filter((a) => reconcileDelivery(a.events).unknown).length,
    suppressed: rows.filter((a) => reconcileDelivery(a.events).suppressed).length,
    attempts: rows.map((a) => ({
      id: a.id,
      captureId: a.captureId,
      provider: a.provider,
      attemptNumber: a.attemptNumber,
      reservedAt: a.reservedAt,
      ...reconcileDelivery(a.events),
    })),
  };
}

const callbackInput = z
  .object({
    senderId: z.string().min(1).max(128),
    messageId: z.string().min(1).max(256),
    state: z.enum(['PROVIDER_ACCEPTED', 'DELIVERED', 'FAILED']),
    occurredAt: z.date(),
  })
  .strict();
/** Call only after raw-body authentication and explicit tenant/sender ownership validation. */
export async function recordMarketingCallback(
  db: ScopedDb,
  organizationId: string,
  ownedSenderId: string,
  raw: z.infer<typeof callbackInput>,
  now = new Date()
) {
  const input = callbackInput.parse(raw);
  if (input.senderId !== ownedSenderId || input.occurredAt > now) return 'REJECTED' as const;
  const acceptance = await db.pharmacyCampaignDeliveryEvent.findFirst({
    where: {
      organizationId,
      provider: 'meta',
      senderId: ownedSenderId,
      providerMessageId: input.messageId,
      state: 'PROVIDER_ACCEPTED',
    },
  });
  if (!acceptance) return 'UNBOUND' as const;
  if (input.state === 'PROVIDER_ACCEPTED') return 'REPLAY' as const;
  const result = await db.pharmacyCampaignDeliveryEvent.createMany({
    skipDuplicates: true,
    data: {
      organizationId,
      attemptId: acceptance.attemptId,
      provider: 'meta',
      senderId: ownedSenderId,
      providerMessageId: input.messageId,
      acceptanceId: acceptance.id,
      state: input.state,
      reason: input.state === 'FAILED' ? 'PROVIDER_FAILURE' : null,
      occurredAt: input.occurredAt,
      eventKey: eventKey(
        'meta',
        ownedSenderId,
        input.messageId,
        input.state,
        input.occurredAt.toISOString()
      ),
    },
  });
  return result.count ? ('RECORDED' as const) : ('REPLAY' as const);
}
