import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import { readPharmacyOwnerCommandCentre } from '@/lib/pharmacy/reports';
import { type ScopedDb, withTenantDb } from '@/lib/tenancy/scoped-db';

type Snapshot = Awaited<ReturnType<typeof readPharmacyOwnerCommandCentre>>;

export type RenderedDigest = {
  organizationId: string;
  branchId: string;
  businessDate: string;
  rendered: string;
  metrics: Snapshot['metrics'];
};

const money = (minor: number | null) =>
  minor == null ? 'Unavailable' : `PKR ${(minor / 100).toFixed(2)}`;

export function composeDailyOwnerDigest(input: {
  organizationId: string;
  branchId: string;
  branchName: string;
  businessDate: string;
  snapshot: Snapshot;
}): RenderedDigest {
  const m = input.snapshot.metrics;
  return {
    organizationId: input.organizationId,
    branchId: input.branchId,
    businessDate: input.businessDate,
    metrics: m,
    rendered: [
      `Daily owner digest · ${input.branchName} · ${input.businessDate}`,
      `Sales ${money(m.salesMinor)} · margin ${money(m.marginMinor)}`,
      `Cash variance ${money(m.cashVarianceMinor)} · refunds ${money(m.refundsMinor)}`,
      `Stockouts/signals ${m.openStockSignals} · expiry risk ≤30d ${money(m.expiryValueMinor30)}`,
      `Recalls ${m.openRecalls} · quarantine ${m.quarantineUnits} units · safety queue ${m.safetyQueue}`,
      `Offline/fiscal ${m.deviceFiscalOfflineExceptions ?? 'Unavailable in RPT-01'}`,
      `As of ${input.snapshot.freshness.asOf}`,
    ].join('\n'),
  };
}

export interface DigestChannel {
  readonly key: 'CAPTURE' | 'WHATSAPP';
  deliver(db: ScopedDb, digest: RenderedDigest): Promise<{ status: string }>;
}

export class CaptureChannel implements DigestChannel {
  readonly key = 'CAPTURE' as const;
  async deliver(db: ScopedDb, digest: RenderedDigest) {
    await db.pharmacyOwnerDigest.upsert({
      where: {
        organizationId_branchId_businessDate_channel: {
          organizationId: digest.organizationId,
          branchId: digest.branchId,
          businessDate: digest.businessDate,
          channel: this.key,
        },
      },
      create: {
        organizationId: digest.organizationId,
        branchId: digest.branchId,
        businessDate: digest.businessDate,
        channel: this.key,
        deliveryStatus: 'CAPTURED',
        rendered: digest.rendered,
        metrics: digest.metrics as Prisma.InputJsonValue,
      },
      update: {},
    });
    return { status: 'CAPTURED' };
  }
}

export class WhatsAppChannel implements DigestChannel {
  readonly key = 'WHATSAPP' as const;
  async deliver(db: ScopedDb, digest: RenderedDigest): Promise<{ status: string }> {
    void db;
    void digest;
    const configured = Boolean(
      process.env.WHATSAPP_PROVIDER_URL && process.env.WHATSAPP_PROVIDER_TOKEN
    );
    throw new Error(
      configured
        ? 'WhatsApp delivery is not implemented; no message was sent.'
        : 'WhatsApp delivery is disabled until a real provider is configured.'
    );
  }
}

export async function captureDailyOwnerDigests(organizationId: string, businessDate: string) {
  const branches = await withTenantDb(organizationId, (db) =>
    db.pharmacyBranch.findMany({
      where: { organizationId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    })
  );
  const channel = new CaptureChannel();
  for (const branch of branches) {
    await withTenantDb(organizationId, async (db) => {
      const snapshot = await readPharmacyOwnerCommandCentre(db, {
        branchIds: [branch.id],
        from: businessDate,
        to: businessDate,
      });
      await channel.deliver(
        db,
        composeDailyOwnerDigest({
          organizationId,
          branchId: branch.id,
          branchName: branch.name,
          businessDate,
          snapshot,
        })
      );
    });
  }
  return { captured: branches.length };
}
