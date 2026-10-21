import { demoSeatFromOrganizationId as seatFromOrganizationId } from '@/lib/tenancy/demo-identity';
export { demoSeatSlug, demoOrganizationId } from '@/lib/tenancy/demo-identity';

export const DEMO_SESSION_MAX_AGE = 12 * 60 * 60;
export const DEMO_ACCESS_COOKIE = 'df_demo_access';

const DEFAULT_SEAT_COUNT = 5;
const MAX_SEAT_COUNT = 25;

export function getDemoSeatCount(): number {
  const parsed = Number(process.env.DEMO_SEATS);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_SEAT_COUNT
    ? parsed
    : DEFAULT_SEAT_COUNT;
}

export function isDemoEnabled(): boolean {
  return Boolean(process.env.DEMO_ACCESS_CODE?.trim());
}

export function demoSeatName(seat: number): string {
  return `Demo Restaurant — Seat ${seat}`;
}

export function demoManagerEmail(seat: number): string {
  return `manager.seat${seat}@demo.devfathom.invalid`;
}

export function demoManagerId(seat: number): string {
  return `user_demo_restaurant_seat_${seat}_manager`;
}

export function demoSeatFromOrganizationId(organizationId: string): number | null {
  return seatFromOrganizationId(organizationId, getDemoSeatCount());
}
