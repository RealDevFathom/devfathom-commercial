import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { PHARMACY_METRIC_CONTRACT, readPharmacyOwnerCommandCentre } from './reports';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

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

export type OwnerDigest = {
  organizationId: string;
  userId: string;
  branchId: string;
  branchName: string;
  businessDate: string;
  freshness: CommandCentre['freshness'];
  metrics: Array<{
    key: MetricKey;
    label: string;
    definition: string;
    source: string | null;
    value: number | null;
  }>;
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

export async function composeOwnerDigest(
  db: ScopedDb,
  input: {
    organizationId: string;
    userId: string;
    branchId: string;
    branchName: string;
    businessDate: string;
  }
): Promise<OwnerDigest> {
  const report = await readPharmacyOwnerCommandCentre(db, {
    branchIds: [input.branchId],
    from: input.businessDate,
    to: input.businessDate,
  });
  const contracts = new Map(PHARMACY_METRIC_CONTRACT.map((contract) => [contract.key, contract]));
  const metrics = DIGEST_METRIC_KEYS.map((key) => {
    const contract = contracts.get(key);
    if (!contract) throw new Error(`RPT-01 metric contract missing: ${key}.`);
    return { ...contract, key, value: report.metrics[key] };
  });
  return {
    ...input,
    freshness: report.freshness,
    metrics,
    rendered: [
      `Daily owner digest · ${input.branchName} · ${input.businessDate}`,
      ...metrics.map((metric) => `${metric.label}: ${renderValue(metric.key, metric.value)}`),
      `As of ${report.freshness.asOf}`,
    ].join('\n'),
  };
}

export class CaptureChannel implements DigestChannel {
  readonly name = 'capture';

  async deliver(db: ScopedDb, digest: OwnerDigest) {
    const capture = await db.pharmacyOwnerDigestCapture.upsert({
      where: {
        organizationId_userId_branchId_businessDate: {
          organizationId: digest.organizationId,
          userId: digest.userId,
          branchId: digest.branchId,
          businessDate: digest.businessDate,
        },
      },
      update: {},
      create: {
        organizationId: digest.organizationId,
        userId: digest.userId,
        branchId: digest.branchId,
        businessDate: digest.businessDate,
        rendered: digest.rendered,
        metrics: JSON.parse(JSON.stringify(digest.metrics)) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { delivered: true, reference: capture.id };
  }
}

/** Provider seam only. No request is made and no send is claimed. */
export class WhatsAppChannel implements DigestChannel {
  readonly name = 'whatsapp';
  readonly configured = Boolean(
    process.env.PHARMACY_WHATSAPP_PROVIDER && process.env.PHARMACY_WHATSAPP_ACCESS_TOKEN
  );

  async deliver() {
    return { delivered: false };
  }
}

function localClock(at: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
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

export async function processDueOwnerDigests(now = new Date(), limit = 25) {
  const due = await withPlatformDb((db) =>
    db.pharmacyOwnerDigestSetting.findMany({
      where: { enabled: true, nextDueAt: { lte: now } },
      orderBy: { nextDueAt: 'asc' },
      take: Math.max(1, Math.min(100, Math.floor(limit))),
      select: {
        id: true,
        organizationId: true,
        userId: true,
        branchId: true,
        timeMinutes: true,
        organization: { select: { timezone: true } },
      },
    })
  );
  let captured = 0;
  for (const item of due) {
    await withTenantDb(item.organizationId, async (db) => {
      const setting = await db.pharmacyOwnerDigestSetting.findFirst({
        where: { id: item.id, enabled: true, nextDueAt: { lte: now } },
        include: {
          branch: { select: { name: true, active: true } },
          user: { select: { status: true, role: true } },
        },
      });
      if (
        !setting ||
        !setting.branch.active ||
        setting.user.status !== 'ACTIVE' ||
        setting.user.role !== 'ADMIN'
      ) {
        if (setting)
          await db.pharmacyOwnerDigestSetting.update({
            where: { id: item.id },
            data: { enabled: false, nextDueAt: null },
          });
        return;
      }
      const businessDate = localClock(now, item.organization.timezone).date;
      const digest = await composeOwnerDigest(db, {
        organizationId: item.organizationId,
        userId: item.userId,
        branchId: item.branchId,
        branchName: setting.branch.name,
        businessDate,
      });
      await new CaptureChannel().deliver(db, digest);
      await db.pharmacyOwnerDigestSetting.update({
        where: { id: item.id },
        data: { nextDueAt: nextDigestDueAt(now, item.organization.timezone, item.timeMinutes) },
      });
      captured += 1;
    });
  }
  return { due: due.length, captured };
}
