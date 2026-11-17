import { NextResponse } from 'next/server';
import { z } from 'zod';

import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import {
  acknowledgePharmacyPrintJob,
  claimNextPharmacyPrintJob,
  parsePharmacyPrintBridgeCredential,
  PRINT_FAILURE_CODES,
  resolvePharmacyPrintBridge,
  touchPharmacyPrintBridge,
  type PharmacyPrintBridge,
} from '@/lib/pharmacy/receipt-print-queue';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { isDeviceUsable } from '@/lib/retail-terminal/device-secret';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-741 — device-only transport for a branch-bound Pharmacy print bridge.
 *
 *   GET  long-polls for the next fresh receipt job of THIS bridge (≤ 20 s).
 *   POST acknowledges what the host transport reported for the claimed attempt.
 *
 * No web session, cookie or user identity is accepted here, and no endpoint
 * accepts printable content: jobs are built server-side from settled sales.
 * The credential's organization part opens the tenant scope; the bridge row is
 * then re-read and revalidated (active, not revoked, branch active, module
 * licensed) on every poll iteration, so revocation applies on the next poll.
 */

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const MAX_WAIT_SECONDS = 20;
const POLL_INTERVAL_MS = 500;

const ackBody = z
  .object({
    jobId: z.string().min(1).max(128),
    claimToken: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['TRANSPORT_ACCEPTED', 'FAILED']),
    failureCode: z.enum(PRINT_FAILURE_CODES).optional(),
  })
  .strict()
  .refine((body) => body.status === 'FAILED' || body.failureCode === undefined, {
    path: ['failureCode'],
  });

class BridgeRequestError extends Error {
  constructor(
    readonly publicMessage: string,
    readonly status: number
  ) {
    super(publicMessage);
  }
}

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers });
}

/** Only the Authorization header counts. Cookies and sessions are ignored. */
function credentialFrom(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  return parsePharmacyPrintBridgeCredential(header.slice('Bearer '.length).trim());
}

/** One short tenant transaction: revalidate the bridge, then run `work`. */
async function withBridge<T>(
  credential: { secret: string; organizationId: string },
  now: Date,
  work: (db: ScopedDb, bridge: PharmacyPrintBridge) => Promise<T>,
  touch = true
): Promise<T> {
  return withTenantDb(credential.organizationId, async (db) => {
    const bridge = await resolvePharmacyPrintBridge(db, credential);
    if (!bridge) throw new BridgeRequestError('Unknown print bridge.', 401);
    if (!isDeviceUsable(bridge))
      throw new BridgeRequestError('This print bridge was revoked.', 403);
    // Recheck under a row lock: revocation may have committed since the
    // credential lookup. Hold this lock through claim/ack in the tenant transaction.
    const active = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM pharmacy_print_bridges
      WHERE id = ${bridge.id} AND "organizationId" = ${bridge.organizationId}
        AND "branchId" = ${bridge.branchId} AND status = 'ACTIVE' AND "revokedAt" IS NULL
      FOR UPDATE`;
    if (active.length !== 1) throw new BridgeRequestError('This print bridge was revoked.', 403);
    if (
      !hasModule(
        await resolveOrganizationEntitlements(credential.organizationId, db),
        'pharmacy-counter'
      )
    ) {
      throw new BridgeRequestError('The pharmacy counter module is not enabled.', 403);
    }
    const branch = await db.pharmacyBranch.findFirst({
      where: { id: bridge.branchId, organizationId: bridge.organizationId, active: true },
      select: { id: true },
    });
    if (!branch) throw new BridgeRequestError('The bridge branch is unavailable.', 403);
    // Health check-in once per request, not once per poll tick.
    if (touch) await touchPharmacyPrintBridge(db, bridge, now);
    return work(db, bridge);
  });
}

async function guarded(request: Request, run: () => Promise<Response>): Promise<Response> {
  try {
    if (!(await rateLimit(`pharmacy-print-bridge:${clientIp(request)}`, 240, 60_000)).ok) {
      return reply({ error: 'Too many requests.' }, 429);
    }
    return await run();
  } catch (error) {
    if (error instanceof BridgeRequestError)
      return reply({ error: error.publicMessage }, error.status);
    // Never echo internals, receipt contents or credentials.
    console.error('Pharmacy print bridge request failed.');
    return reply({ error: 'Print bridge request failed.' }, 500);
  }
}

export async function GET(request: Request) {
  return guarded(request, async () => {
    const credential = credentialFrom(request);
    if (!credential) return reply({ error: 'Print bridge credential required.' }, 401);
    const rawWait = new URL(request.url).searchParams.get('wait');
    const waitSeconds = Math.min(
      MAX_WAIT_SECONDS,
      Math.max(0, Number.parseInt(rawWait ?? '15', 10) || 0)
    );
    const deadline = Date.now() + waitSeconds * 1_000;
    for (let tick = 0; ; tick += 1) {
      const now = new Date();
      const job = await withBridge(
        credential,
        now,
        (db, bridge) => claimNextPharmacyPrintJob(db, bridge, now),
        tick === 0
      );
      if (job) return reply({ job });
      if (Date.now() >= deadline || request.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return new NextResponse(null, { status: 204, headers });
  });
}

export async function POST(request: Request) {
  return guarded(request, async () => {
    const credential = credentialFrom(request);
    if (!credential) return reply({ error: 'Print bridge credential required.' }, 401);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4_096) return reply({ error: 'Acknowledgement too large.' }, 413);
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const parsed = ackBody.safeParse(body);
    if (!parsed.success) return reply({ error: 'Invalid print acknowledgement.' }, 400);
    const now = new Date();
    const result = await withBridge(credential, now, (db, bridge) =>
      acknowledgePharmacyPrintJob(db, bridge, {
        jobId: parsed.data.jobId,
        claimToken: parsed.data.claimToken,
        outcome: parsed.data.status,
        failureCode: parsed.data.failureCode,
        now,
      })
    );
    if (!result.acknowledged) return reply({ error: 'Print job not found.' }, 404);
    return reply(result);
  });
}
