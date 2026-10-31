import type { Metadata } from 'next';

import { RestaurantStaffConsole } from '@/components/restaurant/restaurant-staff-console';

export const metadata: Metadata = { title: 'Restaurant staff' };

export default async function RestaurantStaffPage({
  searchParams,
}: {
  searchParams: Promise<{ invitedEmail?: string | string[] }>;
}) {
  const query = await searchParams;
  const invitedEmail =
    typeof query.invitedEmail === 'string' && query.invitedEmail.length <= 320
      ? query.invitedEmail.trim().toLowerCase() || undefined
      : undefined;
  return <RestaurantStaffConsole key={invitedEmail ?? 'staff'} invitedEmail={invitedEmail} />;
}
