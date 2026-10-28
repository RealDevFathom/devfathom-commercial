import { expect, it } from 'vitest';
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
