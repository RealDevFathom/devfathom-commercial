import { isAppLocale, type AppLocale } from '@/i18n/config';
import 'server-only';
import { lockCustomerConsent, writePatientConsent } from '../consent-writer';

import {
  listStorefrontCatalog,
  PharmacyCustomerOrderError,
  placeCustomerOrder,
} from '@/lib/pharmacy/customer-ordering';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  claimMessageLogInTransaction,
  sendAndLog,
  updateMessageLog,
  type MessageLogKind,
} from './message-log';
import {
  canMessageCustomer,
  consentKeyword,
  normalizeWhatsAppNumber,
  parseOrderMessage,
  phoneLast4,
  localizedWhatsAppReplies,
  type ParsedOrderMessage,
} from './messages';
import type { WhatsAppInboundMessage, WhatsAppProvider } from './provider';

/** Promotional purposes a WhatsApp STOP withdraws; service purposes are kept. */
const STOP_REVOKED_PURPOSES = ['MARKETING', 'LOYALTY'] as const;
const CONSENT_CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL', 'PHONE', 'IN_PERSON'] as const;

export type InboundOutcome =
  | 'DUPLICATE'
  | 'UNKNOWN_SENDER'
  | 'NO_CONSENT'
  | 'OPTED_OUT'
  | 'OPTED_IN'
  | 'STALE_CONSENT'
  | 'EXPIRED_MESSAGE'
  | 'ORDER_PLACED'
  | 'PHARMACIST_CALLBACK';

type KnownCustomer = {
  preferredLanguage: AppLocale;
  id: string;
  userId: string | null;
  patientId: string;
  active: boolean;
  whatsappOptIn: boolean | null;
};

/**
 * Resolves the sender to exactly one active customer whose patient phone
 * normalizes to the WhatsApp id. Ambiguous matches are treated as unknown.
 */
export async function findCustomerByWhatsApp(
  db: ScopedDb,
  organizationId: string,
  waId: string
): Promise<KnownCustomer | null> {
  const last4 = phoneLast4(waId);
  if (!last4) return null;
  const candidates = await db.pharmacyCustomer.findMany({
    where: { organizationId, active: true, patient: { phone: { endsWith: last4 } } },
    select: {
      id: true,
      userId: true,
      patientId: true,
      active: true,
      whatsappOptIn: true,
      preferredLanguage: true,
      patient: { select: { phone: true } },
    },
    take: 50,
  });
  const matches = candidates.filter(
    (candidate) => normalizeWhatsAppNumber(candidate.patient.phone) === waId
  );
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return {
    preferredLanguage: isAppLocale(match.preferredLanguage) ? match.preferredLanguage : 'en',
    id: match.id,
    userId: match.userId,
    patientId: match.patientId,
    active: match.active,
    whatsappOptIn: match.whatsappOptIn,
  };
}

async function orderBranch(db: ScopedDb, organizationId: string, customerId: string) {
  const lastOrder = await db.pharmacyCustomerOrder.findFirst({
    where: { organizationId, customerId, branch: { active: true } },
    orderBy: { createdAt: 'desc' },
    select: { branch: { select: { id: true, name: true } } },
  });
  if (lastOrder) return lastOrder.branch;
  const branches = await db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    select: { id: true, name: true },
    take: 2,
  });
  return branches.length === 1 ? branches[0]! : null;
}

/**
 * Places a COLLECT / CASH order through the existing storefront path
 * (`placeCustomerOrder`, the service behind `pharmacyOrdering.place`) acting
 * as the customer's own linked user. Returns null whenever the request is not
 * unambiguous — the caller then falls back to a pharmacist call.
 */
async function placeWhatsAppOrder(
  organizationId: string,
  customer: KnownCustomer,
  parsed: ParsedOrderMessage,
  claim: Parameters<typeof claimMessageLogInTransaction>[1]
) {
  const userId = customer.userId;
  if (!userId) return null;
  try {
    return await withTenantDb(
      organizationId,
      async (db) => {
        const inboundId = await claimMessageLogInTransaction(db, claim);
        if (!inboundId) return { duplicate: true as const };
        const branch = await orderBranch(db, organizationId, customer.id);
        if (!branch) return null;
        const scope = { organizationId, branchId: branch.id, actorId: userId };
        const rows = await listStorefrontCatalog(db, scope, parsed.medicine);
        const exact = rows.filter((row) => row.productName.toLowerCase() === parsed.medicine);
        const item = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : undefined;
        if (!item || item.availablePacks < parsed.quantity) return null;
        const order = await placeCustomerOrder(db, scope, {
          staff: false,
          fulfillment: 'COLLECT',
          intendedPaymentMethod: 'CASH',
          lines: [
            {
              medicineId: item.medicineId,
              presentationId: item.presentationId,
              packLevelId: item.packLevelId,
              saleUnit: 'PACK',
              quantity: parsed.quantity,
            },
          ],
        });
        if (!order) return null;
        await db.pharmacyMessageLog.update({
          where: { id: inboundId },
          data: { orderId: order.id, branchId: branch.id },
        });
        return { orderId: order.id, branch, medicine: item.productName };
      },
      { userId }
    );
  } catch (error) {
    if (error instanceof PharmacyCustomerOrderError) return null;
    throw error;
  }
}

export async function handleInboundWhatsAppMessage(
  organizationId: string,
  provider: WhatsAppProvider,
  message: WhatsAppInboundMessage,
  now = new Date()
): Promise<InboundOutcome> {
  const keyword = consentKeyword(message.text);
  const kind: MessageLogKind =
    keyword === 'STOP' ? 'OPT_OUT' : keyword === 'START' ? 'OPT_IN' : 'ORDER_REQUEST';
  const last4 = phoneLast4(message.from);
  const inboundClaim = {
    organizationId,
    direction: 'INBOUND' as const,
    status: 'RECEIVED' as const,
    kind,
    dedupeKey: `in:${message.providerMessageId}`,
    phoneLast4: last4,
    providerMessageId: message.providerMessageId,
  };
  // Commit the consent effect with its replay claim. A failed transaction must
  // leave the webhook retryable; no provider call occurs inside this transaction.
  const { customer, inboundId, staleConsent } = await withTenantDb(organizationId, async (db) => {
    const customer = await findCustomerByWhatsApp(db, organizationId, message.from);
    const inboundId = keyword
      ? await claimMessageLogInTransaction(db, {
          ...inboundClaim,
          customerId: customer?.id ?? null,
        })
      : null;
    let staleConsent = false;
    if (inboundId && customer && keyword) {
      if (!Number.isFinite(message.receivedAt.getTime()) || message.receivedAt > now)
        throw new Error('Invalid consent timestamp.');
      await lockCustomerConsent(db, organizationId, customer.id);
      const optIn = keyword === 'START';
      const changed = await db.pharmacyCustomer.updateMany({
        where: {
          organizationId,
          id: customer.id,
          OR: [
            { whatsappOptInChangedAt: null },
            { whatsappOptInChangedAt: { lt: message.receivedAt } },
            // Meta timestamps have second precision. STOP wins an equal-time race.
            ...(!optIn ? [{ whatsappOptInChangedAt: message.receivedAt }] : []),
          ],
        },
        data: { whatsappOptIn: optIn, whatsappOptInChangedAt: message.receivedAt },
      });
      staleConsent = changed.count === 0;
      let revoked = 0;
      // START enables utility replies only. Marketing grants require their own
      // explicit counter/QR consent; STOP revokes promotional consent on every
      // channel, while service purposes (dispensing, reminders) are untouched.
      // Each purpose/channel is judged against its own history, not the utility
      // flag: a STOP delivered after a newer START still withdraws older grants.
      if (!optIn) {
        for (const purpose of STOP_REVOKED_PURPOSES)
          for (const channel of CONSENT_CHANNELS) {
            const latest = await db.patientConsent.findFirst({
              where: { organizationId, patientId: customer.patientId, purpose, channel },
              orderBy: [{ version: 'desc' }, { id: 'asc' }],
              select: { granted: true, revokedAt: true, recordedAt: true },
            });
            // The patient lock also serializes counter/QR writes. A delayed reply
            // must not supersede a newer purpose-specific event; STOP wins ties.
            if (latest && latest.recordedAt > message.receivedAt) continue;
            // Already revoked: another version would only clutter the history.
            if (latest && (!latest.granted || latest.revokedAt)) continue;
            // WhatsApp marketing always gets an explicit refusal row; other
            // channels/purposes only need one when there is a grant to revoke.
            if (!latest && (purpose !== 'MARKETING' || channel !== 'WHATSAPP')) continue;
            await writePatientConsent(
              db,
              organizationId,
              customer.userId ?? `whatsapp:${last4}`,
              {
                patientId: customer.patientId,
                purpose,
                channel,
                granted: false,
                source: 'REPLY',
              },
              message.receivedAt
            );
            revoked += 1;
          }
      }
      if (staleConsent)
        await db.pharmacyMessageLog.update({
          where: { id: inboundId },
          data:
            revoked > 0
              ? { error: 'STALE_UTILITY_CONSENT' }
              : { status: 'IGNORED', error: 'STALE_CONSENT' },
        });
    }
    return { customer, inboundId, staleConsent };
  });
  if (keyword && !inboundId) return 'DUPLICATE';
  if (staleConsent) return 'STALE_CONSENT';
  const claimInbound = () =>
    withTenantDb(organizationId, (db) =>
      claimMessageLogInTransaction(db, {
        ...inboundClaim,
        customerId: customer?.id ?? null,
      })
    );
  if (!customer) {
    const unknownInboundId = await claimInbound();
    if (!unknownInboundId) return 'DUPLICATE';
    await updateMessageLog(organizationId, unknownInboundId, { status: 'IGNORED' });
    return 'UNKNOWN_SENDER';
  }
  const age = now.getTime() - message.receivedAt.getTime();
  const inReplyWindow = Number.isFinite(age) && age >= 0 && age < 24 * 60 * 60 * 1000;

  const reply = (
    replyKind: MessageLogKind,
    body: string,
    extra: { orderId?: string; branchId?: string } = {}
  ) =>
    sendAndLog(
      {
        organizationId,
        kind: replyKind,
        dedupeKey: `out:${message.providerMessageId}`,
        customerId: customer.id,
        phoneLast4: last4,
        ...extra,
      },
      () => provider.sendText({ to: message.from, body })
    );

  const replies = localizedWhatsAppReplies(customer.preferredLanguage);
  if (keyword) {
    const optIn = keyword === 'START';
    // The acknowledgement answers the customer's own consent request; it is the
    // only message sent regardless of the stored flag.
    if (inReplyWindow) await reply('CONSENT_ACK', optIn ? replies.optedIn : replies.optedOut);
    return optIn ? 'OPTED_IN' : 'OPTED_OUT';
  }

  if (!inReplyWindow) {
    const inboundId = await claimInbound();
    if (!inboundId) return 'DUPLICATE';
    await updateMessageLog(organizationId, inboundId, {
      status: 'IGNORED',
      error: 'EXPIRED_MESSAGE',
    });
    return 'EXPIRED_MESSAGE';
  }

  if (!canMessageCustomer(customer)) {
    const inboundId = await claimInbound();
    if (!inboundId) return 'DUPLICATE';
    await updateMessageLog(organizationId, inboundId, { status: 'IGNORED' });
    return 'NO_CONSENT';
  }

  const parsed = parseOrderMessage(message.text);
  const placed = parsed
    ? customer.userId
      ? await placeWhatsAppOrder(organizationId, customer, parsed, {
          ...inboundClaim,
          customerId: customer.id,
        })
      : null
    : null;
  if (placed && 'duplicate' in placed) return 'DUPLICATE';
  if (!placed || !parsed) {
    if (!parsed || !customer.userId) {
      const inboundId = await claimInbound();
      if (!inboundId) return 'DUPLICATE';
    }
    await reply('ORDER_FALLBACK', replies.fallback);
    return 'PHARMACIST_CALLBACK';
  }
  await reply(
    'ORDER_CONFIRMATION',
    replies.confirmation({
      reference: placed.orderId.slice(-6).toUpperCase(),
      quantity: parsed.quantity,
      branch: placed.branch.name,
    }),
    { orderId: placed.orderId, branchId: placed.branch.id }
  );
  return 'ORDER_PLACED';
}
