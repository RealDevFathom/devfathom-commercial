import 'server-only';
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { decryptSecret } from '@/lib/secret-crypto';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { handleInboundWhatsAppMessage } from './inbound';
import { bindWhatsAppTenant, createWhatsAppProvider, type WhatsAppConfig } from './provider';
import { WahaClient, wahaMessageId } from './waha-client';
import { readWahaSession, selectorOrganization } from './waha-session';

const dummy = randomBytes(48);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function authenticateWaha(
  raw: Uint8Array,
  headers: Headers,
  key: string | Buffer,
  now = Date.now()
) {
  const signature = headers.get('x-webhook-hmac') ?? '';
  const stamp = headers.get('x-webhook-timestamp') ?? '';
  if (
    headers.get('x-webhook-hmac-algorithm') !== 'sha512' ||
    !/^[0-9a-f]{128}$/i.test(signature) ||
    !/^\d{13}$/.test(stamp) ||
    Math.abs(now - Number(stamp)) > 300000 ||
    !/^[\w.-]{1,128}$/.test(headers.get('x-webhook-request-id') ?? '')
  )
    return false;
  return timingSafeEqual(
    createHmac('sha512', key).update(raw).digest(),
    Buffer.from(signature, 'hex')
  );
}
const identifier = z.string().min(1).max(1024);
const envelope = z.object({
  id: identifier,
  timestamp: z.number().int().positive().max(8640000000000000),
  session: z.string(),
  event: z.string(),
  payload: z.unknown(),
  me: z.object({ id: z.string() }).nullish(),
});
const ackSchema = z.object({
  id: identifier,
  fromMe: z.literal(true),
  ack: z.union([z.literal(2), z.literal(3)]),
});
const messageSchema = z.object({
  id: identifier,
  fromMe: z.literal(false),
  from: z.string().regex(/^(?:[1-9]\d{7,14}@c\.us|\d{6,20}@lid)$/),
  body: z.string().min(1).max(1000),
  timestamp: z.number().int().positive().max(8640000000000),
});
const statusSchema = z.object({
  name: z.string(),
  status: z.enum([
    'WORKING',
    'SCAN_QR_CODE',
    'STOPPED',
    'STARTING',
    'FAILED',
    'PASSKEY_REQUIRED',
    'PASSKEY_CONFIRMATION_REQUIRED',
  ]),
  data: z
    .object({
      reachoutTimelock: z.object({ isActive: z.boolean() }).nullish(),
      messageCapping: z.object({ cappingStatus: z.string() }).nullish(),
    })
    .nullish(),
});
export function parseWahaEvent(raw: Buffer, session: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = envelope.safeParse(value);
  if (!parsed.success || parsed.data.session !== session) return null;
  const { id, timestamp, event, payload, me } = parsed.data;
  const base = { eventKey: digest(id), occurredAt: new Date(timestamp) };
  if (event === 'message.ack') {
    const ack = ackSchema.safeParse(payload);
    if (ack.success) {
      const messageId = wahaMessageId(ack.data.id);
      return {
        ...base,
        kind: 'ack' as const,
        messageId,
        ack: ack.data.ack,
        semanticKey: digest(messageId + ':' + ack.data.ack),
      };
    }
  }
  if (event === 'message') {
    const msg = messageSchema.safeParse(payload);
    if (msg.success) {
      const data = msg.data;
      const messageId = wahaMessageId(data.id);
      return {
        ...base,
        kind: 'message' as const,
        lid: data.from.endsWith('@lid') ? data.from : null,
        semanticKey: digest('in:' + messageId),
        message: {
          providerMessageId: messageId,
          from: data.from.split('@')[0],
          text: data.body,
          receivedAt: new Date(data.timestamp * 1000),
          phoneNumberId: session,
        },
      };
    }
  }
  if (event === 'session.status') {
    const state = statusSchema.safeParse(payload);
    if (state.success && state.data.name === session) {
      return {
        ...base,
        kind: 'status' as const,
        semanticKey: base.eventKey,
        status: state.data.status,
        number:
          state.data.status === 'WORKING'
            ? (me?.id.match(/^(\d{8,15})(?::\d+)?@c\.us$/)?.[1] ?? null)
            : null,
        restriction:
          state.data.data?.messageCapping?.cappingStatus === 'CAPPED'
            ? 475
            : state.data.data?.reachoutTimelock?.isActive
              ? 463
              : null,
      };
    }
    if (state.success) return null;
  }
  return { ...base, kind: 'ignore' as const, semanticKey: base.eventKey };
}
export async function receiveWahaEvent(
  raw: Buffer,
  headers: Headers,
  selector: string,
  config: WhatsAppConfig
) {
  const organizationId = selectorOrganization(selector);
  let session = null;
  let key: string | Buffer = dummy;
  if (organizationId) {
    try {
      const candidate = await withTenantDb(organizationId, (db) =>
        readWahaSession(db, organizationId)
      );
      if (candidate?.selector === selector) {
        key = decryptSecret(candidate.encryptedWebhookSecret);
        session = candidate;
      }
    } catch {
      /* Return the same authentication response as an unknown selector. */
    }
  }
  const bound = session !== null;
  const ok = authenticateWaha(raw, headers, key);
  if (!ok || !bound || !organizationId) return 401;
  const event = parseWahaEvent(raw, session.sessionName);
  if (!event) return 400;
  if (event.kind === 'ignore') return 200;
  const provider = createWhatsAppProvider(bindWhatsAppTenant(config, organizationId));
  return withTenantDb(organizationId, async (db) => {
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { isDemo: true, status: true, vertical: true },
    });
    if (
      !org ||
      org.isDemo ||
      org.vertical !== 'PHARMACY' ||
      !isTenantLifecycleAccessible(org.status)
    )
      return 403;
    const messageId = event.kind === 'ack' ? event.messageId : null;
    const ack = event.kind === 'ack' ? event.ack : null;
    const requestKey = digest(event.eventKey + ':' + headers.get('x-webhook-request-id')!);
    if (messageId)
      await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId + messageId},0))`;
    const inserted =
      await db.$executeRaw`INSERT INTO pharmacy_waha_events ("organizationId","eventKey","requestKey","semanticKey","providerMessageId",ack)
    VALUES (${organizationId},${event.eventKey},${requestKey},${event.semanticKey},${messageId},${ack}) ON CONFLICT DO NOTHING`;
    if (!inserted) return 200;
    if (event.kind === 'message') {
      const from = event.lid
        ? await new WahaClient(
            session.sessionName,
            decryptSecret(session.encryptedApiKey)
          ).phoneForLid(event.lid)
        : event.message.from;
      if (from)
        await handleInboundWhatsAppMessage(organizationId, provider, { ...event.message, from });
    }
    if (event.kind === 'ack')
      await db.$executeRaw`UPDATE pharmacy_message_logs SET "wahaAck"=greatest("wahaAck",${event.ack}::smallint)
      WHERE "organizationId"=${organizationId} AND direction='OUTBOUND' AND "providerMessageId"=${messageId}`;
    if (event.kind === 'status')
      await db.$executeRaw`UPDATE pharmacy_waha_sessions SET status=${event.status},"statusAt"=${event.occurredAt},"connectedNumber"=${event.number},
      "restrictionCode"=COALESCE("restrictionCode",${event.restriction}::int)
      WHERE "organizationId"=${organizationId} AND ("statusAt" IS NULL OR "statusAt"<=${event.occurredAt})`;
    return 200;
  });
}
