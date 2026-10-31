import 'server-only';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  requestHost,
  resolveExplicitOrganizationByHost,
  isTenantLifecycleAccessible,
} from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { customerPortalCommand } from './customer-portal-contract';
import { customerSmsConfigured, sendCustomerSms } from './customer-otp-delivery';
import { normalizeWhatsAppNumber } from './whatsapp/messages';
import {
  consumePortalOtp,
  createPortalRequest,
  CustomerPortalError,
  customerPortalScope,
  customerPortalSummary,
  issuePortalOtp,
  portalHash,
  portalReceipt,
  portalEvent,
} from './customer-portal';

export const portalCookieName = () =>
  process.env.NODE_ENV === 'production' ? '__Secure-df_customer' : 'df_customer';
export function portalCookie(token: string, maxAge: number) {
  return `${portalCookieName()}=${token}; Path=/api/pharmacy/customer; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export function customerToken(request: Request) {
  const entries = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim().split('='));
  return entries.find(([name]) => name === portalCookieName())?.[1] ?? null;
}
export const portalJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });

export function assertPortalOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const authority =
    request.headers.get('x-devfathom-host') ??
    request.headers.get('host') ??
    new URL(request.url).host;
  try {
    if (
      origin &&
      new URL(origin).host.toLowerCase() === authority.toLowerCase() &&
      request.headers.get('sec-fetch-site') !== 'cross-site'
    )
      return;
  } catch {
    /* deny */
  }
  throw new CustomerPortalError(403, 'Open this form on the pharmacy’s own link.');
}

export async function portalBody(request: Request, maxBytes = 7 * 1024 * 1024) {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new CustomerPortalError(400, 'Submit the form as JSON.');
  const reader = request.body?.getReader();
  if (!reader) throw new CustomerPortalError(400, 'The form is empty.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CustomerPortalError(413, 'The image is too large. Use an image up to 5 MiB.');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof CustomerPortalError) throw error;
    throw new CustomerPortalError(400, 'The form could not be read.');
  } finally {
    reader.releaseLock();
  }
}

export async function portalOrganization(request: Request) {
  const org = await resolveExplicitOrganizationByHost(requestHost(request));
  if (!org || !isTenantLifecycleAccessible(org.status))
    throw new CustomerPortalError(404, 'Open the link provided by your pharmacy.');
  const enabled = await withTenantDb(org.id, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(org.id, db);
    return (
      hasModule(entitlements, 'pharmacy-crm') && hasModule(entitlements, 'pharmacy-dispensing')
    );
  });
  if (!enabled)
    throw new CustomerPortalError(403, 'Customer service is unavailable. Contact the pharmacy.');
  return org;
}

export function portalFailure(error: unknown) {
  if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
    return portalJson({ error: error.message }, 400);
  return error instanceof CustomerPortalError
    ? portalJson({ error: error.message }, error.status)
    : portalJson({ error: 'Customer service could not be reached. Please retry.' }, 503);
}

async function admit(request: Request) {
  for (const [key, limit] of [
    ['global', 600],
    [`ip:${clientIp(request)}`, 60],
  ] as const) {
    const result = await rateLimit(`customer-portal:${key}`, limit, 60_000);
    if (!result.ok) throw new CustomerPortalError(429, 'Please wait a minute before trying again.');
  }
}

export async function customerPortalGET(request: Request) {
  try {
    await admit(request);
    const org = await portalOrganization(request);
    return await withTenantDb(org.id, async (db) => {
      const token = customerToken(request);
      if (!token) {
        const branches = await db.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
          SELECT b.id, b.name FROM pharmacy_branches b JOIN pharmacy_customer_portal_settings s
          ON s."organizationId"=b."organizationId" AND s."branchId"=b.id
          WHERE b."organizationId"=${org.id} AND b.active AND s.config->>'enabled'='true' ORDER BY b.name, b.id`);
        return portalJson({
          signedIn: false,
          pharmacyName: org.displayName,
          branches,
          smsAvailable: customerSmsConfigured(org.id),
        });
      }
      const scope = await customerPortalScope(db, org.id, token);
      const saleId = new URL(request.url).searchParams.get('receipt');
      if (saleId) return portalJson(await portalReceipt(db, scope, saleId, org.currency));
      return portalJson({
        signedIn: true,
        summary: await customerPortalSummary(db, scope, org.currency),
      });
    });
  } catch (error) {
    const response = portalFailure(error);
    if (error instanceof CustomerPortalError && error.status === 401)
      response.headers.set('Set-Cookie', portalCookie('', 0));
    return response;
  }
}

export async function customerPortalPOST(request: Request) {
  try {
    assertPortalOrigin(request);
    await admit(request);
    const parsed = customerPortalCommand.safeParse(await portalBody(request));
    if (!parsed.success) throw new CustomerPortalError(400, 'Check the form fields and try again.');
    const input = parsed.data;
    const org = await portalOrganization(request);
    if (input.action === 'start') {
      if (!customerSmsConfigured(org.id))
        throw new CustomerPortalError(503, 'SMS sign-in is unavailable. Contact the pharmacy.');
      const phone = normalizeWhatsAppNumber(input.phone);
      const gate = await rateLimit(
        `customer-otp:${org.id}:${portalHash(phone ?? input.phone)}`,
        3,
        10 * 60_000
      );
      if (!gate.ok)
        throw new CustomerPortalError(429, 'Please wait before requesting another code.');
      const challengeId = randomUUID();
      const delivery = await withTenantDb(org.id, (db) =>
        issuePortalOtp(db, org.id, input.branchId, input.phone, challengeId)
      );
      if (delivery) {
        try {
          await sendCustomerSms(org.id, delivery.phone, delivery.code);
        } catch {
          await withTenantDb(org.id, async (db) => {
            await db.$executeRaw(
              Prisma.sql`UPDATE pharmacy_customer_otp_challenges SET "consumedAt"=CURRENT_TIMESTAMP WHERE id=${challengeId} AND "organizationId"=${org.id}`
            );
          });
        }
      }
      return portalJson(
        {
          challengeId,
          message: 'If this number is registered with the pharmacy, a code is on its way.',
        },
        202
      );
    }
    if (input.action === 'verify') {
      const gate = await rateLimit(
        `customer-otp-attempt:${org.id}:${input.challengeId}`,
        10,
        30 * 60_000
      );
      if (!gate.ok) throw new CustomerPortalError(429, 'Request a new code and try again later.');
      const session = await withTenantDb(org.id, (db) =>
        consumePortalOtp(db, org.id, input.challengeId, input.code)
      );
      if (!session)
        throw new CustomerPortalError(
          400,
          'The code is invalid, expired or already used. Request a new code.'
        );
      return portalJson({ ok: true }, 200, {
        'Set-Cookie': portalCookie(session.token, session.maxAge),
      });
    }
    return await withTenantDb(org.id, async (db) => {
      const token = customerToken(request);
      // Expired sessions can always clear their cookie; only valid ones write an identity audit.
      if (input.action === 'logout') {
        if (token)
          await db.$executeRaw(
            Prisma.sql`UPDATE pharmacy_customer_sessions SET "revokedAt"=CURRENT_TIMESTAMP WHERE "organizationId"=${org.id} AND "tokenHash"=${portalHash(token)}`
          );
        return portalJson({ ok: true }, 200, { 'Set-Cookie': portalCookie('', 0) });
      }
      const scope = await customerPortalScope(db, org.id, token);
      const gate = await rateLimit(
        `customer-request:${org.id}:${scope.customerId}`,
        10,
        60 * 60_000
      );
      if (!gate.ok)
        throw new CustomerPortalError(429, 'Please wait before submitting another request.');
      const result = await createPortalRequest(db, scope, input);
      await portalEvent(db, scope, 'REQUEST_SUBMITTED', `customer:${scope.customerId}`, result.id);
      return portalJson(result, 201);
    });
  } catch (error) {
    return portalFailure(error);
  }
}
