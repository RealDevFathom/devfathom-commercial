import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceDateRange } from '@/lib/timezone';

/**
 * DEV-78 — the owner's five-line briefing (daily, plus a weekly summary).
 *
 * Every figure is read from tenant data. Window lengths, the expiry horizon,
 * the weekly day and the purchase-order look-back are configuration, never
 * research example numbers. The WhatsApp body is built only from figures and a
 * fixed vocabulary: it never names an item, salt or category. Item names for
 * the top gap appear only in the in-app rendering.
 */

export type OwnerBriefingCadence = 'DAILY' | 'WEEKLY';

const EXPIRY_HORIZONS = [30, 60, 90, 180] as const;
type ExpiryHorizon = (typeof EXPIRY_HORIZONS)[number];

export type OwnerBriefingConfig = {
  /** Days in the weekly summary window, ending on the business date. */
  weeklyDays: number;
  /** UTC weekday of the business date (0 = Sunday) that carries the weekly summary. */
  weeklyWeekday: number;
  /** Which RPT-01 expiry bucket the briefing reports as "at risk". */
  expiryHorizonDays: ExpiryHorizon;
  /** How far before the window a purchase order or requisition still counts for the top gap. */
  purchaseLookbackDays: number;
};

export const DEFAULT_OWNER_BRIEFING_CONFIG: OwnerBriefingConfig = {
  weeklyDays: 7,
  weeklyWeekday: 1,
  expiryHorizonDays: 30,
  purchaseLookbackDays: 30,
};

function intInRange(raw: string | undefined, min: number, max: number, fallback: number) {
  if (raw == null || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : fallback;
}

export function ownerBriefingConfig(env: NodeJS.ProcessEnv = process.env): OwnerBriefingConfig {
  const expiry = intInRange(
    env.PHARMACY_OWNER_BRIEFING_EXPIRY_DAYS,
    0,
    365,
    DEFAULT_OWNER_BRIEFING_CONFIG.expiryHorizonDays
  );
  return {
    weeklyDays: DEFAULT_OWNER_BRIEFING_CONFIG.weeklyDays,
    weeklyWeekday: intInRange(
      env.PHARMACY_OWNER_BRIEFING_WEEKLY_WEEKDAY,
      0,
      6,
      DEFAULT_OWNER_BRIEFING_CONFIG.weeklyWeekday
    ),
    expiryHorizonDays: (EXPIRY_HORIZONS as readonly number[]).includes(expiry)
      ? (expiry as ExpiryHorizon)
      : DEFAULT_OWNER_BRIEFING_CONFIG.expiryHorizonDays,
    purchaseLookbackDays: intInRange(
      env.PHARMACY_OWNER_BRIEFING_PURCHASE_LOOKBACK_DAYS,
      0,
      365,
      DEFAULT_OWNER_BRIEFING_CONFIG.purchaseLookbackDays
    ),
  };
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== date)
    throw new Error('Briefing dates must be YYYY-MM-DD calendar dates.');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Inclusive date labels plus the matching half-open instant window on the
 * workspace's clock: the shop's own days, the same days the labels name. UTC
 * when the zone is absent or one Intl refuses, which is the window this always
 * used before it followed the shop's day.
 */
export function ownerBriefingWindow(
  businessDate: string,
  cadence: OwnerBriefingCadence,
  config: OwnerBriefingConfig = DEFAULT_OWNER_BRIEFING_CONFIG,
  timeZone?: string | null
) {
  const days = cadence === 'WEEKLY' ? config.weeklyDays : 1;
  const from = shiftDate(businessDate, -(days - 1));
  const range = workspaceDateRange(from, businessDate, timeZone);
  return {
    cadence,
    days,
    from,
    to: businessDate,
    startsAt: range.from,
    endsBefore: range.to,
  };
}

export type OwnerBriefingWindow = ReturnType<typeof ownerBriefingWindow>;

export function isWeeklyBriefingDay(
  businessDate: string,
  config: OwnerBriefingConfig = DEFAULT_OWNER_BRIEFING_CONFIG
) {
  return new Date(`${businessDate}T00:00:00.000Z`).getUTCDay() === config.weeklyWeekday;
}

export type TopGapPurchaseStatus =
  | 'UNMATCHED'
  | 'NONE'
  | 'REQUISITION_DRAFT'
  | 'REQUISITION_SUBMITTED'
  | 'REQUISITION_APPROVED'
  | 'PO_DRAFT'
  | 'PO_SUBMITTED'
  | 'PO_APPROVED'
  | 'PO_SENT'
  | 'PO_RECEIVING';

export type OwnerBriefingDemand = {
  lostDemandMinor: number;
  walkOuts: number;
  unvaluedWalkOuts: number;
  recoveredMinor: number;
  recoveredCount: number;
  topGap: {
    /** In-app only. Never rendered into WhatsApp text. */
    displayName: string;
    /** Every name the gap is known by; in-app only, never rendered into WhatsApp. */
    names: string[];
    lostMinor: number;
    walkOuts: number;
    purchaseStatus: TopGapPurchaseStatus;
  } | null;
};

function safeSum(values: Array<number | null | undefined>) {
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (!Number.isSafeInteger(total))
    throw new Error('Briefing total exceeds the safe integer range.');
  return total;
}

async function readTopGapPurchaseStatus(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  medicineId: string,
  since: Date
): Promise<TopGapPurchaseStatus> {
  const order = await db.pharmacyPurchaseOrderLine.findFirst({
    where: {
      organizationId: scope.organizationId,
      medicineId,
      purchaseOrder: {
        branchId: scope.branchId,
        status: { not: 'CANCELLED' },
        createdAt: { gte: since },
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { purchaseOrder: { select: { status: true } } },
  });
  if (order) return `PO_${order.purchaseOrder.status}` as TopGapPurchaseStatus;
  const requisition = await db.pharmacyRequisitionLine.findFirst({
    where: {
      organizationId: scope.organizationId,
      medicineId,
      requisition: {
        branchId: scope.branchId,
        status: { not: 'CANCELLED' },
        createdAt: { gte: since },
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { requisition: { select: { status: true } } },
  });
  if (requisition) return `REQUISITION_${requisition.requisition.status}` as TopGapPurchaseStatus;
  return 'NONE';
}

/** Lost demand, walk-outs, the top gap and recovered sales for one branch window. */
export async function readOwnerBriefingDemand(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  window: OwnerBriefingWindow,
  config: OwnerBriefingConfig = DEFAULT_OWNER_BRIEFING_CONFIG
): Promise<OwnerBriefingDemand> {
  const inWindow = { gte: window.startsAt, lt: window.endsBefore };
  const [events, recovered] = await Promise.all([
    db.unfulfilledDemandEvent.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        createdAt: inWindow,
      },
      select: { requestedMedicineId: true, requestedText: true, estimatedValueMinor: true },
    }),
    db.unfulfilledDemandEvent.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'RECOVERED',
        recoveredAt: inWindow,
        recoveredSaleLineId: { not: null },
      },
      select: { recoveredSaleLineId: true },
    }),
  ]);

  const recoveredLineIds = [
    ...new Set(recovered.map((row) => row.recoveredSaleLineId).filter((id): id is string => !!id)),
  ];
  const recoveredLines = recoveredLineIds.length
    ? await db.pharmacySaleLine.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          id: { in: recoveredLineIds },
        },
        select: { grossMinor: true, discountMinor: true },
      })
    : [];

  const groups = new Map<
    string,
    { medicineId: string | null; text: string | null; lostMinor: number; walkOuts: number }
  >();
  for (const event of events) {
    const text = event.requestedText?.trim() || null;
    const key = event.requestedMedicineId
      ? `m:${event.requestedMedicineId}`
      : `t:${(text ?? '').toLowerCase()}`;
    const group = groups.get(key) ?? {
      medicineId: event.requestedMedicineId,
      text,
      lostMinor: 0,
      walkOuts: 0,
    };
    group.lostMinor = safeSum([group.lostMinor, event.estimatedValueMinor]);
    group.walkOuts += 1;
    groups.set(key, group);
  }
  const top = [...groups.values()].sort(
    (a, b) => b.lostMinor - a.lostMinor || b.walkOuts - a.walkOuts
  )[0];

  let topGap: OwnerBriefingDemand['topGap'] = null;
  if (top) {
    const medicine = top.medicineId
      ? await db.medicine.findFirst({
          where: { id: top.medicineId },
          select: { productName: true, brandName: true },
        })
      : null;
    const names = [medicine?.brandName, medicine?.productName, top.text].filter(
      (name): name is string => !!name && name.trim().length > 0
    );
    const since = new Date(window.startsAt);
    since.setUTCDate(since.getUTCDate() - config.purchaseLookbackDays);
    topGap = {
      displayName: names[0] ?? 'Unnamed request',
      names,
      lostMinor: top.lostMinor,
      walkOuts: top.walkOuts,
      purchaseStatus: top.medicineId
        ? await readTopGapPurchaseStatus(db, scope, top.medicineId, since)
        : 'UNMATCHED',
    };
  }

  return {
    lostDemandMinor: safeSum(events.map((event) => event.estimatedValueMinor)),
    walkOuts: events.length,
    unvaluedWalkOuts: events.filter((event) => event.estimatedValueMinor == null).length,
    recoveredMinor: safeSum(recoveredLines.map((line) => line.grossMinor - line.discountMinor)),
    recoveredCount: recoveredLineIds.length,
    topGap,
  };
}

/** The RPT-01 command-centre figures the briefing reuses (sales, cash, expiry, khata). */
export type OwnerBriefingLedger = {
  salesMinor: number | null;
  cashMinor: number | null;
  expiryValueMinor30: number;
  expiryValueMinor60: number;
  expiryValueMinor90: number;
  expiryValueMinor180: number;
  khataAgingMinor: number | null;
};

export type OwnerBriefing = {
  window: OwnerBriefingWindow;
  expiryHorizonDays: ExpiryHorizon;
  salesMinor: number | null;
  cashMinor: number | null;
  expiryAtRiskMinor: number;
  khataDueMinor: number | null;
  demand: OwnerBriefingDemand;
};

export function buildOwnerBriefing(
  window: OwnerBriefingWindow,
  ledger: OwnerBriefingLedger,
  demand: OwnerBriefingDemand,
  config: OwnerBriefingConfig = DEFAULT_OWNER_BRIEFING_CONFIG
): OwnerBriefing {
  return {
    window,
    expiryHorizonDays: config.expiryHorizonDays,
    salesMinor: ledger.salesMinor,
    cashMinor: ledger.cashMinor,
    expiryAtRiskMinor: ledger[`expiryValueMinor${config.expiryHorizonDays}`],
    khataDueMinor: ledger.khataAgingMinor ?? null,
    demand,
  };
}

function pkr(minor: number | null) {
  if (minor == null) return 'not available';
  return `PKR ${Math.round(minor / 100).toLocaleString('en-US')}`;
}

const PURCHASE_LABEL: Record<TopGapPurchaseStatus, string> = {
  UNMATCHED: 'not linked to a catalogue item',
  NONE: 'no purchase order yet',
  REQUISITION_DRAFT: 'requisition draft',
  REQUISITION_SUBMITTED: 'requisition submitted',
  REQUISITION_APPROVED: 'requisition approved',
  PO_DRAFT: 'draft PO',
  PO_SUBMITTED: 'PO awaiting approval',
  PO_APPROVED: 'PO approved',
  PO_SENT: 'PO sent',
  PO_RECEIVING: 'PO receiving',
};

function heading(briefing: OwnerBriefing) {
  return briefing.window.cadence === 'WEEKLY'
    ? `Weekly summary ${briefing.window.from} to ${briefing.window.to}`
    : `Daily briefing ${briefing.window.to}`;
}

function lostLine(demand: OwnerBriefingDemand) {
  const unvalued = demand.unvaluedWalkOuts ? `, ${demand.unvaluedWalkOuts} without estimate` : '';
  return `Lost demand ${pkr(demand.lostDemandMinor)} (estimate) · ${demand.walkOuts} walk-outs${unvalued}`;
}

function sharedLines(briefing: OwnerBriefing, topGapLine: string) {
  return [
    `Sales ${pkr(briefing.salesMinor)} · Cash ${pkr(briefing.cashMinor)}`,
    lostLine(briefing.demand),
    topGapLine,
    `Recovered ${pkr(briefing.demand.recoveredMinor)} from ${briefing.demand.recoveredCount} follow-ups`,
    `Expiry at risk (${briefing.expiryHorizonDays} days) ${pkr(briefing.expiryAtRiskMinor)} · Khata due ${pkr(briefing.khataDueMinor)}`,
  ];
}

/** In-app rendering. This is the only place the top gap is named. */
export function renderOwnerBriefingApp(briefing: OwnerBriefing): string {
  const gap = briefing.demand.topGap;
  return [
    heading(briefing),
    ...sharedLines(
      briefing,
      gap
        ? `Top gap: ${gap.displayName} · ${pkr(gap.lostMinor)} lost, ${gap.walkOuts} walk-outs · ${PURCHASE_LABEL[gap.purchaseStatus]}`
        : 'Top gap: none recorded'
    ),
  ].join('\n');
}

/**
 * The only words a WhatsApp briefing may contain: the fixed template vocabulary.
 * An allowlist (not a blocklist of names) means an item, salt or category can
 * never pass, and an item whose name happens to match template wording (for
 * example a request typed as "Daily") cannot make a safe body fail.
 */
const WHATSAPP_BRIEFING_VOCABULARY = new Set(
  [
    'daily briefing weekly summary to',
    'sales pkr cash lost demand estimate walk-outs without',
    'top gap lost none recorded details in the app',
    'recovered from follow-ups',
    'expiry at risk days khata due not available',
    'linked a catalogue item no purchase order yet requisition draft submitted approved',
    'po awaiting approval sent receiving',
  ]
    .join(' ')
    .split(' ')
);

/** Throws when a WhatsApp body carries any word outside the fixed briefing vocabulary. */
export function assertWhatsAppBriefingSafe(body: string) {
  for (const [word] of body.matchAll(/\p{L}+(?:-\p{L}+)*/gu)) {
    if (!WHATSAPP_BRIEFING_VOCABULARY.has(word.toLowerCase()))
      throw new Error('WhatsApp briefing text must not name an item, salt or category.');
  }
  return body;
}

/** Utility-safe WhatsApp body for the owner: figures and status only, no names. */
export function renderOwnerBriefingWhatsApp(briefing: OwnerBriefing): string {
  const gap = briefing.demand.topGap;
  const body = [
    heading(briefing),
    ...sharedLines(
      briefing,
      gap
        ? `Top gap: ${pkr(gap.lostMinor)} lost, ${gap.walkOuts} walk-outs · ${PURCHASE_LABEL[gap.purchaseStatus]} (details in the app)`
        : 'Top gap: none recorded'
    ),
  ].join('\n');
  return assertWhatsAppBriefingSafe(body);
}
