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

export function demoSeatSlug(seat: number): string {
  return `demo-restaurant-seat-${seat}`;
}

export function demoManagerEmail(seat: number): string {
  return `manager.seat${seat}@demo.devfathom.invalid`;
}

export function demoOrganizationId(seat: number): string {
  return `org_demo_restaurant_seat_${seat}`;
}

export function demoManagerId(seat: number): string {
  return `user_demo_restaurant_seat_${seat}_manager`;
}

export function demoSeatFromOrganizationId(organizationId: string): number | null {
  const match = /^org_demo_restaurant_seat_(\d+)$/.exec(organizationId);
  const seat = match ? Number(match[1]) : 0;
  return Number.isInteger(seat) && seat >= 1 && seat <= getDemoSeatCount() ? seat : null;
}
