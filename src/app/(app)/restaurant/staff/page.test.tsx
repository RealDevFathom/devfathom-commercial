import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ staffConsole: vi.fn(() => null) }));
vi.mock('@/components/restaurant/restaurant-staff-console', () => ({
  RestaurantStaffConsole: mocks.staffConsole,
}));

import RestaurantStaffPage from './page';

describe('Restaurant staff invitation return', () => {
  it.each([
    [undefined, undefined],
    [[], undefined],
    [['one@example.com', 'two@example.com'], undefined],
    ['', undefined],
    ['a'.repeat(321), undefined],
    ['  AYESHA@example.com  ', 'ayesha@example.com'],
  ])('normalizes %o to %o', async (value, email) => {
    const element = await RestaurantStaffPage({
      searchParams: Promise.resolve({ invitedEmail: value }),
    });
    expect(element.type).toBe(mocks.staffConsole);
    expect(element.props.invitedEmail).toBe(email);
  });
});
