import { TRPCError } from '@trpc/server';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyPrescriptionsRouter } from '@/server/routers/pharmacy-prescriptions';

export const runtime = 'nodejs';

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
    const file = await pharmacyPrescriptionsRouter.createCaller(context).readSource({
      sourceFileRef: `/api/pharmacy/prescription-files?id=${id}`,
    });
    return new Response(new Uint8Array(Buffer.from(file.dataBase64, 'base64')), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    const status =
      error instanceof TRPCError
        ? ((
            { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404 } as Record<
              string,
              number
            >
          )[error.code] ?? 500)
        : 500;
    return new Response(
      status === 500 ? 'Prescription storage unavailable.' : 'Prescription image unavailable.',
      {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
      }
    );
  }
}
