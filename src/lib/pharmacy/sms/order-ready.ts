import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { lockPatientConsent } from '../consent-writer';
import {
  claimSmsFallbackInTransaction,
  hasWhatsAppReminderConsent,
  sendSmsFallbackClaim,
  type SmsFallbackOutcome,
} from './fallback';
import {
  createSmsProvider,
  readSmsConfig,
  smsFallbackEnabled,
  type SmsConfig,
  type SmsProvider,
} from './provider';
import { SMS_TEMPLATES } from './templates';

export type OrderReadySmsOutcome =
  | SmsFallbackOutcome
  | 'NOT_CONFIGURED'
  | 'NOT_ELIGIBLE'
  | 'QUIET_HOURS'
  | 'WHATSAPP_CONSENTED'
  | 'NO_SMS_CONSENT';

/** Stable public reference shown to the customer (same form as the WhatsApp confirmation). */
export function orderReference(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

/**
 * #723 — order-ready SMS. Called after a staff `ready` transition has
 * committed, as that staff user (customer orders are RLS-visible only to the
 * customer's own user or `pharmacy:orders` staff). There is no WhatsApp
 * order-ready message, so SMS goes ONLY to customers WITHOUT WhatsApp consent
 * who hold a granted REMINDERS/SMS consent and have not replied STOP. Claimed
 * once per order (`sms:order-ready:<orderId>`); the provider call runs after
 * the claim commits. Never throws for an ineligible order.
 */
export async function notifyOrderReadyBySms(input: {
  organizationId: string;
  branchId: string;
  orderId: string;
  actorUserId: string;
  now?: Date;
  smsConfig?: SmsConfig;
  smsProvider?: SmsProvider;
}): Promise<OrderReadySmsOutcome> {
  const now = input.now ?? new Date();
  const smsConfig = input.smsConfig ?? readSmsConfig();
  if (!smsFallbackEnabled(smsConfig, input.organizationId)) return 'NOT_CONFIGURED';
  const smsProvider = input.smsProvider ?? createSmsProvider(smsConfig);
  const { organizationId } = input;

  const prepared = await withTenantDb(
    organizationId,
    async (db) => {
      await db.$queryRaw(
        Prisma.sql`SELECT set_config('app.current_branch_id', ${input.branchId}, true)`
      );
      const organization = await db.organization.findUnique({
        where: { id: organizationId },
        select: { vertical: true, status: true, timezone: true },
      });
      const branch = await db.pharmacyBranch.findFirst({
        where: { organizationId, id: input.branchId, active: true },
        select: { name: true },
      });
      if (
        !organization ||
        organization.vertical !== 'PHARMACY' ||
        !isTenantLifecycleAccessible(organization.status) ||
        !branch
      )
        return 'NOT_ELIGIBLE' as const;
      if (
        !hasModule(await resolveOrganizationEntitlements(organizationId, db, now), 'pharmacy-crm')
      )
        return 'NOT_ELIGIBLE' as const;
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: workspaceTimezone(organization.timezone),
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(now)
      );
      if (hour >= 22 || hour < 8) return 'QUIET_HOURS' as const;
      const order = await db.pharmacyCustomerOrder.findFirst({
        where: { organizationId, branchId: input.branchId, id: input.orderId },
        select: { status: true, customerId: true },
      });
      if (order?.status !== 'READY_FOR_COLLECTION') return 'NOT_ELIGIBLE' as const;
      const customer = await db.pharmacyCustomer.findFirst({
        where: { organizationId, id: order.customerId },
        select: { id: true, patientId: true, active: true, whatsappOptIn: true },
      });
      if (!customer) return 'NOT_ELIGIBLE' as const;
      await lockPatientConsent(db, organizationId, customer.patientId);
      const whatsappConsent = await db.patientConsent.findFirst({
        where: {
          organizationId,
          patientId: customer.patientId,
          purpose: 'REMINDERS',
          channel: 'WHATSAPP',
        },
        orderBy: { version: 'desc' },
        select: { granted: true, revokedAt: true, recordedAt: true },
      });
      if (hasWhatsAppReminderConsent(customer, whatsappConsent, now))
        return 'WHATSAPP_CONSENTED' as const;
      const claim = await claimSmsFallbackInTransaction(db, smsConfig, {
        organizationId,
        customerId: customer.id,
        kind: 'ORDER_READY',
        dedupeKey: `sms:order-ready:${input.orderId}`,
        branchId: input.branchId,
        orderId: input.orderId,
        now,
      });
      if (!claim) return 'NO_SMS_CONSENT' as const;
      return { claim, branchName: branch.name };
    },
    { userId: input.actorUserId }
  );
  if (typeof prepared === 'string') return prepared;
  const { claim, branchName } = prepared;
  if (!claim.logId) return 'DUPLICATE';
  const body = SMS_TEMPLATES.orderReady(smsConfig.language, {
    reference: orderReference(input.orderId),
    branch: branchName,
  });
  return sendSmsFallbackClaim(smsProvider, { ...claim, logId: claim.logId }, body);
}

/**
 * Ready orders are the durable backlog for quiet hours and pre-claim failures.
 * Run from the existing reminder scheduler; completed/cancelled orders and any
 * claimed SMS are excluded. Use a current authorized staff reader for RLS and
 * recheck all eligibility in notifyOrderReadyBySms before claiming or sending.
 */
export async function processDeferredOrderReadySms(
  options: {
    now?: Date;
    limit?: number;
    smsConfig?: SmsConfig;
    smsProvider?: SmsProvider;
  } = {}
): Promise<{ scanned: number; outcomes: OrderReadySmsOutcome[] }> {
  const smsConfig = options.smsConfig ?? readSmsConfig();
  const organizationId = smsConfig.organizationId;
  if (!organizationId || !smsFallbackEnabled(smsConfig, organizationId))
    return { scanned: 0, outcomes: [] };
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  // Order RLS deliberately has no platform-admin bypass. Discover a current
  // pharmacy staff reader, then scan under that tenant/user rather than widening
  // the order policies for this job. Use this current reader for sending too;
  // the ready event's actor may have been deactivated or lost permission.
  const readers = await withPlatformDb((db) =>
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT actor.id FROM users actor
    JOIN organization_roles role
      ON role.id = actor."organizationRoleId" AND role."organizationId" = actor."organizationId"
    WHERE actor."organizationId" = ${organizationId} AND actor.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM organization_role_permissions permission
        WHERE permission."organizationId" = actor."organizationId" AND permission."organizationRoleId" = role.id
          AND permission.effect = 'ALLOW' AND permission.capability IN ('*', 'pharmacy:*', 'pharmacy:orders')
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_permission_overrides denied
        WHERE denied."organizationId" = actor."organizationId" AND denied."userId" = actor.id
          AND denied.effect = 'DENY' AND denied.capability IN ('*', 'pharmacy:*', 'pharmacy:orders')
          AND (denied."expiresAt" IS NULL OR denied."expiresAt" > ${now})
      )
    ORDER BY actor.id LIMIT 1
  `)
  );
  const reader = readers[0];
  if (!reader) return { scanned: 0, outcomes: [] };
  const orders = await withTenantDb(
    organizationId,
    (db) =>
      db.$queryRaw<Array<{ orderId: string; branchId: string }>>(Prisma.sql`
    SELECT orders.id AS "orderId", orders."branchId"
    FROM pharmacy_customer_orders orders
    JOIN pharmacy_customers customer
      ON customer."organizationId" = orders."organizationId" AND customer.id = orders."customerId"
    JOIN LATERAL (
      SELECT event.id FROM pharmacy_customer_order_events event
      WHERE event."organizationId" = orders."organizationId" AND event."orderId" = orders.id
        AND event."branchId" = orders."branchId" AND event.kind = 'READY_FOR_COLLECTION'
      ORDER BY event."occurredAt" DESC, event.id DESC LIMIT 1
    ) ready ON true
    WHERE orders."organizationId" = ${organizationId} AND orders.status = 'READY_FOR_COLLECTION'
      AND customer.active = true AND customer."smsOptIn" IS DISTINCT FROM false
      AND EXISTS (
        SELECT 1 FROM pharmacy_patient_consents consent
        WHERE consent."organizationId" = orders."organizationId" AND consent."patientId" = customer."patientId"
          AND consent.purpose = 'REMINDERS' AND consent.channel = 'SMS'
          AND consent.granted = true AND consent."revokedAt" IS NULL AND consent."recordedAt" <= ${now}
          AND consent.version = (SELECT MAX(latest.version) FROM pharmacy_patient_consents latest
            WHERE latest."organizationId" = consent."organizationId" AND latest."patientId" = consent."patientId"
              AND latest.purpose = consent.purpose AND latest.channel = consent.channel)
      )
      AND NOT (customer."whatsappOptIn" IS TRUE AND EXISTS (
        SELECT 1 FROM pharmacy_patient_consents consent
        WHERE consent."organizationId" = orders."organizationId" AND consent."patientId" = customer."patientId"
          AND consent.purpose = 'REMINDERS' AND consent.channel = 'WHATSAPP'
          AND consent.granted = true AND consent."revokedAt" IS NULL AND consent."recordedAt" <= ${now}
          AND consent.version = (SELECT MAX(latest.version) FROM pharmacy_patient_consents latest
            WHERE latest."organizationId" = consent."organizationId" AND latest."patientId" = consent."patientId"
              AND latest.purpose = consent.purpose AND latest.channel = consent.channel)
      ))
      AND NOT EXISTS (
        SELECT 1 FROM pharmacy_message_logs log
        WHERE log."organizationId" = orders."organizationId"
          AND log."dedupeKey" = 'sms:order-ready:' || orders.id
      )
    ORDER BY orders."readyAt", orders.id LIMIT ${limit}
    `),
    { userId: reader.id }
  );
  const outcomes: OrderReadySmsOutcome[] = [];
  for (const order of orders) {
    try {
      outcomes.push(
        await notifyOrderReadyBySms({
          organizationId,
          ...order,
          actorUserId: reader.id,
          now,
          smsConfig,
          smsProvider: options.smsProvider,
        })
      );
    } catch {
      console.error('PHARMACY_ORDER_READY_SMS_FAILED', { organizationId, orderId: order.orderId });
    }
  }
  return { scanned: orders.length, outcomes };
}
