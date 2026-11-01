import type { Metadata } from 'next';
import {
  PHARMACY_DAY_CLOSE_DENIED,
  PharmacyDayCloseConsole,
} from '@/components/pharmacy/counter/day-close-console';
import { SectionCard } from '@/components/ui/section-card';
import { readPharmacyStaffAccess } from '@/lib/pharmacy/staff-access';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy day close' };

export default async function PharmacyDayClosePage() {
  // Server-side gate, the same rule `requireCloseAccess` applies to every
  // day-close procedure: a cashier reaching this URL directly gets the refusal,
  // never the console.
  const ctx = await createTRPCContext();
  const access = await readPharmacyStaffAccess(ctx.session?.user, ctx.db);
  if (!access.dayClose) {
    return (
      <SectionCard title="Day close unavailable">
        <p role="status" className="text-sm text-text-body">
          {PHARMACY_DAY_CLOSE_DENIED}
        </p>
      </SectionCard>
    );
  }
  return <PharmacyDayCloseConsole />;
}
