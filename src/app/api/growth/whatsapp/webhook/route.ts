import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { isGrowthEnabled } from '@/lib/growth';
import {
  createEvolutionProvider,
  evolutionConfigured,
  parseEvolutionWebhook,
} from '@/lib/growth/whatsapp/evolution';
import { handleGrowthWebhook } from '@/lib/growth/whatsapp/inbound';
import type { WhatsAppProvider } from '@/lib/growth/whatsapp/provider';
import { growthStore } from '@/lib/growth/whatsapp/store';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

const WEBHOOK_HEADER = 'x-growth-webhook-secret';
const IP_LIMIT = 120;
const IP_WINDOW_MS = 60_000;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function webhookAuthorized(request: Request): boolean {
  const expected = process.env.GROWTH_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  const provided = request.headers.get(WEBHOOK_HEADER);
  if (!provided) return false;
  return safeEqual(provided, expected);
}

export async function POST(request: Request) {
  const gate = rateLimit(`growth-whatsapp:ip:${clientIp(request)}`, IP_LIMIT, IP_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } }
    );
  }
  if (!webhookAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = parseEvolutionWebhook(payload);
  if (!parsed || parsed.kind === 'ignore' || !parsed.instance) {
    return NextResponse.json({ ok: true, ignored: true });
  }
  const organizationId = await withPlatformDb((db) =>
    growthStore(db).organizationIdForInstance(parsed.instance)
  );
  if (!organizationId) return NextResponse.json({ ok: true, ignored: true });
  if (!(await isGrowthEnabled(organizationId))) return new NextResponse(null, { status: 204 });

  await withTenantDb(organizationId, async (db) => {
    const store = growthStore(db);
    const settings = await store.settings(organizationId);
    const organization = await store.organization(organizationId);
    let provider: WhatsAppProvider | null = null;
    try {
      provider =
        evolutionConfigured(settings) && settings ? await createEvolutionProvider(settings) : null;
    } catch {
      provider = null;
    }
    await handleGrowthWebhook({
      store,
      provider: provider ?? {
        async sendText() {
          throw new Error('Evolution API is not configured.');
        },
        async getStatus() {
          return 'unavailable';
        },
      },
      organizationId,
      payload,
      businessName: organization?.displayName ?? 'this shop',
    });
  });
  return NextResponse.json({ ok: true });
}
