import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
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
