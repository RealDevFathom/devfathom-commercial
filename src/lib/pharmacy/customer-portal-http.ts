import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveOrganizationForRequest,
} from '@/lib/tenancy/host';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  cancelPortalRequest,
  portalCodeSender,
  createPortalRequest,
  hashPortalSecret,
  PharmacyPortalError,
  PORTAL_LINK_PATTERN,
  PORTAL_SESSION_COOKIE,
  readPortalHome,
  readPortalSession,
  signOutPortal,
  startPortalSignIn,
  verifyPortalSignIn,
  type PortalSession,
} from './customer-portal';
import { persistPrescriptionFile } from './prescription-files';
import { createWhatsAppProvider, readWhatsAppConfig } from './whatsapp/provider';

const MAX_BODY_CHARS = 7_500_000;
const TEN_MINUTES = 10 * 60_000;

type Json = Record<string, unknown>;
const json = (body: Json, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });

export const portalResponse = {
  notFound: () => json({ ok: false, message: 'Not found.' }, 404),
  invalid: (message = 'This request could not be completed.') => json({ ok: false, message }, 400),
  signedOut: () => json({ ok: false, message: 'Please sign in again.' }, 401),
  limited: (retryAfter: number) =>
    json({ ok: false, message: 'Please wait before trying again.' }, 429, {
      'Retry-After': String(Math.max(1, retryAfter)),
    }),
};

const tokenSchema = z.string().regex(PORTAL_LINK_PATTERN);
const note = z.string().trim().max(500).optional();
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('REFILL'), saleId: z.string().trim().min(1).max(128), note }).strict(),
  z
    .object({
      kind: z.literal('RX_ORDER'),
      contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      dataBase64: z.string().min(1),
      note,
    })
    .strict(),
  z
    .object({
      kind: z.literal('KHATA_PAYMENT'),
      familyAccountId: z.string().trim().min(1).max(128),
      amountMinor: z.number().int().positive().max(2147483647),
      // Last 4–6 digits of the Raast transaction ID, as at the counter.
      payerReference: z.string().regex(/^\d{4,6}$/),
    })
    .strict(),
]);

const PORTAL_ERROR_MESSAGES: Record<PharmacyPortalError['reason'], string> = {
  CUSTOMER_NOT_FOUND: 'This link is no longer active.',
  PHONE_REQUIRED: 'Ask the pharmacy to add your phone number first.',
  LINK_INVALID: 'This link is no longer active.',
  LINK_LOCKED: 'Too many wrong codes. Ask the pharmacy to send you a new link.',
  CODE_INVALID: 'That code is not valid. Request a new code.',
  SEND_FAILED: 'We could not send a code right now. Try again shortly.',
  SALE_NOT_FOUND: 'Choose one of your receipts.',
  ACCOUNT_NOT_FOUND: 'Choose one of your khata accounts.',
  RAAST_NOT_CONFIGURED: 'This pharmacy does not accept Raast payments yet.',
  REQUEST_NOT_FOUND: 'This request can no longer be changed.',
  INVALID_STATE: 'This request can no longer be changed.',
  KIND_NOT_ALLOWED: 'This request could not be completed.',
};

export async function readPortalRequestBody(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => '');
  if (!text || text.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

function sessionCookie(request: Request, value: string, expires: Date) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${PORTAL_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}

async function gate(keys: Array<[string, number]>): Promise<number | null> {
  for (const [key, limit] of keys) {
    const result = await rateLimit(`pharmacy-portal:${key}`, limit, TEN_MINUTES);
    if (!result.ok) return result.retryAfter;
  }
  return null;
}

/**
 * Resolves the pharmacy tenant from the host. Returns null for a shared host, a
 * cross-origin browser request, an inaccessible tenant or one without pharmacy.
 */
export async function portalContext(request: Request) {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== requestHost(request)) return null;
    } catch {
      return null;
    }
  }
  const organization = await resolveOrganizationForRequest(request);
  if (!organization || !isTenantLifecycleAccessible(organization.status)) return null;
  const organizationId = organization.id;
  const licensed = await withTenantDb(organizationId, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(organizationId, db);
    return hasModule(entitlements, 'pharmacy-counter');
  });
  if (!licensed) return null;
  const ip = clientIp(request);

  const inTenant = <T>(run: (db: ScopedDb) => Promise<T>) => withTenantDb(organizationId, run);
  const withSession = async (run: (db: ScopedDb, session: PortalSession) => Promise<Response>) =>
    inTenant(async (db) => {
      const session = await readPortalSession(
        db,
        organizationId,
        readCookie(request, PORTAL_SESSION_COOKIE)
      );
      return session ? run(db, session) : portalResponse.signedOut();
    });

  async function handle(action: string, body: unknown): Promise<Response> {
    try {
      if (action === 'start') {
        const parsed = z.object({ token: tokenSchema }).strict().safeParse(body);
        if (!parsed.success) return portalResponse.invalid();
        const fingerprint = hashPortalSecret(parsed.data.token).slice(0, 32);
        const blocked = await gate([
          [`ip:${ip}`, 30],
          [`start:${fingerprint}`, 5],
        ]);
        if (blocked) return portalResponse.limited(blocked);
        const config = readWhatsAppConfig();
        const send = portalCodeSender(config, createWhatsAppProvider(config), organizationId);
        const sent = await inTenant((db) =>
          startPortalSignIn(db, organizationId, parsed.data.token, send)
        );
        return json({ ok: true, sentTo: sent.sentTo });
      }
      if (action === 'verify') {
        const parsed = z
          .object({ token: tokenSchema, otp: z.string().regex(/^\d{6}$/) })
          .strict()
          .safeParse(body);
        if (!parsed.success) return portalResponse.invalid();
        const fingerprint = hashPortalSecret(parsed.data.token).slice(0, 32);
        const blocked = await gate([
          [`ip:${ip}`, 30],
          [`verify:${fingerprint}`, 10],
        ]);
        if (blocked) return portalResponse.limited(blocked);
        const result = await inTenant((db) =>
          verifyPortalSignIn(db, organizationId, parsed.data.token, parsed.data.otp)
        );
        if (!result.ok) return portalResponse.invalid(PORTAL_ERROR_MESSAGES.CODE_INVALID);
        return json({ ok: true }, 200, {
          'Set-Cookie': sessionCookie(request, result.sessionToken, result.expiresAt),
        });
      }
      if (action === 'sign-out') {
        await inTenant(async (db) => {
          const session = await readPortalSession(
            db,
            organizationId,
            readCookie(request, PORTAL_SESSION_COOKIE)
          );
          if (session) await signOutPortal(db, session);
        });
        return json({ ok: true }, 200, {
          'Set-Cookie': sessionCookie(request, '', new Date(0)),
        });
      }
      if (action === 'me') {
        return await withSession(async (db, session) =>
          json({ ok: true, home: await readPortalHome(db, session) })
        );
      }
      if (action === 'cancel') {
        const parsed = z
          .object({ requestId: z.string().trim().min(1).max(128) })
          .strict()
          .safeParse(body);
        if (!parsed.success) return portalResponse.invalid();
        return await withSession(async (db, session) => {
          await cancelPortalRequest(db, session, parsed.data.requestId);
          return json({ ok: true });
        });
      }
      if (action === 'request') {
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success) return portalResponse.invalid();
        const blocked = await gate([[`request-ip:${ip}`, 20]]);
        if (blocked) return portalResponse.limited(blocked);
        const input = parsed.data;
        return await withSession(async (db, session) => {
          if (input.kind !== 'RX_ORDER')
            return json({ ok: true, request: await createPortalRequest(db, session, input) });
          const customer = await db.pharmacyCustomer.findFirst({
            where: { id: session.customerId, organizationId },
            select: { patientId: true },
          });
          if (!customer) return portalResponse.signedOut();
          // Same bounded image checks and private store as staff prescription uploads.
          const file = await persistPrescriptionFile(
            organizationId,
            `portal-customer:${session.customerId}`,
            {
              patientId: customer.patientId,
              contentType: input.contentType,
              dataBase64: input.dataBase64,
            }
          );
          return json({
            ok: true,
            request: await createPortalRequest(db, session, {
              kind: 'RX_ORDER',
              prescriptionFileRef: file.sourceFileRef,
              note: input.note,
            }),
          });
        });
      }
      return portalResponse.notFound();
    } catch (error) {
      if (error instanceof PharmacyPortalError)
        return portalResponse.invalid(PORTAL_ERROR_MESSAGES[error.reason]);
      if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
        return portalResponse.invalid(error.message);
      throw error;
    }
  }

  return { organization, handle };
}
