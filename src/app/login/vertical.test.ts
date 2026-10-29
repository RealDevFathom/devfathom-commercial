import { expect, it } from 'vitest';
import { loginVertical, verticalCopy } from './vertical';
it('uses a neutral default and rejects arbitrary/repeated vertical queries', () => {
  expect(loginVertical(undefined)).toBe('default');
  expect(loginVertical(['pharmacy', 'hotel'], 'app.example.test')).toBe('default');
  expect(loginVertical('bogus')).toBe('default');
});
it('supports query and subdomain presentation while tenant metadata wins', () => {
  expect(loginVertical('pharmacy')).toBe('pharmacy');
  expect(loginVertical(undefined, 'restaurant.localhost:4321')).toBe('restaurant');
  expect(loginVertical('restaurant', 'app.localhost', 'hotel')).toBe('hotel');
});
it('hotel sign-in describes setup without promising unimplemented operations', () => {
  expect(verticalCopy.hotel.signIn).toContain('setting up');
  expect(JSON.stringify(verticalCopy.hotel)).not.toMatch(/reservations|folios|night audit/i);
});
it('recognizes agency/studio while keeping tenant presentation authoritative', () => {
  expect(loginVertical('agency')).toBe('agency');
  expect(loginVertical('studio')).toBe('agency');
  expect(loginVertical(undefined, 'studio.localhost:4321')).toBe('agency');
  expect(loginVertical('pharmacy', 'pharmacy.localhost', 'AGENCY')).toBe('agency');
  expect(loginVertical('studio', 'studio.localhost', 'PHARMACY')).toBe('pharmacy');
});

it('maps the persisted hospitality vertical before considering query or host', () => {
  expect(loginVertical('pharmacy', 'pharmacy.localhost', 'HOSPITALITY')).toBe('hotel');
});
