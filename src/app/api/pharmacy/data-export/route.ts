import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { publicRequestOrigin } from '@/lib/http-origin';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';
import { appRouter } from '@/server/routers/_app';

export const runtime = 'nodejs';

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
};

const NO_STORE = { 'Cache-Control': 'private, no-store', 'Content-Type': 'text/plain; charset=utf-8' };

const body = z.object({ id: z.string(), pin: z.string() }).strict();

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin.toLowerCase() === publicRequestOrigin(request).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The PIN never travels in a URL (it would reach access logs and history), so a
 * plain link cannot download an export any more; the console posts the PIN.
 */
export function GET() {
  return new Response('Re-enter your PIN on the Download my data page to download this export.', {
    status: 405,
    headers: { ...NO_STORE, Allow: 'POST' },
  });
}

/**
 * #716 — download one owner data export archive. Authorization is the router's
 * (`adminProcedure` + Pharmacy Core entitlement + owner checks + PIN re-entry +
 * 24-hour expiry, all audited); this route only accepts a same-origin JSON body
 * and turns the bytes into an attachment response that is never cached.
 */
export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) {
      return new Response('The request origin is not allowed.', { status: 403, headers: NO_STORE });
    }
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response('Export unavailable.', { status: 400, headers: NO_STORE });
    const actor = await resolveTenantActor({ request });
    if (!actor?.session.user?.id) return new Response('Unauthorized', { status: 401 });
    const context = await createTRPCContext({
      req: request,
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    const archive = await appRouter
      .createCaller(context)
      .pharmacyDataExport.download(parsed.data);
    const fileName = archive.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    return new Response(new Uint8Array(archive.data), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(archive.data.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    const status = error instanceof TRPCError ? (STATUS[error.code] ?? 500) : 500;
    const message =
      status === 500
        ? 'Export storage unavailable.'
        : error instanceof TRPCError
          ? error.message
          : 'Export unavailable.';
    return new Response(message, { status, headers: NO_STORE });
  }
}
