import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { hashDeviceSecret } from '@/lib/retail-terminal/device-secret';
import { isColdChainSensorSecret, receiveSensorPush } from '@/lib/pharmacy/cold-chain-sensors';
import { clientIp, rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 64_000;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

const STATUS = {
  unauthorized: 401,
  organization_suspended: 403,
  sensor_owner_inactive: 403,
  invalid_body: 400,
  module_disabled: 403,
  zone_unavailable: 409,
} as const;

function reply(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers });
}

/**
 * DEV-82 — live cold-chain sensor push.
 *
 * `POST /api/pharmacy/cold-chain/readings` with `Authorization: Bearer pcs_…`
 * (the per-sensor secret issued once at enrollment) and
 * `{ "readings": [{ "recordedAt": ISO-8601, "temperatureC": number }] }`.
 *
 * There is no session: the sensor secret alone identifies the tenant, branch
 * and zone, so nothing in the body can choose where readings land. Unknown,
 * malformed and revoked secrets all answer the same 401. Re-sent readings are
 * idempotent, so a sensor may retry until it sees a 2xx.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await rateLimit(`pharmacy-cold-chain-ip:${clientIp(request)}`, 600, 60_000)).ok) {
    return reply({ error: 'rate_limited' }, 429);
  }
  const authorization = request.headers.get('authorization') ?? '';
  const secret = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!isColdChainSensorSecret(secret)) return reply({ error: 'unauthorized' }, 401);
  // Per-sensor budget, keyed by a hash prefix so the raw secret never reaches
  // the limiter's storage.
  const sensorKey = hashDeviceSecret(secret).slice(0, 32);
  if (!(await rateLimit(`pharmacy-cold-chain-sensor:${sensorKey}`, 60, 60_000)).ok) {
    return reply({ error: 'rate_limited' }, 429);
  }

  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (raw === null) return reply({ error: 'body_too_large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    body = undefined;
  }

  try {
    const outcome = await receiveSensorPush(secret, body, new Date());
    if (!outcome.ok) return reply({ error: outcome.error }, STATUS[outcome.error]);
    return reply(
      {
        accepted: outcome.accepted,
        duplicates: outcome.duplicates,
        zoneStatus: outcome.zoneStatus,
        alertsRefreshed: outcome.alertsRefreshed,
      },
      200
    );
  } catch (error) {
    // Never serialize Prisma/provider errors to a device.
    console.error(
      '[pharmacy-cold-chain] push failed',
      error instanceof Error ? error.name : 'error'
    );
    return reply({ error: 'internal_error' }, 500);
  }
}
