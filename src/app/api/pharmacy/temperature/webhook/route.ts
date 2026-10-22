import { NextResponse } from 'next/server';

import { decryptSecret } from '@/lib/secret-crypto';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { refreshStockSignals } from '@/lib/pharmacy/stock-signals-operations';
import {
  SensorTemperatureReadingSource,
  ingestTemperatureReadings,
} from '@/lib/pharmacy/temperature-log';
import {
  temperatureSensorPayloadSchema,
  verifyTemperatureSensorSignature,
} from '@/lib/pharmacy/temperature-sensor';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveExplicitOrganizationByHost,
} from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

const PRIVATE_HEADERS = { 'cache-control': 'no-store' };
const IP_LIMIT = 120;
const DEVICE_LIMIT = 60;
const WINDOW_MS = 60_000;
const KEY_ID = /^[A-Za-z0-9_-]{8,128}$/;

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
}

/**
 * Vendor-neutral live sensor ingress. The explicit tenant host and the device's
 * tenant-scoped registration must agree before its encrypted HMAC key is used.
 */
export async function POST(request: Request): Promise<Response> {
  const ipGate = await rateLimit(`pharmacy-temperature:ip:${clientIp(request)}`, IP_LIMIT, WINDOW_MS);
  if (!ipGate.ok) {
    return json({ error: 'Too many requests.' }, 429, { 'Retry-After': String(ipGate.retryAfter) });
  }

  const organization = await resolveExplicitOrganizationByHost(requestHost(request));
  if (
    !organization ||
    organization.isDemo ||
    organization.vertical !== 'PHARMACY' ||
    !isTenantLifecycleAccessible(organization.status)
  ) {
    return json({ error: 'Unknown tenant or device.' }, 404);
  }

  const keyId = request.headers.get('x-device-key-id') ?? '';
  if (!KEY_ID.test(keyId)) return json({ error: 'Unknown tenant or device.' }, 404);

  const deviceGate = await rateLimit(
    `pharmacy-temperature:device:${organization.id}:${keyId}`,
    DEVICE_LIMIT,
    WINDOW_MS
  );
  if (!deviceGate.ok) {
    return json(
      { error: 'Too many requests.' },
      429,
      { 'Retry-After': String(deviceGate.retryAfter) }
    );
  }

  const rawBody = await request.text();
  return withTenantDb(organization.id, async (db) => {
    const device = await db.pharmacyTemperatureDevice.findFirst({
      where: { organizationId: organization.id, keyId, active: true },
    });
    if (!device) return json({ error: 'Unknown tenant or device.' }, 404);

    let secret: string;
    try {
      secret = decryptSecret(device.encryptedSigningSecret);
    } catch {
      return json({ error: 'Device authentication unavailable.' }, 503);
    }
    if (
      !verifyTemperatureSensorSignature(
        secret,
        request.headers.get('x-device-timestamp'),
        request.headers.get('x-device-signature'),
        rawBody
      )
    ) {
      return json({ error: 'Invalid signature.' }, 401);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody) as unknown;
    } catch {
      return json({ error: 'Invalid sensor reading.' }, 400);
    }
    const payload = temperatureSensorPayloadSchema.safeParse(parsedJson);
    if (!payload.success) return json({ error: 'Invalid sensor reading.' }, 400);

    const scope = {
      organizationId: organization.id,
      branchId: device.branchId,
      actorId: `temperature-device:${device.id}`,
    };
    const result = await ingestTemperatureReadings(
      db,
      scope,
      device.stockLocationId,
      new SensorTemperatureReadingSource({
        temperatureC: payload.data.temperatureC,
        recordedAt: new Date(payload.data.recordedAt),
        deviceIdentifier: device.id,
        externalReadingId: payload.data.readingId,
      })
    );

    if (result.count === 0) return json({ accepted: true, duplicate: true }, 200);

    await db.pharmacyTemperatureDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    // Reuse PUR-07's existing COLD_CHAIN signal evaluator rather than inventing
    // a parallel alert model for live readings.
    const alertResult = await refreshStockSignals(db, scope, new Date(payload.data.recordedAt));
    return json(
      {
        accepted: true,
        duplicate: false,
        alertsRaised: alertResult.signals.filter((signal) => signal.kind === 'COLD_CHAIN').length,
      },
      202
    );
  });
}
