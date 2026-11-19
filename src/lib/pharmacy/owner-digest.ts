import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { PHARMACY_METRIC_CONTRACT, readPharmacyOwnerCommandCentre } from './reports';
import {
  readPharmacyAnomalySignals,
  refreshPharmacyAnomalySignals,
  renderAnomalyDigest,
} from './anomaly-signals-operations';
import {
  buildOwnerBriefing,
  isWeeklyBriefingDay,
  ownerBriefingConfig,
  ownerBriefingWindow,
  readOwnerBriefingDemand,
  renderOwnerBriefingApp,
  renderOwnerBriefingWhatsApp,
  type OwnerBriefing,
  type OwnerBriefingCadence,
} from './owner-briefing';
import {
  renderRenewalReminderLine,
  renderRenewalWhatsApp,
  type RenewalReminder,
} from './licence-renewal';
import { readLicenceRenewalReminders } from './licence-renewal-operations';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

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
  anomalies: Awaited<ReturnType<typeof readPharmacyAnomalySignals>>;
  /** Daily briefing, plus the weekly summary on the configured weekday. */
  briefings: OwnerBriefing[];
  /** #720 — licences and registrations inside a 90/60/30/7-day renewal window. */
  renewals: RenewalReminder[];
  /** In-app text; the only rendering that names the top gap. */
  rendered: string;
  /**
   * Owner-only WhatsApp body: figures and status, never an item, salt or
   * category. Null when it fails the vocabulary guard; in-app capture still runs.
   */
  whatsappBody: string | null;
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

/** A WhatsApp guard failure must never block the in-app digest capture. */
function safeWhatsAppBody(briefings: OwnerBriefing[]): string | null {
  try {
    return briefings.map(renderOwnerBriefingWhatsApp).join('\n\n');
  } catch {
    return null;
  }
}

function joinWhatsApp(...parts: Array<string | null>): string | null {
  const present = parts.filter((part): part is string => part !== null);
  return present.length > 0 ? present.join('\n\n') : null;
}

export async function composeOwnerDigest(
  db: ScopedDb,
  input: {
    organizationId: string;
    userId: string;
    branchId: string;
    branchName: string;
    businessDate: string;
    /** Workspace zone the business date is on: bounds event timestamps (UTC when absent). */
    timeZone?: string | null;
  }
): Promise<OwnerDigest> {
  const filters = {
    branchIds: [input.branchId],
    from: input.businessDate,
    to: input.businessDate,
  };
  const [report, anomalies, renewals] = await Promise.all([
    readPharmacyOwnerCommandCentre(db, { ...filters, timeZone: input.timeZone }),
    // The same workspace-day window the scheduled refresh stored the signals under.
    readPharmacyAnomalySignals(db, { ...filters, timeZone: input.timeZone }),
    // Additive line: an unreadable reminder never blocks the digest itself.
    readLicenceRenewalReminders(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      timeZone: input.timeZone,
    }).catch((): RenewalReminder[] => []),
  ]);
  const config = ownerBriefingConfig();
  const cadences: OwnerBriefingCadence[] = isWeeklyBriefingDay(input.businessDate, config)
    ? ['DAILY', 'WEEKLY']
    : ['DAILY'];
  const briefings: OwnerBriefing[] = [];
  for (const cadence of cadences) {
    // Lost demand, recovered sales and the weekly ledger read the shop's own days,
    // the days the digest is labelled with, not UTC days.
    const window = ownerBriefingWindow(input.businessDate, cadence, config, input.timeZone);
    const [ledger, demand] = await Promise.all([
      cadence === 'DAILY'
        ? Promise.resolve(report)
        : readPharmacyOwnerCommandCentre(db, {
            branchIds: [input.branchId],
            from: window.from,
            to: window.to,
            timeZone: input.timeZone,
          }),
      readOwnerBriefingDemand(db, input, window, config),
    ]);
    briefings.push(buildOwnerBriefing(window, ledger.metrics, demand, config));
  }
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
    anomalies,
    briefings,
    renewals,
    rendered: [
      `Daily owner digest · ${input.branchName} · ${input.businessDate}`,
      ...briefings.map(renderOwnerBriefingApp),
      ...metrics.map((metric) => `${metric.label}: ${renderValue(metric.key, metric.value)}`),
      ...renderAnomalyDigest(anomalies),
      ...renewals.map(renderRenewalReminderLine),
      `As of ${report.freshness.asOf}`,
    ].join('\n'),
    whatsappBody: joinWhatsApp(safeWhatsAppBody(briefings), renderRenewalWhatsApp(renewals)),
  };
}

export class CaptureChannel implements DigestChannel {
  readonly name = 'capture';

  async deliver(db: ScopedDb, digest: OwnerDigest) {
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

/**
 * Provider seam only. No request is made and no send is claimed. When wired, it
 * must send `digest.whatsappBody` (never `rendered`) to the owner only.
 */
export class WhatsAppChannel implements DigestChannel {
  readonly name = 'whatsapp';
  readonly configured = Boolean(
    process.env.PHARMACY_WHATSAPP_PROVIDER && process.env.PHARMACY_WHATSAPP_ACCESS_TOKEN
  );

  async deliver() {
    return { delivered: false };
  }
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
        select: { id: true, organizationId: true, status: true, role: true, department: true },
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
  for (const item of due) {
    const delivered = await withTenantDb(item.organizationId, async (db) => {
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
      if (!setting?.nextDueAt) return false;
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
      if (claim.count !== 1) return false;
      const authorized = await readAuthorizedDigestSetting(db, item.id, item.organizationId);
      if (!authorized) {
        await db.pharmacyOwnerDigestSetting.update({
          where: { id: item.id },
          data: { enabled: false, nextDueAt: null },
        });
        return false;
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
      if (existing) return false;
      await refreshPharmacyAnomalySignals(
        db,
        {
          branchIds: [authorized.branchId],
          from: businessDate,
          to: businessDate,
          timeZone: authorized.organization.timezone,
        },
        'system:owner-digest',
        new Date()
      );
      const digest = await composeOwnerDigest(db, {
        ...key,
        branchName: authorized.branch.name,
        timeZone: authorized.organization.timezone,
      });
      if (!(await readAuthorizedDigestSetting(db, item.id, item.organizationId))) {
        // Throw through withTenantDb so the claim and anomaly writes roll back.
        throw new DigestAuthorityChanged();
      }
      return (await new CaptureChannel().deliver(db, digest)).delivered;
    }).catch((error: unknown) => {
      if (error instanceof DigestAuthorityChanged) return false;
      throw error;
    });
    if (delivered) captured += 1;
  }
  return { due: due.length, captured };
}
