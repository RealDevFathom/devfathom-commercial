import 'server-only';

import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { demandDateAfter, demandDateMs, safeDemandTotal } from './demand-evidence';
import {
  DEFAULT_SPIKE_DETECTION_CONFIG,
  SEASONAL_WINDOW_KINDS,
  detectDemandSpikes,
  validateSeasonalWindows,
  validateSpikeDetectionConfig,
  type DemandSpike,
  type SeasonalWindow,
  type SpikeDetectionConfig,
} from './seasonal-calendar';

const id = z.string().trim().min(1).max(128);
const date = z.iso.date();

export const seasonalWindowInput = z
  .object({
    branchId: id,
    /** Omit to add a window; pass to edit that window. */
    id: id.optional(),
    kind: z.enum(SEASONAL_WINDOW_KINDS),
    label: z.string().trim().min(1).max(80),
    startDate: date,
    endDateExclusive: date,
  })
  .strict();

export const saltSpikeInput = z
  .object({
    branchId: id,
    from: date,
    to: date,
    config: z
      .object({
        baselineDays: z.number().int().min(1).max(366),
        minBaselineDays: z.number().int().min(1).max(366),
        thresholdBps: z.number().int().min(10_001).max(1_000_000),
        minExcessUnits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .partial()
      .optional(),
  })
  .strict();

export type SeasonalWindowRecord = SeasonalWindow & { id: string; branchId: string };

type Scope = { organizationId: string; branchId: string };

const MAX_WINDOWS_PER_BRANCH = 200;
const MAX_SPIKE_DAYS = 92;
const MAX_SALE_LINES = 100_000;

const dateLabel = (value: Date) => value.toISOString().slice(0, 10);

function toRecord(row: {
  id: string;
  branchId: string;
  kind: string;
  label: string;
  startDate: Date;
  endDate: Date;
}): SeasonalWindowRecord {
  return {
    id: row.id,
    branchId: row.branchId,
    kind: row.kind as SeasonalWindow['kind'],
    label: row.label,
    startDate: dateLabel(row.startDate),
    endDateExclusive: dateLabel(row.endDate),
  };
}

const windowSelect = {
  id: true,
  branchId: true,
  kind: true,
  label: true,
  startDate: true,
  endDate: true,
} as const;

/** Caller authorizes the branch; this read is additionally bound to organization and branch. */
export async function listSeasonalWindows(
  db: ScopedDb,
  scope: Scope
): Promise<SeasonalWindowRecord[]> {
  const rows = await db.pharmacySeasonalWindow.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    select: windowSelect,
    take: MAX_WINDOWS_PER_BRANCH,
  });
  return rows.map(toRecord);
}

/** Server-side validation of the window itself; ownership is enforced by the caller. */
export async function saveSeasonalWindow(
  db: ScopedDb,
  scope: Scope & { actorId: string },
  input: z.infer<typeof seasonalWindowInput>
): Promise<SeasonalWindowRecord> {
  const parsed = seasonalWindowInput.parse(input);
  if (parsed.branchId !== scope.branchId) throw new RangeError('Branch scope mismatch');
  validateSeasonalWindows([parsed]);
  const data = {
    kind: parsed.kind,
    label: parsed.label,
    startDate: new Date(demandDateMs(parsed.startDate)),
    endDate: new Date(demandDateMs(parsed.endDateExclusive)),
    updatedByUserId: scope.actorId,
  };
  if (parsed.id) {
    const updated = await db.pharmacySeasonalWindow.updateMany({
      where: { id: parsed.id, organizationId: scope.organizationId, branchId: scope.branchId },
      data,
    });
    if (updated.count !== 1) throw new RangeError('Seasonal window not found');
    const row = await db.pharmacySeasonalWindow.findFirstOrThrow({
      where: { id: parsed.id, organizationId: scope.organizationId, branchId: scope.branchId },
      select: windowSelect,
    });
    return toRecord(row);
  }
  const count = await db.pharmacySeasonalWindow.count({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (count >= MAX_WINDOWS_PER_BRANCH) throw new RangeError('Seasonal window limit reached');
  const row = await db.pharmacySeasonalWindow.create({
    data: {
      ...data,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdByUserId: scope.actorId,
    },
    select: windowSelect,
  });
  return toRecord(row);
}

export async function deleteSeasonalWindow(
  db: ScopedDb,
  scope: Scope,
  windowId: string
): Promise<void> {
  const deleted = await db.pharmacySeasonalWindow.deleteMany({
    where: { id: windowId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (deleted.count !== 1) throw new RangeError('Seasonal window not found');
}

export type SaltSpikeReport = {
  scope: Scope;
  period: { from: string; to: string };
  label: 'ESTIMATE';
  config: SpikeDetectionConfig;
  salts: { ingredientId: string; name: string; spikes: DemandSpike[] }[];
  limitations: readonly string[];
};

/**
 * Per-salt daily completed-sale units for one branch, judged against each salt's own trailing
 * baseline. Read-only; never sent over WhatsApp or any outbound channel.
 */
export async function readSaltDemandSpikes(
  db: ScopedDb,
  scope: Scope,
  input: z.infer<typeof saltSpikeInput>
): Promise<SaltSpikeReport> {
  const parsed = saltSpikeInput.parse(input);
  if (parsed.branchId !== scope.branchId) throw new RangeError('Branch scope mismatch');
  const config = { ...DEFAULT_SPIKE_DETECTION_CONFIG, ...parsed.config };
  validateSpikeDetectionConfig(config);
  const fromMs = demandDateMs(parsed.from);
  const toMs = demandDateMs(parsed.to);
  if (toMs < fromMs || (toMs - fromMs) / 86_400_000 + 1 > MAX_SPIKE_DAYS)
    throw new RangeError(`Use a period of 1..${MAX_SPIKE_DAYS} days`);
  const historyStart = demandDateAfter(parsed.from, -config.baselineDays);
  const lines = await db.pharmacySaleLine.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      sale: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'COMPLETED',
        businessDate: {
          gte: new Date(demandDateMs(historyStart)),
          lt: new Date(demandDateMs(demandDateAfter(parsed.to, 1))),
        },
      },
    },
    select: { medicineId: true, canonicalUnits: true, sale: { select: { businessDate: true } } },
    take: MAX_SALE_LINES + 1,
  });
  if (lines.length > MAX_SALE_LINES)
    throw new RangeError('Sale line limit exceeded; narrow the period');
  const medicineIds = [...new Set(lines.map((line) => line.medicineId))];
  const components = medicineIds.length
    ? await db.medicineStrengthComponent.findMany({
        where: { organizationId: scope.organizationId, medicineId: { in: medicineIds } },
        select: { medicineId: true, ingredient: { select: { id: true, name: true } } },
      })
    : [];
  const saltsByMedicine = new Map<string, Map<string, string>>();
  for (const component of components) {
    const salts = saltsByMedicine.get(component.medicineId) ?? new Map<string, string>();
    salts.set(component.ingredient.id, component.ingredient.name);
    saltsByMedicine.set(component.medicineId, salts);
  }
  const names = new Map<string, string>();
  const series = new Map<string, Map<string, number>>();
  for (const line of lines) {
    if (!line.sale.businessDate) continue;
    const day = dateLabel(line.sale.businessDate);
    for (const [ingredientId, name] of saltsByMedicine.get(line.medicineId) ?? []) {
      names.set(ingredientId, name);
      const days = series.get(ingredientId) ?? new Map<string, number>();
      days.set(day, safeDemandTotal([days.get(day) ?? 0, line.canonicalUnits]));
      series.set(ingredientId, days);
    }
  }
  const salts = [...series.entries()]
    .map(([ingredientId, days]) => ({
      ingredientId,
      name: names.get(ingredientId)!,
      // Days with no recorded sale stay unknown rather than zero.
      spikes: detectDemandSpikes({
        days: [...days.entries()].map(([day, units]) => ({ date: day, units })),
        fromDate: parsed.from,
        config,
      }),
    }))
    .filter((salt) => salt.spikes.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    scope,
    period: { from: parsed.from, to: parsed.to },
    label: 'ESTIMATE',
    config,
    salts,
    limitations: [
      'Completed-sale units by business date, not uncensored demand; returns are not netted.',
      'Days without a recorded sale are skipped, not treated as zero demand.',
      'A multi-salt product counts toward each of its salts; units mix strengths and pack sizes.',
      'Thresholds are configurable defaults, not clinical or epidemiological findings.',
    ],
  };
}
