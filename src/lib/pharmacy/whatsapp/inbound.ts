import 'server-only';

import { lockCustomerConsent } from '../consent-writer';

import {
  listStorefrontCatalog,
  PharmacyCustomerOrderError,
  placeCustomerOrder,
} from '@/lib/pharmacy/customer-ordering';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  claimMessageLogInTransaction,
  sendAndLog,
  sendClaimedMessage,
  updateMessageLog,
  type MessageLogKind,
} from './message-log';
import {
  canMessageCustomer,
  consentKeyword,
  normalizeWhatsAppNumber,
  parseOrderMessage,
  phoneLast4,
  WHATSAPP_REPLIES,
  type ParsedOrderMessage,
} from './messages';
import type { WhatsAppInboundMessage, WhatsAppProvider } from './provider';

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
  id: string;
  userId: string | null;
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
      active: true,
      whatsappOptIn: true,
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
    id: match.id,
    userId: match.userId,
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
  db: ScopedDb,
  organizationId: string,
  customer: KnownCustomer,
  parsed: ParsedOrderMessage
) {
  const userId = customer.userId;
  if (!userId) return null;
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
  return { orderId: order.id, branch, medicine: item.productName };
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
  // Commit the consent effect with its replay claim. A failed transaction must
  // leave the webhook retryable; no provider call occurs inside this transaction.
  const { customer, inboundId, staleConsent } = await withTenantDb(organizationId, async (db) => {
    const customer = await findCustomerByWhatsApp(db, organizationId, message.from);
    // Order requests are claimed below in the same transaction as order
    // placement. Committing that claim here would make a failed placement
    // unretryable.
    const inboundId = keyword
      ? await claimMessageLogInTransaction(db, {
          organizationId,
          direction: 'INBOUND',
          status: 'RECEIVED',
          kind,
          dedupeKey: `in:${message.providerMessageId}`,
          customerId: customer?.id ?? null,
          phoneLast4: last4,
          providerMessageId: message.providerMessageId,
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
      if (staleConsent)
        await db.pharmacyMessageLog.update({
          where: { id: inboundId },
          data: { status: 'IGNORED', error: 'STALE_CONSENT' },
        });
    }
    return { customer, inboundId, staleConsent };
  });
  if (keyword && !inboundId) return 'DUPLICATE';
  if (staleConsent) return 'STALE_CONSENT';
  if (!customer) {
    const unknownId = await withTenantDb(organizationId, (db) =>
      claimMessageLogInTransaction(db, {
        organizationId,
        direction: 'INBOUND',
        status: 'RECEIVED',
        kind,
        dedupeKey: `in:${message.providerMessageId}`,
        customerId: null,
        phoneLast4: last4,
        providerMessageId: message.providerMessageId,
      })
    );
    if (!unknownId) return 'DUPLICATE';
    await updateMessageLog(organizationId, unknownId, { status: 'IGNORED' });
    return 'UNKNOWN_SENDER';
  }
  const age = now.getTime() - message.receivedAt.getTime();
  const inReplyWindow = Number.isFinite(age) && age >= 0 && age < 24 * 60 * 60 * 1000;

  const reply = async (
    replyKind: MessageLogKind,
    body: string,
    extra: { orderId?: string; branchId?: string } = {}
  ) => {
    const entry = {
      organizationId,
      kind: replyKind,
      dedupeKey: `out:${message.providerMessageId}`,
      customerId: customer.id,
      phoneLast4: last4,
      ...extra,
    };
    const previous = await withTenantDb(organizationId, (db) =>
      db.pharmacyMessageLog.findFirst({
        where: { organizationId, dedupeKey: entry.dedupeKey, direction: 'OUTBOUND' },
        select: { id: true, status: true },
      })
    );
    if (previous?.status === 'SENT') return 'DUPLICATE';
    const send = () => provider.sendText({ to: message.from, body });
    return previous ? sendClaimedMessage(entry, previous.id, send) : sendAndLog(entry, send);
  };

  if (keyword) {
    const optIn = keyword === 'START';
    // The acknowledgement answers the customer's own consent request; it is the
    // only message sent regardless of the stored flag.
    if (inReplyWindow)
      await reply('CONSENT_ACK', optIn ? WHATSAPP_REPLIES.optedIn : WHATSAPP_REPLIES.optedOut);
    return optIn ? 'OPTED_IN' : 'OPTED_OUT';
  }

  const claimWithoutOrder = () =>
    withTenantDb(organizationId, (db) =>
      claimMessageLogInTransaction(db, {
        organizationId,
        direction: 'INBOUND',
        status: 'RECEIVED',
        kind,
        dedupeKey: `in:${message.providerMessageId}`,
        customerId: customer?.id ?? null,
        phoneLast4: last4,
        providerMessageId: message.providerMessageId,
      })
    );

  if (!inReplyWindow) {
    const ignoredId = await claimWithoutOrder();
    if (!ignoredId) return 'DUPLICATE';
    await updateMessageLog(organizationId, ignoredId, {
      status: 'IGNORED',
      error: 'EXPIRED_MESSAGE',
    });
    return 'EXPIRED_MESSAGE';
  }

  if (!canMessageCustomer(customer)) {
    const ignoredId = await claimWithoutOrder();
    if (!ignoredId) return 'DUPLICATE';
    await updateMessageLog(organizationId, ignoredId, { status: 'IGNORED' });
    return 'NO_CONSENT';
  }

  const claimOrderRequest = (db: ScopedDb) =>
    claimMessageLogInTransaction(db, {
      organizationId,
      direction: 'INBOUND',
      status: 'RECEIVED',
      kind,
      dedupeKey: `in:${message.providerMessageId}`,
      customerId: customer.id,
      phoneLast4: last4,
      providerMessageId: message.providerMessageId,
    });

  const parsed = parseOrderMessage(message.text);
  let result: {
    duplicate: boolean;
    placed: Awaited<ReturnType<typeof placeWhatsAppOrder>>;
  };
  try {
    result = await withTenantDb(
      organizationId,
      async (db) => {
        const claimedId = await claimOrderRequest(db);
        if (!claimedId) {
          const prior = await db.pharmacyMessageLog.findFirst({
            where: { organizationId, dedupeKey: `in:${message.providerMessageId}` },
            select: { orderId: true },
          });
          if (!prior?.orderId) return { duplicate: true as const, placed: null };
          const confirmation = await db.pharmacyMessageLog.findFirst({
            where: { organizationId, dedupeKey: `out:${message.providerMessageId}` },
            select: { status: true },
          });
          if (confirmation?.status === 'SENT') return { duplicate: true as const, placed: null };
          const order = await db.pharmacyCustomerOrder.findFirst({
            where: { organizationId, id: prior.orderId, customerId: customer.id },
            select: {
              id: true,
              branch: { select: { id: true, name: true } },
              lines: { take: 1, select: { medicine: { select: { productName: true } } } },
            },
          });
          if (!order) return { duplicate: true as const, placed: null };
          return {
            duplicate: false as const,
            placed: {
              orderId: order.id,
              branch: order.branch,
              medicine: order.lines[0]?.medicine.productName ?? parsed?.medicine ?? 'medicine',
            },
          };
        }
        const placed = parsed
          ? await placeWhatsAppOrder(db, organizationId, customer, parsed)
          : null;
        if (placed)
          await db.pharmacyMessageLog.update({
            where: { id: claimedId },
            data: { orderId: placed.orderId, branchId: placed.branch.id },
          });
        return { duplicate: false as const, placed };
      },
      { userId: customer.userId ?? undefined }
    );
  } catch (error) {
    if (!(error instanceof PharmacyCustomerOrderError)) throw error;
    const fallbackId = await claimWithoutOrder();
    if (!fallbackId) return 'DUPLICATE';
    result = { duplicate: false as const, placed: null };
  }
  if (result.duplicate) return 'DUPLICATE';
  const placed = result.placed;
  if (!placed || !parsed) {
    await reply('ORDER_FALLBACK', WHATSAPP_REPLIES.fallback);
    return 'PHARMACIST_CALLBACK';
  }
  await reply(
    'ORDER_CONFIRMATION',
    WHATSAPP_REPLIES.confirmation({
      reference: placed.orderId.slice(-6).toUpperCase(),
      quantity: parsed.quantity,
      medicine: placed.medicine,
      branch: placed.branch.name,
    }),
    { orderId: placed.orderId, branchId: placed.branch.id }
  );
  return 'ORDER_PLACED';
}
