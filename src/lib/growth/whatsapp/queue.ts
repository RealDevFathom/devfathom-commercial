import {
  assertBodyHasStop,
  assertCampaignProducts,
  assertMarketingCopyAllowed,
  DrugCategoryInPromo,
  fillAllowlistedProduct,
  MissingStop,
  ProhibitedDrugInCopy,
  ORDER_READY_BODIES,
  isOrderReadyName,
  productFamiliesFromMedicines,
  renderTemplate,
  type OrderReadyLanguage,
} from '@/lib/growth/templates';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { createEvolutionProvider, evolutionConfigured } from './evolution';
import type { WhatsAppProvider } from './provider';
import { sendText } from './send';
import { outboundGrowthStore as growthStore } from './store';
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
const CUSTOMER_MARKETING_WINDOW_MS = 24 * 60 * 60 * 1000;

export class CustomerDailyCap extends Error {
  constructor() {
    super('This customer already has a marketing message in the last 24 hours.');
    this.name = 'CustomerDailyCap';
  }
}

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
  row: MessageLogRow,
  checkCopy?: (body: string) => Promise<void>
): Promise<'sent' | 'failed' | 'skipped'> {
  const priorAttempts = readAttempts(row.error);
  const claimed = await unit(async (store) => {
    const next = await store.claimQueued(organizationId, row.id);
    if (!next) return null;
    const customer = next.customerId ? await store.customer(organizationId, next.customerId) : null;
    return { row: next, customer, organization: await store.organization(organizationId) };
  });
  if (!claimed) return 'skipped';
  let result;
  const utility =
    claimed.row.direction === 'out' &&
    isOrderReadyName(claimed.customer?.displayName ?? '') &&
    isOrderReadyName(claimed.organization?.displayName ?? '') &&
    Object.values(ORDER_READY_BODIES).some(
      (template) =>
        claimed.row.body ===
        renderTemplate(template, {
          name: claimed.customer?.displayName ?? '',
          business: claimed.organization?.displayName ?? '',
        })
    );
  let copyChecked = utility;
  try {
    if (!utility) {
      if (!checkCopy) throw new ProhibitedDrugInCopy();
      await checkCopy(claimed.row.body);
      copyChecked = true;
    }
    result = await sendText({
      provider,
      customer: await unit((store) =>
        claimed.row.customerId
          ? store.customer(organizationId, claimed.row.customerId)
          : Promise.resolve(null)
      ),
      body: claimed.row.body,
    });
  } catch (error) {
    if (error instanceof NotOptedIn || error instanceof MissingStop || !copyChecked) {
      await unit((store) =>
        store.markMessage(claimed.row.id, {
          status: 'failed',
          error: error instanceof Error ? error.name : 'CopyCheckFailed',
        })
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
  checkCopy?: (body: string) => Promise<void>;
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
      rows[index]!,
      input.checkCopy
    );
    if (outcome === 'sent') sent += 1;
  }
  return { sent, reason: 'ok' };
}

/** Pickup-ready notice. Pharmacy and restaurant share it. Opt-in is required. */
export async function enqueueOrderReady(
  store: GrowthWhatsAppStore,
  input: {
    organizationId: string;
    customerId: string;
    language: OrderReadyLanguage;
    name: string;
    business: string;
  }
): Promise<MessageLogRow> {
  const body = renderTemplate(ORDER_READY_BODIES[input.language], {
    name: input.name,
    business: input.business,
  });
  return enqueueOutbound(store, {
    organizationId: input.organizationId,
    customerId: input.customerId,
    body,
    templateKey: 'order_ready',
  });
}

type FamilyDb = Parameters<typeof productFamiliesFromMedicines>[0];

/**
 * Marketing queue gate. Product families come from this organization's medicines,
 * then the allowlist runs before the row is inserted.
 */
export async function enqueueMarketing(
  db: FamilyDb,
  store: GrowthWhatsAppStore,
  input: {
    organizationId: string;
    customerId: string;
    body: string;
    templateKey: string;
    medicineIds: readonly string[];
    campaignId?: string | null;
    recipientId?: string | null;
    now?: Date;
  }
): Promise<MessageLogRow> {
  const productCategories = await productFamiliesFromMedicines(
    db,
    input.organizationId,
    input.medicineIds
  );
  assertCampaignProducts({ templateKey: input.templateKey, productCategories });
  const body = await fillAllowlistedProduct(
    db,
    input.organizationId,
    input.body,
    input.medicineIds
  );
  await assertMarketingCopyAllowed(db, input.organizationId, body);
  const at = input.now ?? new Date();
  const recent = await store.countMarketingSince(
    input.organizationId,
    input.customerId,
    new Date(at.getTime() - CUSTOMER_MARKETING_WINDOW_MS)
  );
  if (recent >= 1) throw new CustomerDailyCap();
  return enqueueOutbound(store, {
    ...input,
    body,
    productCategories,
    campaignId: input.campaignId ?? 'marketing',
  });
}

/** Never enqueues a customer who is not opted in, or a body without STOP. */
async function enqueueOutbound(
  store: GrowthWhatsAppStore,
  input: {
    organizationId: string;
    customerId: string;
    body: string;
    templateKey?: string;
    productCategories?: readonly string[];
    campaignId?: string | null;
    recipientId?: string | null;
  }
): Promise<MessageLogRow> {
  const customer = await store.customer(input.organizationId, input.customerId);
  if (!customer?.whatsappOptIn || !customer.whatsappE164) throw new NotOptedIn();
  if (!input.templateKey) throw new DrugCategoryInPromo([]);
  assertCampaignProducts({
    templateKey: input.templateKey,
    productCategories: input.productCategories ?? [],
  });
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
  now = new Date(),
  openProvider: (settings: GrowthSettings) => Promise<WhatsAppProvider | null> = (settings) =>
    createEvolutionProvider(settings)
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
    provider = await openProvider(ready.settings);
  } catch {
    provider = null;
  }
  if (!provider) return { sent: 0, reason: 'not_configured' };
  return drainQueue({
    unit,
    provider,
    organizationId,
    checkCopy: (body) =>
      withTenantDb(organizationId, (db) => assertMarketingCopyAllowed(db, organizationId, body)),
    settings: ready.settings,
    timeZone: ready.timeZone,
    now,
  });
}
