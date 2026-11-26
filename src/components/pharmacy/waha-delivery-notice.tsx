import { unstable_rethrow } from 'next/navigation';
import { createTRPCContext } from '@/server/trpc';
import { hasModule } from '@/lib/entitlements';
import { deliveryNotice } from '@/lib/pharmacy/whatsapp/waha-staff-notice';

async function readNotice() {
  try {
    const ctx = await createTRPCContext();
    const org = ctx.organization;
    if (
      !org ||
      ctx.session?.user?.organizationId !== org.id ||
      org.vertical !== 'PHARMACY' ||
      org.isDemo ||
      !hasModule(ctx.entitlements, 'pharmacy-core')
    )
      return null;
    // Staff receive a business-level delivery notice. Credentials and recipient details stay private.
    const [result] = await ctx.db.$queryRaw<{ outcome: string | null }[]>`
    SELECT CASE WHEN s."restrictionCode" IS NOT NULL THEN 'RESTRICTED'
      WHEN s.status IN ('STOPPED','FAILED','DISCONNECTED') THEN 'DISCONNECTED'
      ELSE (SELECT a.outcome FROM pharmacy_waha_attempts a
            WHERE a."organizationId"=s."organizationId" AND a."createdAt">now()-interval '24 hours'
            AND a.outcome IN ('NOT_ON_WHATSAPP','UNAVAILABLE','UNKNOWN') ORDER BY a."createdAt" DESC LIMIT 1)
      END AS outcome FROM pharmacy_waha_sessions s WHERE s."organizationId"=${org.id}`;
    return deliveryNotice(result?.outcome ?? null);
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

export async function WahaDeliveryNotice() {
  const notice = await readNotice();
  return notice ? (
    <p
      role="status"
      className="mb-3 rounded-control border border-border-subtle bg-surface-card px-4 py-3 text-sm text-text-body"
    >
      {notice}
    </p>
  ) : null;
}
