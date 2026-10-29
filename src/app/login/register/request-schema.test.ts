import { afterEach, expect, it, vi } from 'vitest';
import { workspaceRequestSchema } from './request-schema';
const restaurant = {
  vertical: 'restaurant',
  companyName: 'Test restaurant',
  ownerName: 'Owner',
  email: 'owner@example.test',
  phone: '03001234567',
  address: 'Main street',
  branchName: 'First',
  businessDayCloses: '00:00',
  channels: ['Dine-in'],
  authorized: 'on',
};
it('validates request details without accepting passwords or provisioning flags', () => {
  const result = workspaceRequestSchema.parse({
    ...restaurant,
    password: 'discarded',
    status: 'ACTIVE',
  });
  expect(result).not.toHaveProperty('password');
  expect(result).not.toHaveProperty('status');
});
it('requires authority, a first branch and a real channel', () => {
  for (const change of [
    { authorized: undefined },
    { branchName: '' },
    { channels: [] },
    { businessDayCloses: '99:99' },
  ])
    expect(workspaceRequestSchema.safeParse({ ...restaurant, ...change }).success).toBe(false);
});
it('requires pharmacy licence, unexpired validity and pharmacist evidence', () => {
  expect(workspaceRequestSchema.safeParse({ ...restaurant, vertical: 'pharmacy' }).success).toBe(
    false
  );
  const pharmacy = {
    ...restaurant,
    vertical: 'pharmacy',
    province: 'Punjab',
    city: 'Lahore',
    licenceCategory: 'Pharmacy',
    licenceNumber: 'ABC',
    validUntil: '2099-01-01',
    pharmacistName: 'Pharmacist',
    pharmacistRegistration: 'REG',
  };
  expect(workspaceRequestSchema.safeParse(pharmacy).success).toBe(true);
  expect(workspaceRequestSchema.safeParse({ ...pharmacy, validUntil: '2020-01-01' }).success).toBe(
    false
  );
});
it('requires property facts and sensible room counts', () => {
  const hotel = {
    ...restaurant,
    vertical: 'hotel',
    city: 'Lahore',
    rooms: '24',
    checkIn: '14:00',
    checkOut: '12:00',
  };
  expect(workspaceRequestSchema.safeParse(hotel).success).toBe(true);
  expect(workspaceRequestSchema.safeParse({ ...hotel, rooms: '-1' }).success).toBe(false);
});

afterEach(() => vi.useRealTimers());

it.each([
  ['2099-02-31', false],
  ['2099-02-29', false],
  ['2100-02-29', false],
  ['2096-02-29', true],
  ['2400-02-29', true],
  ['2099-04-31', false],
  ['2099-04-30', true],
  ['2099-12-31', true],
  ['2099-00-10', false],
  ['2099-13-01', false],
  ['2099-01-00', false],
  ['2099-2-01', false],
  ['2099-02-01T00:00:00Z', false],
  ['2026-10-29', true],
  ['2026-10-28', false],
])('validates real, unexpired YYYY-MM-DD licence date %s', (validUntil, accepted) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
  const result = workspaceRequestSchema.safeParse({
    ...restaurant,
    vertical: 'pharmacy',
    province: 'Punjab',
    city: 'Lahore',
    licenceCategory: 'Pharmacy',
    licenceNumber: 'ABC',
    validUntil,
    pharmacistName: 'Pharmacist',
    pharmacistRegistration: 'REG',
  });
  expect(result.success).toBe(accepted);
  if (!result.success)
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['validUntil']);
});
