import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const temperatureSensorPayloadSchema = z
  .object({
    readingId: z.string().min(1).max(128),
    temperatureC: z.number().finite().min(-100).max(100),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type TemperatureSensorPayload = z.infer<typeof temperatureSensorPayloadSchema>;

export const TEMPERATURE_SENSOR_MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function temperatureSensorSignature(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyTemperatureSensorSignature(
  secret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  now = Date.now()
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > TEMPERATURE_SENSOR_MAX_CLOCK_SKEW_MS) {
    return false;
  }
  const supplied = Buffer.from(signature, 'hex');
  const expected = Buffer.from(temperatureSensorSignature(secret, timestamp, rawBody), 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
