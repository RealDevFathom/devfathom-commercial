import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type WahaSession = {
  organizationId: string;
  sessionName: string;
  selector: string;
  encryptedApiKey: string;
  encryptedWebhookSecret: string;
  status: string;
  connectedNumber: string | null;
  restrictionCode: number | null;
  perMinute: number;
  perDay: number;
  portalCodes: boolean;
};

export async function readWahaSession(db: ScopedDb, organizationId: string) {
  const [row] = await db.$queryRaw<WahaSession[]>`
    SELECT * FROM pharmacy_waha_sessions WHERE "organizationId" = ${organizationId}`;
  return row ?? null;
}

// Only selects a candidate tenant key. The webhook must still verify the HMAC and the signed session.
export function selectorOrganization(selector: string): string | null {
  if (selector.length > 512) return null;
  try {
    const match = /^pharmacy-waha:([a-zA-Z0-9_-]{3,128})$/.exec(decryptSecret(selector));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function prepareWahaSession(db: ScopedDb, organizationId: string, apiKey: string) {
  if (!apiKey.trim() || apiKey.length > 512) throw new Error('Invalid API key.');
  const sessionName =
    'ph-' + createHmac('sha256', randomBytes(32)).update(organizationId).digest('hex');
  const selector = encryptSecret('pharmacy-waha:' + organizationId);
  const encryptedApiKey = encryptSecret(apiKey);
  const encryptedWebhookSecret = encryptSecret(randomBytes(48).toString('base64url'));
  const [row] = await db.$queryRaw<Pick<WahaSession, 'sessionName' | 'selector'>[]>`
    INSERT INTO pharmacy_waha_sessions ("organizationId", "sessionName", selector, "encryptedApiKey", "encryptedWebhookSecret")
    VALUES (${organizationId}, ${sessionName}, ${selector}, ${encryptedApiKey}, ${encryptedWebhookSecret})
    ON CONFLICT ("organizationId") DO UPDATE SET "encryptedApiKey" = EXCLUDED."encryptedApiKey"
    RETURNING "sessionName", selector`;
  return row;
}

export function wahaOrigin() {
  try {
    const url = new URL(process.env.PHARMACY_WAHA_BASE_URL ?? '');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
