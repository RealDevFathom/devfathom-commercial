import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';

import {
  BackInStockTemplateError,
  backInStockTemplateParameters,
  isRestockRequestExpired,
  readBackInStockPolicy,
  restockRequestCutoff,
  type BackInStockPolicy,
} from '../back-in-stock';
import { lockPatientConsent } from '../consent-writer';
import { linkRestockRecoveries } from '../sales';
import { claimMessageLogInTransaction, sendClaimedMessage } from './message-log';
import { canMessageCustomer, normalizeWhatsAppNumber, phoneLast4 } from './messages';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  type WhatsAppConfig,
  type WhatsAppProvider,
} from './provider';

/** Recovery linking is a system pass; no person performs it. */
const SYSTEM_ACTOR = 'system:back-in-stock';

export const backInStockDedupeKey = (notificationId: string) => `back-in-stock:${notificationId}`;

export type BackInStockRunResult = {
  configured: boolean;
  scanned: number;
  sent: number;
  prepared: number;
  unknown: number;
  failed: number;
  duplicate: number;
  expired: number;
  skippedNoConsent: number;
  /** Notices withheld because a parameter would have named the product. */
  skippedUnsafeText: number;
  quietHours: boolean;
  /** Requests linked to the completed sale that recovered them. */
  linked: number;
};

type Claim = {
  logId: string;
  branchId: string;
  customerId: string;
  patientId: string;
  to: string;
  parameters: string[];
  dedupeKey: string;
};

/**
 * DEV-79 scheduled job for the deployment's bound WhatsApp sender. Sends the
 * approved back-in-stock utility template for each captured WhatsApp notice
 * (queued on goods receipt by `captureSafeRestockArrival`), oldest first, once
 * per notice, only while the request is unexpired and only to customers who
 * opted in on WhatsApp with a current REMINDERS consent. The template carries
 * the branch, the request date and an opaque reference; a notice whose text
 * would name the product, its salt or its category is withheld. Afterwards it
 * links notified requests to the sale that recovered them.
 */
export async function processBackInStockNotices(
  options: {
    now?: Date;
    limit?: number;
    config?: WhatsAppConfig;
    provider?: WhatsAppProvider;
    policy?: BackInStockPolicy;
  } = {}
): Promise<BackInStockRunResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readWhatsAppConfig();
  const provider = options.provider ?? createWhatsAppProvider(config);
  const policy = options.policy ?? readBackInStockPolicy();
  const result: BackInStockRunResult = {
    configured: Boolean(config.templates.backInStock && config.phoneNumberId),
    scanned: 0,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    expired: 0,
    skippedNoConsent: 0,
    skippedUnsafeText: 0,
    quietHours: false,
    linked: 0,
  };
  const organizationId = config.organizationId;
  if (!organizationId) {
    result.configured = false;
    return result;
  }
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));

  const tenant = await withTenantDb(organizationId, async (db) => {
    const organization = await db.organization.findUnique({
      where: { id: organizationId },
      select: { vertical: true, status: true, timezone: true },
    });
    if (
      !organization ||
      organization.vertical !== 'PHARMACY' ||
      !isTenantLifecycleAccessible(organization.status)
    )
      return null;
    const branches = await db.pharmacyBranch.findMany({
      where: { organizationId, active: true },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    if (!result.configured) return { branches, claims: [] as Claim[] };
    if (
      !hasModule(await resolveOrganizationEntitlements(organizationId, db, now), 'pharmacy-crm')
    ) {
      result.configured = false;
      return { branches, claims: [] as Claim[] };
    }
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: workspaceTimezone(organization.timezone),
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(now)
    );
    if (hour >= 22 || hour < 8) {
      result.quietHours = true;
      return { branches, claims: [] as Claim[] };
    }

    const claims: Claim[] = [];
    for (const branch of branches) {
      if (claims.length >= limit) break;
      // Restock tables enforce exactly one branch through FORCE RLS.
      await db.$queryRaw(
        Prisma.sql`SELECT set_config('app.current_branch_id', ${branch.id}, true)`
      );
      const due = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT notice."id"
        FROM "pharmacy_restock_notifications" notice
        JOIN "pharmacy_restock_interests" interest
          ON interest."organizationId" = notice."organizationId"
         AND interest."branchId" = notice."branchId"
         AND interest."id" = notice."interestId"
        WHERE notice."organizationId" = ${organizationId}
          AND notice."branchId" = ${branch.id}
          AND notice."channel" = 'WHATSAPP'
          AND notice."status" = 'CAPTURED'
          AND interest."status" = 'NOTIFIED'
          AND interest."createdAt" > ${restockRequestCutoff(now, policy)}
          AND NOT EXISTS (
            SELECT 1 FROM "pharmacy_message_logs" log
            WHERE log."organizationId" = notice."organizationId"
              AND log."dedupeKey" = 'back-in-stock:' || notice."id"
          )
        ORDER BY notice."queuedAt", notice."id"
        LIMIT ${limit - claims.length}
      `);
      if (!due.length) continue;
      const notices = await db.pharmacyRestockNotification.findMany({
        where: { organizationId, branchId: branch.id, id: { in: due.map((row) => row.id) } },
        orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          interest: {
            select: {
              id: true,
              status: true,
              patientId: true,
              createdAt: true,
              demandEvent: {
                select: {
                  requestedText: true,
                  medicine: {
                    select: {
                      productName: true,
                      brandName: true,
                      strengths: { select: { ingredient: { select: { name: true } } } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      for (const notice of notices) {
        result.scanned += 1;
        const interest = notice.interest;
        if (interest.status !== 'NOTIFIED') continue;
        if (isRestockRequestExpired(interest.createdAt, now, policy)) {
          result.expired += 1;
          continue;
        }
        if (!interest.patientId) {
          result.skippedNoConsent += 1;
          continue;
        }
        await lockPatientConsent(db, organizationId, interest.patientId);
        const [customer, consent] = await Promise.all([
          db.pharmacyCustomer.findFirst({
            where: { organizationId, patientId: interest.patientId },
            select: {
              id: true,
              active: true,
              whatsappOptIn: true,
              patient: { select: { phone: true } },
            },
          }),
          db.patientConsent.findFirst({
            where: {
              organizationId,
              patientId: interest.patientId,
              purpose: 'REMINDERS',
              channel: 'WHATSAPP',
            },
            orderBy: { version: 'desc' },
            select: { granted: true, revokedAt: true, recordedAt: true },
          }),
        ]);
        const to = normalizeWhatsAppNumber(customer?.patient.phone);
        if (
          !customer ||
          !to ||
          !canMessageCustomer(customer) ||
          !consent?.granted ||
          consent.revokedAt ||
          consent.recordedAt > now
        ) {
          result.skippedNoConsent += 1;
          continue;
        }
        const medicine = interest.demandEvent.medicine;
        let parameters: string[];
        try {
          parameters = backInStockTemplateParameters(
            {
              branchName: branch.name,
              requestedOn: pharmacyCalendarDay(organization.timezone, interest.createdAt),
              interestId: interest.id,
            },
            [
              interest.demandEvent.requestedText,
              medicine?.productName,
              medicine?.brandName,
              ...(medicine?.strengths.map((strength) => strength.ingredient.name) ?? []),
            ]
          );
        } catch (error) {
          if (!(error instanceof BackInStockTemplateError)) throw error;
          result.skippedUnsafeText += 1;
          continue;
        }
        const dedupeKey = backInStockDedupeKey(notice.id);
        const logId = await claimMessageLogInTransaction(db, {
          organizationId,
          direction: 'OUTBOUND',
          status: 'PENDING',
          kind: 'BACK_IN_STOCK',
          dedupeKey,
          branchId: branch.id,
          customerId: customer.id,
          patientId: interest.patientId,
          phoneLast4: phoneLast4(to),
          templateName: config.templates.backInStock,
        });
        if (!logId) {
          result.duplicate += 1;
          continue;
        }
        claims.push({
          logId,
          branchId: branch.id,
          customerId: customer.id,
          patientId: interest.patientId,
          to,
          parameters,
          dedupeKey,
        });
      }
    }
    return { branches, claims };
  });
  if (!tenant) {
    result.configured = false;
    return result;
  }

  for (const claim of tenant.claims) {
    const outcome = await sendClaimedMessage(
      {
        organizationId,
        kind: 'BACK_IN_STOCK',
        dedupeKey: claim.dedupeKey,
        branchId: claim.branchId,
        customerId: claim.customerId,
        patientId: claim.patientId,
        phoneLast4: phoneLast4(claim.to),
        templateName: config.templates.backInStock,
      },
      claim.logId,
      () =>
        provider.sendTemplate({
          to: claim.to,
          template: 'backInStock',
          parameters: claim.parameters,
        })
    );
    if (outcome === 'SENT') result.sent += 1;
    else if (outcome === 'PREPARED') result.prepared += 1;
    else if (outcome === 'UNKNOWN') result.unknown += 1;
    else result.failed += 1;
  }

  // Recovery linking needs no sender or template, and runs in quiet hours too.
  for (const branch of tenant.branches) {
    const linked = await withTenantDb(organizationId, (db) =>
      linkRestockRecoveries(
        db,
        { organizationId, branchId: branch.id, actorId: SYSTEM_ACTOR },
        { now, policy }
      )
    );
    result.linked += linked.length;
  }
  return result;
}
