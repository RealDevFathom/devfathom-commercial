import { hasModule } from '@/lib/entitlements';
import { publicRequestOrigin } from '@/lib/http-origin';
import {
  OWNER_DATA_EXPORT_DOWNLOAD_LIMIT,
  OWNER_DATA_EXPORT_DOWNLOAD_WINDOW_MS,
  OWNER_DATA_EXPORT_JOB_SELECT as JOB_SELECT,
  OWNER_DATA_EXPORT_JOB_TYPE,
  isLiveOrganizationOwner,
  listOwnerDataExports,
  ownerDataExportView as exportView,
  parseSalesRange,
  queueOwnerDataExport,
  streamOwnerDataExport,
} from '@/lib/pharmacy/owner-data-export';
import {
  auditOwnerDataExport,
  type OwnerDataExportAuditAction,
} from '@/lib/pharmacy/owner-data-export-audit';
import {
  readOwnerExportPin,
  verifyOwnerExportPin,
  type OwnerExportPinResult,
} from '@/lib/pharmacy/owner-data-export-pin';
import { rateLimit } from '@/lib/rate-limit';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';

/**
 * DEV-93 — the owner's "Download my data" export.
 *
 * GET lists this workspace's exports. POST queues an export, or with
 * `action: "download"` streams a finished archive for 24 hours after it was
 * built. Every call needs the live owner identity (the system Owner role, or an
 * ADMIN with an all-capability grant), read from the database, never the
 * session role. A support session is refused: the export is the owner's own data.
 *
 * DEV-783 — requesting and downloading also need the owner's own PIN, sent in
 * the POST body (never in a URL, where it would reach logs and history). Wrong
 * PINs strike the shared operator lockout. Each owner may queue a limited number
 * of exports per day, and download a limited number of archives per hour
 * (DEV-844). Every list, request and download, refusals and wrong PINs
 * included, is audit-logged, and nothing is released if the audit fails.
 */

export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;
const PATH = '/api/pharmacy/data-export';
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

const PIN_REFUSAL: Record<Exclude<OwnerExportPinResult, 'OK'>, () => Response> = {
  NO_PIN: () =>
    json(403, {
      error: 'Set a personal PIN on your staff profile before exporting data.',
      code: 'PIN_NOT_SET',
    }),
  REJECTED: () => json(401, { error: 'That PIN is not correct.', code: 'PIN_REJECTED' }),
  LOCKED: () =>
    json(423, {
      error: 'Too many wrong PINs. Your PIN is locked for 15 minutes.',
      code: 'PIN_LOCKED',
    }),
};

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

type AuditTarget = {
  method: 'GET' | 'POST';
  action: OwnerDataExportAuditAction;
  operation: 'READ' | 'CREATE';
};

/**
 * Audit, then release. The scoped write is awaited: when it fails the caller
 * gets a 503 and an archive stream is cancelled unread.
 */
async function audited(
  ctx: TRPCContext | undefined,
  target: AuditTarget,
  response: Response,
  metadata: Record<string, unknown>
): Promise<Response> {
  if (!ctx) return response;
  try {
    await auditOwnerDataExport(ctx, { ...target, path: PATH, status: response.status, metadata });
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return json(503, { error: 'The export could not be recorded. Try again.' });
  }
  return response;
}

const LIST: AuditTarget = { method: 'GET', action: 'pharmacy.dataExport.list', operation: 'READ' };
const REQUEST: AuditTarget = {
  method: 'POST',
  action: 'pharmacy.dataExport.request',
  operation: 'CREATE',
};
const DOWNLOAD: AuditTarget = {
  method: 'POST',
  action: 'pharmacy.dataExport.download',
  operation: 'READ',
};

export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get('job');
  const resolved = await ownerContext(request);
  const target: AuditTarget = jobId === null ? LIST : { ...DOWNLOAD, method: 'GET' };
  const metadata = { jobId: jobId?.slice(0, 128) ?? null };
  if ('denied' in resolved) return audited(resolved.ctx, target, resolved.denied, metadata);
  const { ctx, organizationId } = resolved.owner;

  if (jobId !== null) {
    // A link cannot carry the PIN, so it can no longer download an archive.
    return audited(
      ctx,
      target,
      json(
        405,
        { error: 'Re-enter your PIN on the Download my data page to download this export.' },
        { Allow: 'POST' }
      ),
      metadata
    );
  }
  const exports = await listOwnerDataExports(organizationId, Date.now());
  return audited(ctx, LIST, json(200, { exports }), { via: 'api', count: exports.length });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json(403, { error: 'Forbidden' });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const download = body.action === 'download';
  const target = download ? DOWNLOAD : REQUEST;
  const jobId = download && typeof body.job === 'string' ? body.job : null;
  const jobMetadata = download ? { jobId: jobId?.slice(0, 128) ?? null } : {};

  const resolved = await ownerContext(request);
  if ('denied' in resolved) return audited(resolved.ctx, target, resolved.denied, jobMetadata);
  const { ctx, organizationId, userId } = resolved.owner;

  const range = download ? null : parseSalesRange(body as { from?: unknown; to?: unknown });
  if (download ? jobId === null || !JOB_ID.test(jobId) : !range) {
    const error = download
      ? 'That export link is not valid.'
      : 'Choose a valid sales date range (from on or before to).';
    return audited(ctx, target, json(400, { error }), jobMetadata);
  }

  const pin = readOwnerExportPin(body.pin);
  if (pin === null) {
    return audited(
      ctx,
      target,
      json(400, { error: 'Enter your PIN to continue.', code: 'PIN_REQUIRED' }),
      { ...jobMetadata, pinCheck: 'MISSING' }
    );
  }
  const pinCheck = await verifyOwnerExportPin({ organizationId, userId, pin });
  if (pinCheck !== 'OK') {
    return audited(ctx, target, PIN_REFUSAL[pinCheck](), { ...jobMetadata, pinCheck });
  }

  if (download) {
    // Counted only after the PIN is accepted, so nobody without it can use up
    // the owner's downloads.
    const limited = await rateLimit(
      `owner-data-export-download:${organizationId}:${userId}`,
      OWNER_DATA_EXPORT_DOWNLOAD_LIMIT,
      OWNER_DATA_EXPORT_DOWNLOAD_WINDOW_MS
    );
    if (!limited.ok) {
      return audited(
        ctx,
        DOWNLOAD,
        json(
          429,
          { error: 'Too many downloads of your data export. Try again later.' },
          { 'Retry-After': String(Math.max(1, limited.retryAfter)) }
        ),
        { ...jobMetadata, pinCheck, rateLimited: true }
      );
    }
    return downloadExport(ctx, organizationId, jobId!);
  }

  const now = new Date();
  const queued = await withPlatformDb((db) =>
    queueOwnerDataExport(db, { organizationId, userId, range: range!, now })
  );
  if (queued.kind === 'rate_limited') {
    return audited(
      ctx,
      REQUEST,
      json(
        429,
        { error: 'You have reached the daily limit for data exports. Try again later.' },
        { 'Retry-After': String(queued.retryAfterSeconds) }
      ),
      { from: range!.from, to: range!.to, pinCheck, rateLimited: true }
    );
  }
  const created = queued.kind === 'created';
  return audited(
    ctx,
    REQUEST,
    json(created ? 202 : 200, { export: exportView(queued.job, now.getTime()) }),
    {
      jobId: queued.job.id,
      from: range!.from,
      to: range!.to,
      alreadyQueued: !created,
      pinCheck,
    }
  );
}

async function downloadExport(
  ctx: TRPCContext,
  organizationId: string,
  jobId: string
): Promise<Response> {
  const now = Date.now();
  const job = await withPlatformDb((db) =>
    db.platformJob.findFirst({
      where: { id: jobId, organizationId, type: OWNER_DATA_EXPORT_JOB_TYPE },
      select: JOB_SELECT,
    })
  );
  const view = job ? exportView(job, now) : null;
  let response: Response;
  let bytes: number | null = null;
  if (!view) response = json(404, { error: 'That export does not exist.' });
  else if (view.status !== 'SUCCEEDED') {
    response = json(409, { error: 'That export is not ready yet.', export: view });
  } else if (!view.downloadable) {
    response = json(410, { error: 'That export link has expired. Request a new export.' });
  } else {
    try {
      const archive = await streamOwnerDataExport(organizationId, job!);
      bytes = archive.size;
      response = new Response(archive.body, {
        headers: {
          ...NO_STORE,
          'Content-Type': 'application/zip',
          ...(archive.size === null ? {} : { 'Content-Length': String(archive.size) }),
          'Content-Disposition': `attachment; filename="devfathom-data-export-${view.finishedAt!.slice(0, 10)}.zip"`,
        },
      });
    } catch {
      response = json(410, { error: 'That export is no longer stored. Request a new export.' });
    }
  }
  return audited(ctx, DOWNLOAD, response, { jobId, bytes, pinCheck: 'OK' });
}
