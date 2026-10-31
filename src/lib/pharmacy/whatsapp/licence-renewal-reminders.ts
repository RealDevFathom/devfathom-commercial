import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { renewalTemplateParameters, type RenewalReminder } from '../licence-renewal';
import { readLicenceRenewalReminders } from '../licence-renewal-operations';
import { claimMessageLogInTransaction, sendClaimedMessage } from './message-log';
import { normalizeWhatsAppNumber, phoneLast4 } from './messages';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  type WhatsAppConfig,
  type WhatsAppProvider,
} from './provider';

export type LicenceRenewalRunResult = {
  configured: boolean;
  owners: number;
  scanned: number;
  sent: number;
  prepared: number;
  unknown: number;
  failed: number;
  duplicate: number;
  skipped: number;
};

/**
 * One WhatsApp per owner, licence, expiry date and reminder stage. A renewed
 * licence has a new expiry date, so its own 90/60/30/7-day reminders start
 * fresh; the lapsed licence's reminders stop because it is no longer read.
 */
export function renewalMessageDedupeKey(reminder: RenewalReminder, ownerUserId: string): string {
  return `${reminder.dedupeKey}:owner:${ownerUserId}`;
}

/** Only the 90, 60, 30 and 7-day stages are messaged; a lapsed licence stays on the banner. */
export function renewalRemindersToMessage(reminders: readonly RenewalReminder[]) {
  return reminders.filter((reminder) => reminder.stage !== null && !reminder.expired);
}

type Claimed = {
  logId: string;
  to: string;
  reminder: RenewalReminder;
  dedupeKey: string;
};

/**
 * #720 — optional owner-only WhatsApp utility template for licence renewals.
 *
 * Off unless `PHARMACY_WHATSAPP_TEMPLATE_LICENCE_RENEWAL` names an approved
 * template for the configured sender's workspace. Recipients are only the
 * workspace owners who opted into the daily owner digest (an ADMIN with an
 * enabled digest setting, still holding `reports:operational`) and have a phone
 * on their own user record. Never a customer, never a patient, and the template
 * carries only the licence, its expiry and the fee. Every message is claimed in
 * the message log before the provider is called, so a re-run sends nothing new.
 */
export async function processDueWhatsAppLicenceRenewalReminders(
  options: { now?: Date; config?: WhatsAppConfig; provider?: WhatsAppProvider } = {}
): Promise<LicenceRenewalRunResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readWhatsAppConfig();
  const provider = options.provider ?? createWhatsAppProvider(config);
  const templateName = config.templates.licenceRenewalReminder ?? null;
  const result: LicenceRenewalRunResult = {
    configured: Boolean(templateName),
    owners: 0,
    scanned: 0,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    skipped: 0,
  };
  const organizationId = config.organizationId;
  if (!templateName || config.provider === 'meta' || !organizationId || !config.phoneNumberId)
    return { ...result, configured: false };

  const claimed = await withTenantDb(organizationId, async (db): Promise<Claimed[]> => {
    const organization = await db.organization.findUnique({
      where: { id: organizationId },
      select: { vertical: true, status: true, timezone: true },
    });
    if (
      !organization ||
      organization.vertical !== 'PHARMACY' ||
      !isTenantLifecycleAccessible(organization.status)
    )
      return [];
    if (
      !hasModule(await resolveOrganizationEntitlements(organizationId, db, now), 'pharmacy-reports')
    )
      return [];
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: workspaceTimezone(organization.timezone),
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(now)
    );
    // Business hours only, as the other utility templates.
    if (hour >= 22 || hour < 8) return [];

    const settings = await db.pharmacyOwnerDigestSetting.findMany({
      where: {
        organizationId,
        enabled: true,
        branch: { active: true },
        user: { organizationId, role: 'ADMIN', status: 'ACTIVE' },
      },
      orderBy: [{ userId: 'asc' }, { branchId: 'asc' }],
      select: {
        branchId: true,
        user: {
          select: {
            id: true,
            organizationId: true,
            status: true,
            role: true,
            department: true,
            phone: true,
          },
        },
      },
    });
    const owners = new Map<
      string,
      { user: (typeof settings)[number]['user']; branchIds: string[] }
    >();
    for (const setting of settings) {
      const owner = owners.get(setting.user.id) ?? { user: setting.user, branchIds: [] };
      owner.branchIds.push(setting.branchId);
      owners.set(setting.user.id, owner);
    }

    const claims: Claimed[] = [];
    for (const { user, branchIds } of owners.values()) {
      result.owners += 1;
      const to = normalizeWhatsAppNumber(user.phone);
      const allowed =
        to &&
        (await can(subjectFromSession(user), 'reports:operational', undefined, {
          db,
          source: 'SYSTEM',
          now,
        }));
      const due = renewalRemindersToMessage(
        await readLicenceRenewalReminders(db, { organizationId, branchIds, at: now })
      );
      result.scanned += due.length;
      if (!to || !allowed) {
        result.skipped += due.length;
        continue;
      }
      for (const reminder of due) {
        const dedupeKey = renewalMessageDedupeKey(reminder, user.id);
        const logId = await claimMessageLogInTransaction(db, {
          organizationId,
          direction: 'OUTBOUND',
          status: 'PENDING',
          kind: 'LICENCE_RENEWAL_REMINDER',
          dedupeKey,
          branchId: reminder.branchId,
          phoneLast4: phoneLast4(to),
          templateName,
          dueDate: reminder.expiresAt.toISOString().slice(0, 10),
        });
        if (!logId) {
          result.duplicate += 1;
          continue;
        }
        claims.push({ logId, to, reminder, dedupeKey });
      }
    }
    return claims;
  });

  // Provider calls run after the claims commit, as the other reminder jobs do.
  for (const claim of claimed) {
    const outcome = await sendClaimedMessage(
      {
        organizationId,
        kind: 'LICENCE_RENEWAL_REMINDER',
        dedupeKey: claim.dedupeKey,
        branchId: claim.reminder.branchId,
        phoneLast4: phoneLast4(claim.to),
        templateName,
        dueDate: claim.reminder.expiresAt.toISOString().slice(0, 10),
      },
      claim.logId,
      () =>
        provider.sendTemplate({
          to: claim.to,
          template: 'licenceRenewalReminder',
          parameters: renewalTemplateParameters(claim.reminder),
        })
    );
    if (outcome === 'SENT') result.sent += 1;
    else if (outcome === 'PREPARED') result.prepared += 1;
    else if (outcome === 'UNKNOWN') result.unknown += 1;
    else result.failed += 1;
  }
  return result;
}
