import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { PHARMACY_METRIC_CONTRACT, readPharmacyOwnerCommandCentre } from './reports';
import {
  readPharmacyAnomalySignals,
  refreshPharmacyAnomalySignals,
  renderAnomalyDigest,
} from './anomaly-signals-operations';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import { zonedWallTimeToUtc } from '@/lib/restaurant/sop-recurrence';
import {
  createWhatsAppProvider,
  MetaWhatsAppProvider,
  readWhatsAppConfig,
  type WhatsAppConfig,
  type WhatsAppProvider,
} from './whatsapp/provider';
import { normalizeWhatsAppNumber, phoneLast4 } from './whatsapp/messages';
import {
  claimMessageLogInTransaction,
  sendAndLog,
  sendClaimedMessage,
  type MessageLogEntry,
} from './whatsapp/message-log';

const DIGEST_METRIC_KEYS = [
  'salesMinor',
  'marginMinor',
  'cashMinor',
  'refundsMinor',
  'openStockSignals',
  'expiryValueMinor30',
  'expiryValueMinor60',
  'expiryValueMinor90',
  'expiryValueMinor180',
  'openRecalls',
  'quarantineUnits',
  'safetyQueue',
  'deviceFiscalOfflineExceptions',
] as const;

type MetricKey = (typeof DIGEST_METRIC_KEYS)[number];
type CommandCentre = Awaited<ReturnType<typeof readPharmacyOwnerCommandCentre>>;

export type OwnerBriefingFigures = {
  salesMinor: number;
  cashMinor: number;
  lostDemandEstimatedMinor: number;
  walkOuts: number;
  topGapName: string | null;
  topGapEstimatedMinor: number;
  topGapDraftPo: boolean;
  recoveredEstimatedMinor: number;
  expiryAtRiskMinor: number;
  khataDueMinor: number | null;
};

export type OwnerBriefing = {
  variant: 'DAILY' | 'WEEKLY';
  from: string;
  to: string;
  figures: OwnerBriefingFigures;
  /** Full detail for the authenticated owner in the app. */
  appBody: string;
  /** Human-readable preview only; Meta receives individual figure variables instead. */
  whatsappBody: string;
};

export type OwnerDigest = {
  organizationId: string;
  userId: string;
  branchId: string;
  branchName: string;
  ownerPhone: string | null;
  whatsappPhoneHash: string | null;
  businessDate: string;
  freshness: CommandCentre['freshness'];
  metrics: Array<{
    key: MetricKey;
    label: string;
    definition: string;
    source: string | null;
    value: number | null;
  }>;
  anomalies: Awaited<ReturnType<typeof readPharmacyAnomalySignals>>;
  briefings: { daily: OwnerBriefing; weekly: OwnerBriefing };
  rendered: string;
};

export interface DigestChannel {
  readonly name: string;
  deliver(db: ScopedDb, digest: OwnerDigest): Promise<{ delivered: boolean; reference?: string }>;
}

const moneyKeys = new Set<MetricKey>([
  'salesMinor',
  'marginMinor',
  'cashMinor',
  'refundsMinor',
  'expiryValueMinor30',
  'expiryValueMinor60',
  'expiryValueMinor90',
  'expiryValueMinor180',
]);

function renderValue(key: MetricKey, value: number | null): string {
  if (value == null) return 'Not available';
  return moneyKeys.has(key) ? `PKR ${(value / 100).toFixed(2)}` : String(value);
}

const money = (minor: number | null) =>
  minor == null ? 'Not available' : `PKR ${(minor / 100).toFixed(2)}`;

function dateDaysBefore(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/**
 * Reads only recorded ledgers/events. Values sourced from estimated demand are
 * explicitly labelled as estimates in both delivery surfaces.
 */
export async function readOwnerBriefingFigures(
  db: ScopedDb,
  branchId: string,
  from: string,
  to: string,
  timezone: string
): Promise<OwnerBriefingFigures> {
  const report = await readPharmacyOwnerCommandCentre(db, { branchIds: [branchId], from, to });
  const zone = workspaceTimezone(timezone);
  const start = zonedWallTimeToUtc(from, 0, zone).instant;
  const dayAfterTo = dateDaysBefore(to, -1);
  const end = zonedWallTimeToUtc(dayAfterTo, 0, zone).instant;
  const [demand] = await db.$queryRaw<
    Array<{
      lost: bigint;
      walkOuts: bigint;
      recovered: bigint;
      topGapName: string | null;
      topGapValue: bigint;
      topGapDraftPo: boolean;
    }>
  >(Prisma.sql`
    WITH all_period_demand AS (
      SELECT d.*, m."productName"
      FROM "pharmacy_unfulfilled_demand_events" d
      LEFT JOIN "pharmacy_medicines" m ON m."organizationId"=d."organizationId" AND m."id"=d."requestedMedicineId"
      WHERE d."branchId"=${branchId} AND d."createdAt">=${start} AND d."createdAt"<${end}
    ), unrecovered_period_demand AS (
      -- A declined substitute closes the event as a genuine walk-out; only recovered demand is excluded.
      SELECT * FROM all_period_demand WHERE status IN ('OPEN','CLOSED')
    ), keyed_demand AS (
      -- Unmatched free-text requests group by their recorded identity, never into one null bucket.
      SELECT *,
        CASE
          WHEN "requestedMedicineId" IS NOT NULL THEN 'medicine:' || "requestedMedicineId"
          WHEN NULLIF(btrim("requestedText"),'') IS NOT NULL THEN 'text:' || lower(btrim("requestedText"))
            || '|' || lower(COALESCE(btrim("strength"),'')) || '|' || lower(COALESCE(btrim("form"),''))
          ELSE 'event:' || "id"
        END AS gap_key,
        COALESCE("productName", NULLIF(concat_ws(' ', NULLIF(btrim("requestedText"),''),
          NULLIF(btrim("strength"),''), NULLIF(btrim("form"),'')),'')) AS gap_name
      FROM unrecovered_period_demand
    ), gaps AS (
      SELECT gap_key, MAX("requestedMedicineId") AS "requestedMedicineId", MAX(gap_name) AS name,
        COALESCE(SUM("estimatedValueMinor"),0)::bigint AS value
      FROM keyed_demand GROUP BY gap_key
      ORDER BY value DESC, gap_key LIMIT 1
    )
    SELECT
      COALESCE((SELECT SUM("estimatedValueMinor") FROM unrecovered_period_demand),0)::bigint AS lost,
      (SELECT COUNT(*) FROM unrecovered_period_demand)::bigint AS "walkOuts",
      COALESCE((SELECT SUM("estimatedValueMinor") FROM "pharmacy_unfulfilled_demand_events" WHERE "branchId"=${branchId} AND status='RECOVERED' AND "recoveredAt">=${start} AND "recoveredAt"<${end}),0)::bigint AS recovered,
      gaps.name AS "topGapName", COALESCE(gaps.value,0)::bigint AS "topGapValue",
      COALESCE(EXISTS(SELECT 1 FROM "pharmacy_purchase_order_lines" pol JOIN "pharmacy_purchase_orders" po ON po."organizationId"=pol."organizationId" AND po.id=pol."purchaseOrderId" WHERE po."branchId"=${branchId} AND po.status='DRAFT' AND pol."medicineId"=gaps."requestedMedicineId"),false) AS "topGapDraftPo"
    FROM gaps RIGHT JOIN (SELECT 1) singleton ON true
  `);
  return {
    salesMinor: report.metrics.salesMinor,
    cashMinor: report.metrics.cashMinor,
    lostDemandEstimatedMinor: Number(demand?.lost ?? 0),
    walkOuts: Number(demand?.walkOuts ?? 0),
    topGapName: demand?.topGapName ?? null,
    topGapEstimatedMinor: Number(demand?.topGapValue ?? 0),
    topGapDraftPo: demand?.topGapDraftPo ?? false,
    recoveredEstimatedMinor: Number(demand?.recovered ?? 0),
    expiryAtRiskMinor: report.metrics.expiryValueMinor30,
    khataDueMinor: report.metrics.khataAgingMinor,
  };
}

export function renderOwnerBriefing(input: {
  variant: 'DAILY' | 'WEEKLY';
  branchName: string;
  from: string;
  to: string;
  figures: OwnerBriefingFigures;
}): OwnerBriefing {
  const { figures: f } = input;
  const label = input.variant === 'DAILY' ? input.to : `${input.from} to ${input.to}`;
  const heading = `${input.variant === 'DAILY' ? 'Daily' : 'Weekly'} owner briefing · ${input.branchName} · ${label}`;
  const common = [
    `1. Sales ${money(f.salesMinor)} · cash ${money(f.cashMinor)}`,
    `2. Lost demand estimate ${money(f.lostDemandEstimatedMinor)} · walk-outs ${f.walkOuts}`,
  ];
  const po = f.topGapDraftPo ? 'draft PO ready' : 'no draft PO';
  return {
    variant: input.variant,
    from: input.from,
    to: input.to,
    figures: f,
    appBody: [
      heading,
      ...common,
      `3. Top gap ${f.topGapName ?? 'Not available'} · estimated ${money(f.topGapEstimatedMinor)} · ${po}`,
      `4. Recovered demand estimate ${money(f.recoveredEstimatedMinor)} · expiry at risk (30 days) ${money(f.expiryAtRiskMinor)}`,
      `5. Khata due ${money(f.khataDueMinor)}`,
    ].join('\n'),
    // Never interpolate branch or catalog fields here. Even a branch may be named after a drug.
    whatsappBody: [
      `${input.variant === 'DAILY' ? 'Daily' : 'Weekly'} owner business briefing · ${label}`,
      ...common,
      `3. Top stock gap · estimated ${money(f.topGapEstimatedMinor)} · ${po}`,
      `4. Recovered demand estimate ${money(f.recoveredEstimatedMinor)} · expiry at risk (30 days) ${money(f.expiryAtRiskMinor)}`,
      `5. Khata due ${money(f.khataDueMinor)}`,
    ].join('\n'),
  };
}

export async function composeOwnerDigest(
  db: ScopedDb,
  input: {
    organizationId: string;
    userId: string;
    branchId: string;
    branchName: string;
    ownerPhone?: string | null;
    whatsappPhoneHash?: string | null;
    businessDate: string;
    timezone?: string;
  }
): Promise<OwnerDigest> {
  const filters = {
    branchIds: [input.branchId],
    from: input.businessDate,
    to: input.businessDate,
  };
  const weeklyFrom = dateDaysBefore(input.businessDate, 6);
  const [report, anomalies, dailyFigures, weeklyFigures] = await Promise.all([
    readPharmacyOwnerCommandCentre(db, filters),
    readPharmacyAnomalySignals(db, filters),
    readOwnerBriefingFigures(
      db,
      input.branchId,
      input.businessDate,
      input.businessDate,
      input.timezone ?? 'UTC'
    ),
    readOwnerBriefingFigures(
      db,
      input.branchId,
      weeklyFrom,
      input.businessDate,
      input.timezone ?? 'UTC'
    ),
  ]);
  const contracts = new Map(PHARMACY_METRIC_CONTRACT.map((contract) => [contract.key, contract]));
  const metrics = DIGEST_METRIC_KEYS.map((key) => {
    const contract = contracts.get(key);
    if (!contract) throw new Error(`RPT-01 metric contract missing: ${key}.`);
    return { ...contract, key, value: report.metrics[key] };
  });
  const briefings = {
    daily: renderOwnerBriefing({
      variant: 'DAILY',
      branchName: input.branchName,
      from: input.businessDate,
      to: input.businessDate,
      figures: dailyFigures,
    }),
    weekly: renderOwnerBriefing({
      variant: 'WEEKLY',
      branchName: input.branchName,
      from: weeklyFrom,
      to: input.businessDate,
      figures: weeklyFigures,
    }),
  };
  return {
    ...input,
    ownerPhone: input.ownerPhone ?? null,
    whatsappPhoneHash: input.whatsappPhoneHash ?? null,
    freshness: report.freshness,
    metrics,
    anomalies,
    briefings,
    rendered: [
      briefings.daily.appBody,
      '',
      briefings.weekly.appBody,
      '',
      'Operational detail',
      ...metrics.map((metric) => `${metric.label}: ${renderValue(metric.key, metric.value)}`),
      ...renderAnomalyDigest(anomalies),
      `As of ${report.freshness.asOf}`,
    ].join('\n'),
  };
}

export class CaptureChannel implements DigestChannel {
  readonly name = 'capture';

  async deliver(
    db: ScopedDb,
    digest: OwnerDigest,
    options: { whatsappParameters?: string[] | null } = {}
  ) {
    const key = {
      organizationId: digest.organizationId,
      userId: digest.userId,
      branchId: digest.branchId,
      businessDate: digest.businessDate,
    };
    // ON CONFLICT DO NOTHING keeps duplicate receipts truthful without catching
    // a unique-constraint error inside the owning transaction.
    const inserted = await db.pharmacyOwnerDigestCapture.createMany({
      data: {
        ...key,
        rendered: digest.rendered,
        metrics: JSON.parse(JSON.stringify(digest.metrics)) as Prisma.InputJsonValue,
        // Pending WhatsApp work commits atomically with the capture and schedule claim.
        ...(options.whatsappParameters
          ? { whatsappPendingAt: new Date(), whatsappParameters: options.whatsappParameters }
          : {}),
      },
      skipDuplicates: true,
    });
    const capture = await db.pharmacyOwnerDigestCapture.findUniqueOrThrow({
      where: {
        organizationId_userId_branchId_businessDate: key,
      },
      select: { id: true },
    });
    return { delivered: inserted.count === 1, reference: capture.id };
  }
}

/** A profile phone edit invalidates consent until the owner opts in again. */
export function ownerDigestWhatsAppPhoneHash(phone: string | null | undefined): string | null {
  const normalized = normalizeWhatsAppNumber(phone);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

export const OWNER_DIGEST_WHATSAPP_PARAMETER_COUNT = 21;
/** A queued send older than this is stale business news; drop it rather than deliver late. */
const OWNER_DIGEST_WHATSAPP_MAX_PENDING_MS = 24 * 60 * 60 * 1000;

function ownerDigestDedupeKey(input: { userId: string; branchId: string; businessDate: string }) {
  return `owner-digest:${input.userId}:${input.branchId}:${input.businessDate}`;
}

/** Ordered body variables for the fixed, approved template in docs/pharmacy/owner-digest-whatsapp.md. */
export function ownerDigestWhatsAppParameters(digest: OwnerDigest): string[] {
  const figures = (f: OwnerBriefingFigures) => [
    money(f.salesMinor),
    money(f.cashMinor),
    money(f.lostDemandEstimatedMinor),
    String(f.walkOuts),
    money(f.topGapEstimatedMinor),
    f.topGapDraftPo ? 'Yes' : 'No',
    money(f.recoveredEstimatedMinor),
    money(f.expiryAtRiskMinor),
    money(f.khataDueMinor),
  ];
  return [
    digest.briefings.daily.to,
    ...figures(digest.briefings.daily.figures),
    digest.briefings.weekly.from,
    digest.briefings.weekly.to,
    ...figures(digest.briefings.weekly.figures),
  ];
}

// Sending deliberately takes no ScopedDb: no caller transaction may span network I/O.
export class WhatsAppChannel {
  readonly name = 'whatsapp';
  readonly configured: boolean;

  constructor(
    private readonly config: WhatsAppConfig = readWhatsAppConfig(),
    private readonly provider: WhatsAppProvider = config.provider === 'meta'
      ? new MetaWhatsAppProvider(config)
      : createWhatsAppProvider(config)
  ) {
    this.configured = Boolean(
      config.provider === 'meta' &&
      config.accessToken &&
      config.phoneNumberId &&
      config.organizationId &&
      config.templates.ownerDigest
    );
  }

  isConfiguredFor(organizationId: string) {
    return this.configured && this.config.organizationId === organizationId;
  }

  /** The normalized recipient only when this sender and the owner's phone-bound consent allow it. */
  recipientFor(
    organizationId: string,
    phone: string | null | undefined,
    consentHash: string | null | undefined
  ): string | null {
    const to = normalizeWhatsAppNumber(phone);
    return this.isConfiguredFor(organizationId) &&
      to &&
      consentHash &&
      consentHash === ownerDigestWhatsAppPhoneHash(to)
      ? to
      : null;
  }

  messageEntry(
    input: { organizationId: string; userId: string; branchId: string; businessDate: string },
    to: string
  ): MessageLogEntry {
    return {
      organizationId: input.organizationId,
      branchId: input.branchId,
      kind: 'OWNER_DIGEST',
      dedupeKey: ownerDigestDedupeKey(input),
      phoneLast4: phoneLast4(to),
      templateName: this.config.templates.ownerDigest,
      dueDate: input.businessDate,
    };
  }

  private send(to: string, parameters: string[]) {
    return () => this.provider.sendTemplate({ to, template: 'ownerDigest', parameters });
  }

  async deliver(digest: OwnerDigest) {
    const to = this.recipientFor(
      digest.organizationId,
      digest.ownerPhone,
      digest.whatsappPhoneHash
    );
    if (!to) return { delivered: false };
    const outcome = await sendAndLog(
      this.messageEntry(digest, to),
      this.send(to, ownerDigestWhatsAppParameters(digest))
    );
    return { delivered: outcome === 'SENT', reference: outcome };
  }

  /** Contacts Meta for a reservation whose eligibility checks already committed. */
  async deliverReserved(reservation: {
    entry: MessageLogEntry;
    logId: string;
    to: string;
    parameters: string[];
  }) {
    const outcome = await sendClaimedMessage(
      reservation.entry,
      reservation.logId,
      this.send(reservation.to, reservation.parameters)
    );
    return { delivered: outcome === 'SENT', reference: outcome };
  }
}

function pendingParameters(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length === OWNER_DIGEST_WHATSAPP_PARAMETER_COUNT &&
    value.every((item) => typeof item === 'string')
    ? value
    : null;
}

/**
 * Locks the owner, the digest setting and the pending capture, rechecks access,
 * consent and phone, then reserves the message in this one transaction. A consent
 * revocation or phone edit either commits first (and wins) or waits for commit.
 * Meta is contacted only after this returns, outside any transaction.
 */
async function reserveOwnerDigestWhatsApp(
  whatsapp: WhatsAppChannel,
  pending: {
    id: string;
    organizationId: string;
    userId: string;
    branchId: string;
    businessDate: string;
  },
  now: Date
) {
  return withTenantDb(pending.organizationId, async (db) => {
    const { organizationId, userId, branchId } = pending;
    // Lock order user -> setting -> capture; the scheduler claim locks only setting then inserts capture.
    await db.$queryRaw(Prisma.sql`
      SELECT id FROM "users" WHERE "organizationId"=${organizationId} AND id=${userId} FOR SHARE
    `);
    const [setting] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "pharmacy_owner_digest_settings"
      WHERE "organizationId"=${organizationId} AND "userId"=${userId} AND "branchId"=${branchId}
      FOR UPDATE
    `);
    const [capture] = await db.$queryRaw<
      Array<{ whatsappPendingAt: Date | null; whatsappParameters: unknown }>
    >(Prisma.sql`
      SELECT "whatsappPendingAt", "whatsappParameters" FROM "pharmacy_owner_digest_captures"
      WHERE "organizationId"=${organizationId} AND id=${pending.id}
      FOR UPDATE
    `);
    // A competing worker already reserved or dropped this work.
    if (!capture?.whatsappPendingAt) return null;
    const authorized = setting
      ? await readAuthorizedDigestSetting(db, setting.id, organizationId)
      : null;
    const to =
      authorized && authorized.userId === userId && authorized.branchId === branchId
        ? whatsapp.recipientFor(organizationId, authorized.user.phone, authorized.whatsappPhoneHash)
        : null;
    const parameters = pendingParameters(capture.whatsappParameters);
    const fresh =
      now.getTime() - new Date(capture.whatsappPendingAt).getTime() <=
      OWNER_DIGEST_WHATSAPP_MAX_PENDING_MS;
    const logId =
      to && parameters && fresh
        ? await claimMessageLogInTransaction(db, {
            ...whatsapp.messageEntry(pending, to),
            direction: 'OUTBOUND',
            status: 'PENDING',
          })
        : null;
    // Reserved, ineligible, stale or duplicate: the work is consumed either way.
    await db.pharmacyOwnerDigestCapture.update({
      where: { id: pending.id },
      data: { whatsappPendingAt: null, whatsappParameters: Prisma.DbNull },
    });
    return logId && to && parameters
      ? { entry: whatsapp.messageEntry(pending, to), logId, to, parameters }
      : null;
  });
}

/** The workspace's wall clock; a stored zone Intl refuses reads as UTC rather than throwing. */
function localClock(at: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: workspaceTimezone(timezone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function nextDigestDueAt(now: Date, timezone: string, timeMinutes: number): Date {
  const local = localClock(now, timezone);
  const addDay = local.minutes >= timeMinutes ? 1 : 0;
  const targetDate = new Date(`${local.date}T00:00:00.000Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + addDay);
  const target = `${targetDate.toISOString().slice(0, 10)}T${String(Math.floor(timeMinutes / 60)).padStart(2, '0')}:${String(timeMinutes % 60).padStart(2, '0')}`;
  let candidate = new Date(`${target}:00.000Z`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = localClock(candidate, timezone);
    const targetMs = new Date(`${target}:00.000Z`).getTime();
    const observedMs = new Date(
      `${observed.date}T${String(Math.floor(observed.minutes / 60)).padStart(2, '0')}:${String(observed.minutes % 60).padStart(2, '0')}:00.000Z`
    ).getTime();
    candidate = new Date(candidate.getTime() + targetMs - observedMs);
  }
  return candidate;
}

async function readAuthorizedDigestSetting(db: ScopedDb, id: string, organizationId: string) {
  const setting = await db.pharmacyOwnerDigestSetting.findFirst({
    where: { id, organizationId, enabled: true },
    include: {
      organization: { select: { status: true, vertical: true, timezone: true } },
      branch: { select: { name: true, active: true, organizationId: true } },
      user: {
        select: {
          id: true,
          organizationId: true,
          status: true,
          role: true,
          department: true,
          phone: true,
        },
      },
    },
  });
  if (
    !setting ||
    !['ONBOARDING', 'ACTIVE', 'GRACE'].includes(setting.organization.status) ||
    setting.organization.vertical !== 'PHARMACY' ||
    setting.branch.organizationId !== organizationId ||
    !setting.branch.active ||
    setting.user.organizationId !== organizationId ||
    setting.user.status !== 'ACTIVE' ||
    setting.user.role !== 'ADMIN'
  )
    return null;

  // The scheduler cutoff may be historical. Authority must use the effect's
  // current clock, including entitlement and permission expiry.
  const at = new Date();
  const entitlements = await resolveOrganizationEntitlements(organizationId, db, at);
  if (!hasModule(entitlements, 'pharmacy-reports')) return null;
  const subject = subjectFromSession(setting.user);
  const [operational, financial] = await Promise.all([
    can(subject, 'reports:operational', undefined, { db, source: 'SYSTEM', now: at }),
    can(subject, 'reports:financial', undefined, { db, source: 'SYSTEM', now: at }),
  ]);
  return operational && financial ? setting : null;
}

class DigestAuthorityChanged extends Error {}

export async function processDueOwnerDigests(now = new Date(), limit = 25) {
  const due = await withPlatformDb((db) =>
    db.pharmacyOwnerDigestSetting.findMany({
      where: { enabled: true, nextDueAt: { lte: now } },
      orderBy: { nextDueAt: 'asc' },
      take: Math.max(1, Math.min(100, Math.floor(limit))),
      select: {
        id: true,
        organizationId: true,
      },
    })
  );
  let captured = 0;
  let failed = 0;
  const whatsapp = new WhatsAppChannel();
  for (const item of due) {
    try {
      const digest = await withTenantDb(item.organizationId, async (db) => {
        const setting = await db.pharmacyOwnerDigestSetting.findFirst({
          where: {
            id: item.id,
            organizationId: item.organizationId,
            enabled: true,
            nextDueAt: { lte: now },
          },
          include: {
            organization: { select: { timezone: true } },
          },
        });
        if (!setting?.nextDueAt) return null;
        // Compare-and-set acquires the setting row lock until tenant commit.
        // A concurrent disable/edit wins if committed first; competing workers
        // cannot refresh anomalies or claim this occurrence twice.
        const claim = await db.pharmacyOwnerDigestSetting.updateMany({
          where: {
            id: setting.id,
            organizationId: item.organizationId,
            enabled: true,
            nextDueAt: setting.nextDueAt,
            updatedAt: setting.updatedAt,
          },
          data: {
            nextDueAt: nextDigestDueAt(now, setting.organization.timezone, setting.timeMinutes),
          },
        });
        if (claim.count !== 1) return null;
        const authorized = await readAuthorizedDigestSetting(db, item.id, item.organizationId);
        if (!authorized) {
          await db.pharmacyOwnerDigestSetting.update({
            where: { id: item.id },
            data: { enabled: false, nextDueAt: null },
          });
          return null;
        }
        // A delayed retry belongs to the scheduled local day, not the retry day.
        const businessDate = localClock(setting.nextDueAt, authorized.organization.timezone).date;
        const key = {
          organizationId: item.organizationId,
          userId: authorized.userId,
          branchId: authorized.branchId,
          businessDate,
        };
        const existing = await db.pharmacyOwnerDigestCapture.findUnique({
          where: { organizationId_userId_branchId_businessDate: key },
          select: { id: true },
        });
        if (existing) return null;
        await refreshPharmacyAnomalySignals(
          db,
          { branchIds: [authorized.branchId], from: businessDate, to: businessDate },
          'system:owner-digest',
          new Date()
        );
        const digest = await composeOwnerDigest(db, {
          ...key,
          branchName: authorized.branch.name,
          ownerPhone: authorized.user.phone,
          whatsappPhoneHash: authorized.whatsappPhoneHash,
          timezone: authorized.organization.timezone,
        });
        if (!(await readAuthorizedDigestSetting(db, item.id, item.organizationId))) {
          // Throw through withTenantDb so the claim and anomaly writes roll back.
          throw new DigestAuthorityChanged();
        }
        const queueWhatsApp = whatsapp.recipientFor(
          item.organizationId,
          authorized.user.phone,
          authorized.whatsappPhoneHash
        );
        const captured = await new CaptureChannel().deliver(db, digest, {
          whatsappParameters: queueWhatsApp ? ownerDigestWhatsAppParameters(digest) : null,
        });
        return captured.delivered ? digest : null;
      }).catch((error: unknown) => {
        if (error instanceof DigestAuthorityChanged) return null;
        throw error;
      });
      if (digest) captured += 1;
    } catch {
      // One tenant's query or capture failure must not abort other jobs/owners.
      failed += 1;
    }
  }

  // Drain durable WhatsApp work, including work left by an earlier failed run.
  if (whatsapp.configured) {
    const pending = await withPlatformDb((db) =>
      db.pharmacyOwnerDigestCapture.findMany({
        where: { whatsappPendingAt: { not: null } },
        orderBy: { whatsappPendingAt: 'asc' },
        take: Math.max(1, Math.min(100, Math.floor(limit))),
        select: {
          id: true,
          organizationId: true,
          userId: true,
          branchId: true,
          businessDate: true,
        },
      })
    ).catch(() => {
      // Captures already committed; their pending work stays queued for the next run.
      failed += 1;
      return [];
    });
    for (const item of pending) {
      try {
        // A failure here rolls back with the work still pending, so a later run retries it.
        const reservation = await reserveOwnerDigestWhatsApp(whatsapp, item, new Date());
        if (!reservation) continue;
        const delivery = await whatsapp.deliverReserved(reservation);
        if (delivery.reference === 'FAILED' || delivery.reference === 'UNKNOWN') failed += 1;
      } catch {
        // Leave committed message claims intact; an uncertain send must never be retried.
        failed += 1;
      }
    }
  }
  return { due: due.length, captured, failed };
}
