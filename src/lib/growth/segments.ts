import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const days = 86_400_000;
export const segmentInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }).strict(),
  z
    .object({ type: z.literal('churn_band'), band: z.enum(['low', 'medium', 'high', 'lost']) })
    .strict(),
  z
    .object({
      type: z.literal('birthday'),
      month: z.number().int().min(1).max(12),
      dayWindow: z.number().int().min(0).max(31),
    })
    .strict(),
  z.object({ type: z.literal('refill_due'), withinDays: z.number().int().min(0).max(30) }).strict(),
  z
    .object({
      type: z.literal('random'),
      pct: z.number().min(0).max(100),
      seed: z.string().min(1).max(128),
    })
    .strict(),
  z.object({ type: z.literal('top_spenders'), n: z.number().int().min(1).max(50000) }).strict(),
  z
    .object({
      type: z.literal('inactive_days'),
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
    })
    .strict()
    .refine((s) => s.max >= s.min),
]);
export type Segment = z.infer<typeof segmentInput>;
export type Candidate = {
  id: string;
  whatsappOptIn: boolean;
  whatsappE164: string | null;
  active: boolean;
  patient: { dateOfBirth: Date | null };
  growthMetrics: {
    churnBand: string;
    nextRefillDueAt: Date | null;
    lastPurchaseAt: Date | null;
    spend90dMinor: number;
  } | null;
  growthRecipients: Array<{ sentAt: Date | null }>;
};
export function sampleKey(id: string, seed: string) {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}
export function selectSegment(candidates: Candidate[], raw: unknown, now: Date): string[] {
  const segment = segmentInput.parse(raw);
  let selected = candidates.filter((c) => {
    if (
      !c.active ||
      !c.whatsappOptIn ||
      !c.whatsappE164 ||
      c.growthRecipients.some((r) => r.sentAt && r.sentAt.getTime() >= now.getTime() - 7 * days)
    )
      return false;
    const m = c.growthMetrics;
    switch (segment.type) {
      case 'all':
      case 'top_spenders':
        return true;
      case 'churn_band':
        return m?.churnBand === segment.band;
      case 'refill_due':
        return (
          !!m?.nextRefillDueAt &&
          m.nextRefillDueAt >= now &&
          m.nextRefillDueAt.getTime() <= now.getTime() + segment.withinDays * days
        );
      case 'random':
        return (
          parseInt(sampleKey(c.id, segment.seed).slice(0, 8), 16) / 0x100000000 < segment.pct / 100
        );
      case 'inactive_days': {
        if (!m?.lastPurchaseAt) return false;
        const age = Math.floor((now.getTime() - m.lastPurchaseAt.getTime()) / days);
        return age >= segment.min && age <= segment.max;
      }
      case 'birthday': {
        const dob = c.patient.dateOfBirth;
        if (!dob || dob.getUTCMonth() + 1 !== segment.month) return false;
        const birthday = Date.UTC(now.getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate());
        return (
          Math.abs(
            birthday - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
          ) <=
          segment.dayWindow * days
        );
      }
    }
  });
  if (segment.type === 'top_spenders')
    selected = selected
      .sort(
        (a, b) =>
          (b.growthMetrics?.spend90dMinor ?? 0) - (a.growthMetrics?.spend90dMinor ?? 0) ||
          a.id.localeCompare(b.id)
      )
      .slice(0, segment.n);
  return selected.map((c) => c.id);
}
export async function materializeSegment(
  db: ScopedDb,
  organizationId: string,
  segment: unknown,
  now: Date
) {
  const candidates = await db.pharmacyCustomer.findMany({
    where: { organizationId, active: true, whatsappOptIn: true, whatsappE164: { not: null } },
    include: {
      patient: { select: { dateOfBirth: true } },
      growthMetrics: true,
      growthRecipients: {
        where: { organizationId, sentAt: { gte: new Date(now.getTime() - 7 * days) } },
        select: { sentAt: true },
      },
    },
    orderBy: { id: 'asc' },
  });
  return selectSegment(candidates, segment, now);
}
