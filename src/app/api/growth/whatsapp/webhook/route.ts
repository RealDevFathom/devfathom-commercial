import { NextResponse } from 'next/server';

import { isGrowthEnabled } from '@/lib/growth';
import {
  createEvolutionProvider,
  evolutionConfigured,
  parseEvolutionWebhook,
} from '@/lib/growth/whatsapp/evolution';
import { handleGrowthWebhook } from '@/lib/growth/whatsapp/inbound';
import type { WhatsAppProvider } from '@/lib/growth/whatsapp/provider';
import { growthStore, outboundGrowthStore } from '@/lib/growth/whatsapp/store';
import { webhookSecretHash, webhookSecretMatches } from '@/lib/growth/whatsapp/webhook-secret';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

const WEBHOOK_HEADER = 'x-growth-webhook-secret';
const IP_LIMIT = 120;
const IP_WINDOW_MS = 60_000;

function presentedSecret(request: Request): string | null {
  const header = request.headers.get(WEBHOOK_HEADER)?.trim();
  return header ? header : null;
}

export async function POST(request: Request) {
  const gate = await rateLimit(`growth-whatsapp:ip:${clientIp(request)}`, IP_LIMIT, IP_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } }
    );
  }
  const secret = presentedSecret(request);
  if (!secret) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const authenticated = await withPlatformDb((db) =>
    growthStore(db).organizationForWebhookSecret(webhookSecretHash(secret))
  );
  if (!authenticated || !webhookSecretMatches(secret, authenticated.waWebhookSecretHash)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const organizationId = authenticated.organizationId;
  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = parseEvolutionWebhook(payload);
  if (!parsed || parsed.kind === 'ignore') {
    return NextResponse.json({ ok: true, ignored: true });
  }
  if (!(await isGrowthEnabled(organizationId))) return new NextResponse(null, { status: 204 });

  const confirmations: Array<() => Promise<void>> = [];
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
      afterCommit: (send) => confirmations.push(send),
      confirmationUnit: (run) =>
        withTenantDb(organizationId, (confirmationDb) => run(outboundGrowthStore(confirmationDb))),
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
  for (const send of confirmations) await send();
  return NextResponse.json({ ok: true });
}
