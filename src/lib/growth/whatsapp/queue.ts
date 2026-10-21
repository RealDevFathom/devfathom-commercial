import { assertBodyHasStop, MissingStop } from '@/lib/growth/templates';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { createEvolutionProvider, evolutionConfigured } from './evolution';
import type { WhatsAppProvider } from './provider';
import { sendText } from './send';
import { growthStore } from './store';
import { businessTimeZone, effectiveDailyCap, isQuietHours, zonedDayStart } from './time';
import {
  NotOptedIn,
  type GrowthSettings,
  type GrowthWhatsAppStore,
  type MessageLogRow,
} from './types';

const WALL_MS = 60_000;
const ATTEMPTS = /^attempts=(\d+)\s+/;
const MAX_ATTEMPTS = 3;

export type QueueClock = {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Value in [0, 1). Multiplied by 3 seconds of jitter. */
  random(): number;
};

export type DrainResult = {
  sent: number;
  reason: 'ok' | 'quiet_hours' | 'daily_cap' | 'no_settings' | 'not_configured';
};

const realClock: QueueClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

export function readAttempts(error: string | null): number {
  const match = error?.match(ATTEMPTS);
  return match ? Number(match[1]) : 0;
}

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : 'send failed';
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

async function attemptRow(
  store: GrowthWhatsAppStore,
  provider: WhatsAppProvider,
  organizationId: string,
  row: MessageLogRow
): Promise<'sent' | 'failed'> {
  const customer = row.customerId ? await store.customer(organizationId, row.customerId) : null;
  try {
    const result = await sendText({ provider, customer, body: row.body });
    await store.markMessage(row.id, {
      status: 'sent',
      waMessageId: result.providerMessageId,
      error: null,
    });
    return 'sent';
  } catch (error) {
    if (error instanceof NotOptedIn || error instanceof MissingStop) {
      await store.markMessage(row.id, { status: 'failed', error: error.name });
      return 'failed';
    }
    const attempts = readAttempts(row.error) + 1;
    const detail = `attempts=${attempts} ${failureText(error)}`.slice(0, 500);
    await store.markMessage(row.id, {
      status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
      error: detail,
    });
    return 'failed';
  }
}

/**
 * Sends the oldest queued MessageLog rows for one organization.
 * Stops at the daily cap, at quiet hours, or after 60s of wall time.
 */
export async function drainQueue(input: {
  store: GrowthWhatsAppStore;
  provider: WhatsAppProvider;
  organizationId: string;
  settings: GrowthSettings;
  timeZone?: string | null;
  now: Date;
  clock?: QueueClock;
}): Promise<DrainResult> {
  const zone = businessTimeZone(input.timeZone);
  if (isQuietHours(input.now, zone, input.settings.quietHoursStart, input.settings.quietHoursEnd)) {
    return { sent: 0, reason: 'quiet_hours' };
  }
  const cap = effectiveDailyCap(input.settings, input.now);
  const sentToday = await input.store.countSentToday(
    input.organizationId,
    zonedDayStart(input.now, zone)
  );
  const remaining = Math.max(0, cap - sentToday);
  if (remaining === 0) return { sent: 0, reason: 'daily_cap' };

  const rows = await input.store.queuedMessages(input.organizationId, remaining);
  const clock = input.clock ?? realClock;
  const started = clock.now().getTime();
  let sent = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (clock.now().getTime() - started >= WALL_MS) break;
    if (index > 0) {
      const waitMs = (input.settings.minSecondsBetweenMsgs + clock.random() * 3) * 1000;
      if (clock.now().getTime() - started + waitMs >= WALL_MS) break;
      await clock.sleep(waitMs);
    }
    const outcome = await attemptRow(
      input.store,
      input.provider,
      input.organizationId,
      rows[index]!
    );
    if (outcome === 'sent') sent += 1;
  }
  return { sent, reason: 'ok' };
}

/** Never enqueues a customer who is not opted in, or a body without STOP. */
export async function enqueueOutbound(
  store: GrowthWhatsAppStore,
  input: {
    organizationId: string;
    customerId: string;
    body: string;
    campaignId?: string | null;
    recipientId?: string | null;
  }
): Promise<MessageLogRow> {
  const customer = await store.customer(input.organizationId, input.customerId);
  if (!customer?.whatsappOptIn || !customer.whatsappE164) throw new NotOptedIn();
  assertBodyHasStop(input.body);
  return store.insertMessage({
    organizationId: input.organizationId,
    customerId: input.customerId,
    direction: 'out',
    waMessageId: null,
    body: input.body,
    status: 'queued',
    campaignId: input.campaignId ?? null,
    recipientId: input.recipientId ?? null,
    error: null,
  });
}

export async function drainOrganizationQueue(
  organizationId: string,
  now = new Date()
): Promise<DrainResult> {
  return withTenantDb(organizationId, async (db) => {
    const store = growthStore(db);
    const settings = await store.settings(organizationId);
    if (!settings) return { sent: 0, reason: 'no_settings' };
    if (!evolutionConfigured(settings)) return { sent: 0, reason: 'not_configured' };
    let provider: WhatsAppProvider | null;
    try {
      provider = createEvolutionProvider(settings);
    } catch {
      return { sent: 0, reason: 'not_configured' };
    }
    if (!provider) return { sent: 0, reason: 'not_configured' };
    const organization = await store.organization(organizationId);
    return drainQueue({
      store,
      provider,
      organizationId,
      settings,
      timeZone: organization?.timezone,
      now,
    });
  });
}
