import { TRPCError } from '@trpc/server';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyDataExportRouter } from '@/server/routers/pharmacy-data-export';

export const runtime = 'nodejs';

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
};

/**
 * #716 — download one owner data export archive. Authorization is the router's
 * (`adminProcedure` + owner checks + 24-hour expiry); this route only turns
 * the bytes into an attachment response that is never cached.
 */
export async function GET(request: Request) {
  try {
    const actor = await resolveTenantActor({ request });
    if (!actor?.session.user?.id) return new Response('Unauthorized', { status: 401 });
    const context = await createTRPCContext({
      req: request,
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const archive = await pharmacyDataExportRouter.createCaller(context).download({ id });
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
    return new Response(message, {
      status,
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
