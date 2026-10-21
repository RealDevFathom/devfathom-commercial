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

/** One short transaction. Sleep and provider HTTP stay outside it. */
export type StoreUnit = <T>(run: (store: GrowthWhatsAppStore) => Promise<T>) => Promise<T>;

async function attemptRow(
  unit: StoreUnit,
  provider: WhatsAppProvider,
  organizationId: string,
  row: MessageLogRow
): Promise<'sent' | 'failed' | 'skipped'> {
  const priorAttempts = readAttempts(row.error);
  const claimed = await unit(async (store) => {
    const next = await store.claimQueued(organizationId, row.id);
    if (!next) return null;
    const customer = next.customerId ? await store.customer(organizationId, next.customerId) : null;
    return { row: next, customer };
  });
  if (!claimed) return 'skipped';
  let result;
  try {
    result = await sendText({
      provider,
      customer: claimed.customer,
      body: claimed.row.body,
    });
  } catch (error) {
    if (error instanceof NotOptedIn || error instanceof MissingStop) {
      await unit((store) =>
        store.markMessage(claimed.row.id, { status: 'failed', error: error.name })
      );
      return 'failed';
    }
    const attempts = priorAttempts + 1;
    const detail = `attempts=${attempts} ${failureText(error)}`.slice(0, 500);
    await unit((store) =>
      store.markMessage(claimed.row.id, {
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
        error: detail,
      })
    );
    return 'failed';
  }
  await unit((store) =>
    store.markMessage(claimed.row.id, {
      status: 'sent',
      waMessageId: result.providerMessageId,
      error: null,
    })
  );
  return 'sent';
}

/**
 * Sends the oldest queued MessageLog rows for one organization.
 * Stops at the daily cap, at quiet hours, or after 60s of wall time.
 */
export async function drainQueue(input: {
  unit: StoreUnit;
  provider: WhatsAppProvider;
  organizationId: string;
  settings: GrowthSettings;
  timeZone?: string | null;
  now: Date;
  clock?: QueueClock;
}): Promise<DrainResult> {
  const zone = businessTimeZone(input.timeZone);
  const clock = input.clock ?? realClock;
  const quietAt = (at: Date) =>
    isQuietHours(at, zone, input.settings.quietHoursStart, input.settings.quietHoursEnd);
  if (quietAt(input.now) || quietAt(clock.now())) return { sent: 0, reason: 'quiet_hours' };

  const cap = effectiveDailyCap(input.settings, input.now);
  const sentToday = await input.unit((store) =>
    store.countSentToday(input.organizationId, zonedDayStart(input.now, zone))
  );
  const remaining = Math.max(0, cap - sentToday);
  if (remaining === 0) return { sent: 0, reason: 'daily_cap' };

  const rows = await input.unit((store) => store.queuedMessages(input.organizationId, remaining));
  const started = clock.now().getTime();
  let sent = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (clock.now().getTime() - started >= WALL_MS) break;
    if (quietAt(clock.now())) return { sent, reason: 'quiet_hours' };
    if (index > 0) {
      const waitMs = (input.settings.minSecondsBetweenMsgs + clock.random() * 3) * 1000;
      if (clock.now().getTime() - started + waitMs >= WALL_MS) break;
      await clock.sleep(waitMs);
      if (clock.now().getTime() - started >= WALL_MS) break;
      if (quietAt(clock.now())) return { sent, reason: 'quiet_hours' };
    }
    const outcome = await attemptRow(
      input.unit,
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
  const unit: StoreUnit = (run) => withTenantDb(organizationId, (db) => run(growthStore(db)));
  const ready = await unit(async (store) => {
    const settings = await store.settings(organizationId);
    if (!settings) return { kind: 'no_settings' as const };
    if (!evolutionConfigured(settings)) return { kind: 'not_configured' as const };
    const organization = await store.organization(organizationId);
    return { kind: 'ready' as const, settings, timeZone: organization?.timezone ?? null };
  });
  if (ready.kind !== 'ready') return { sent: 0, reason: ready.kind };

  let provider: WhatsAppProvider | null = null;
  try {
    provider = await createEvolutionProvider(ready.settings);
  } catch {
    provider = null;
  }
  if (!provider) return { sent: 0, reason: 'not_configured' };
  return drainQueue({
    unit,
    provider,
    organizationId,
    settings: ready.settings,
    timeZone: ready.timeZone,
    now,
  });
}
