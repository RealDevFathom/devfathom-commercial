import { hasModule } from '@/lib/entitlements';
import { publicRequestOrigin } from '@/lib/http-origin';
import {
  OWNER_DATA_EXPORT_JOB_SELECT as JOB_SELECT,
  OWNER_DATA_EXPORT_JOB_TYPE,
  isLiveOrganizationOwner,
  listOwnerDataExports,
  ownerDataExportView as exportView,
  parseSalesRange,
  readOwnerDataExport,
} from '@/lib/pharmacy/owner-data-export';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { recordAudit } from '@/server/audit';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';

/**
 * DEV-93 — the owner's "Download my data" export.
 *
 * POST queues the export as a platform job; GET lists this workspace's exports,
 * and GET ?job=<id> downloads a finished archive for 24 hours after it was built.
 * Every call needs the live owner identity (the system Owner role, or an ADMIN
 * with an all-capability grant), read from the database, never the session role.
 * A support session is refused: the export is the owner's own data. Each request
 * and download is audit-logged, and nothing is released if the audit fails.
 */

export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;
const PATH = '/api/pharmacy/data-export';
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  try {
    return (
      origin !== null &&
      new URL(origin).origin.toLowerCase() === publicRequestOrigin(request) &&
      (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none')
    );
  } catch {
    return false;
  }
}

type OwnerContext = { ctx: TRPCContext; organizationId: string; userId: string };

async function ownerContext(
  request: Request
): Promise<{ owner: OwnerContext } | { denied: Response; ctx?: TRPCContext }> {
  const actor = await resolveTenantActor({ request });
  if (!actor?.session?.user?.id) {
    return { denied: json(401, { error: 'Sign in to download your data.' }) };
  }
  const ctx = await createTRPCContext({
    req: request,
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  const user = ctx.session?.user;
  const organizationId = ctx.organization?.id;
  const forbidden = json(403, { error: 'Only the pharmacy owner can export all data.' });
  if (
    !user?.id ||
    !organizationId ||
    ctx.entitlements.organizationId !== organizationId ||
    user.isSupportSession ||
    !hasModule(ctx.entitlements, 'pharmacy-core') ||
    !(await isLiveOrganizationOwner(ctx.db, organizationId, user.id))
  ) {
    return { denied: forbidden, ctx };
  }
  return { owner: { ctx, organizationId, userId: user.id } };
}

async function audit(
  ctx: TRPCContext,
  input: {
    method: 'GET' | 'POST';
    action: string;
    operation: 'READ' | 'CREATE';
    status: number;
    metadata: Record<string, unknown>;
  }
) {
  const organizationId = ctx.organization?.id ?? ctx.entitlements.organizationId;
  if (!organizationId) return;
  await recordAudit(
    {
      organizationId,
      actorType: 'USER',
      actorId: ctx.session?.user?.id,
      actorRole: ctx.session?.user?.role,
      source: 'SYSTEM',
      category: 'PHARMACY_DATA_EXPORT',
      operation: input.operation,
      action: input.action,
      path: PATH,
      httpMethod: input.method,
      statusCode: input.status,
      outcome: input.status < 400 ? 'SUCCESS' : 'FAILURE',
      ip: ctx.requestMeta.ip,
      userAgent: ctx.requestMeta.userAgent,
      metadata: { ...input.metadata, attemptedAt: new Date().toISOString() },
    },
    ctx.db
  );
}

export async function GET(request: Request) {
  const resolved = await ownerContext(request);
  const jobId = new URL(request.url).searchParams.get('job');
  if ('denied' in resolved) {
    if (resolved.ctx) {
      try {
        await audit(resolved.ctx, {
          method: 'GET',
          action: jobId ? 'pharmacy.dataExport.download' : 'pharmacy.dataExport.list',
          operation: 'READ',
          status: resolved.denied.status,
          metadata: { jobId: jobId?.slice(0, 128) ?? null },
        });
      } catch {
        return json(503, { error: 'The export could not be recorded. Try again.' });
      }
    }
    return resolved.denied;
  }
  const { ctx, organizationId } = resolved.owner;
  const now = Date.now();

  if (jobId === null) {
    return json(200, { exports: await listOwnerDataExports(organizationId, now) });
  }

  let response: Response;
  let archive: Buffer | null = null;
  if (!JOB_ID.test(jobId)) {
    response = json(400, { error: 'That export link is not valid.' });
  } else {
    const job = await withPlatformDb((db) =>
      db.platformJob.findFirst({
        where: { id: jobId, organizationId, type: OWNER_DATA_EXPORT_JOB_TYPE },
        select: JOB_SELECT,
      })
    );
    const view = job ? exportView(job, now) : null;
    if (!view) response = json(404, { error: 'That export does not exist.' });
    else if (view.status !== 'SUCCEEDED') {
      response = json(409, { error: 'That export is not ready yet.', export: view });
    } else if (!view.downloadable) {
      response = json(410, { error: 'That export link has expired. Request a new export.' });
    } else {
      try {
        archive = await readOwnerDataExport(organizationId, jobId);
        response = new Response(new Uint8Array(archive), {
          headers: {
            ...NO_STORE,
            'Content-Type': 'application/zip',
            'Content-Length': String(archive.length),
            'Content-Disposition': `attachment; filename="devfathom-data-export-${view.finishedAt!.slice(0, 10)}.zip"`,
          },
        });
      } catch {
        response = json(410, { error: 'That export is no longer stored. Request a new export.' });
      }
    }
  }

  try {
    // Await the scoped write: never release the archive if its audit cannot persist.
    await audit(ctx, {
      method: 'GET',
      action: 'pharmacy.dataExport.download',
      operation: 'READ',
      status: response.status,
      metadata: { jobId: jobId.slice(0, 128), bytes: archive?.length ?? null },
    });
  } catch {
    return json(503, { error: 'The download could not be recorded. Try again.' });
  }
  return response;
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json(403, { error: 'Forbidden' });
  const resolved = await ownerContext(request);
  if ('denied' in resolved) {
    if (resolved.ctx) {
      try {
        await audit(resolved.ctx, {
          method: 'POST',
          action: 'pharmacy.dataExport.request',
          operation: 'CREATE',
          status: resolved.denied.status,
          metadata: {},
        });
      } catch {
        return json(503, { error: 'The export could not be recorded. Try again.' });
      }
    }
    return resolved.denied;
  }
  const { ctx, organizationId, userId } = resolved.owner;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const range = parseSalesRange(
    body && typeof body === 'object' ? (body as { from?: unknown; to?: unknown }) : {}
  );
  if (!range) {
    return json(400, { error: 'Choose a valid sales date range (from on or before to).' });
  }

  const now = Date.now();
  const { job, created } = await withPlatformDb(async (db) => {
    // One export at a time per workspace: a second click returns the one in flight.
    const pending = await db.platformJob.findFirst({
      where: {
        organizationId,
        type: OWNER_DATA_EXPORT_JOB_TYPE,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      orderBy: { createdAt: 'desc' },
      select: JOB_SELECT,
    });
    if (pending) return { job: pending, created: false };
    const queued = await db.platformJob.create({
      data: {
        organizationId,
        type: OWNER_DATA_EXPORT_JOB_TYPE,
        requestedById: userId,
        payload: { from: range.from, to: range.to, requestedByTenant: true },
      },
      select: JOB_SELECT,
    });
    return { job: queued, created: true };
  });

  const status = created ? 202 : 200;
  try {
    await audit(ctx, {
      method: 'POST',
      action: 'pharmacy.dataExport.request',
      operation: 'CREATE',
      status,
      metadata: { jobId: job.id, from: range.from, to: range.to, alreadyQueued: !created },
    });
  } catch {
    return json(503, { error: 'The export could not be recorded. Try again.' });
  }
  return json(status, { export: exportView(job, now) });
}
