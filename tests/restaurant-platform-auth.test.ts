// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fixtureTotp, platformActorCode } from './e2e/fixtures/restaurant-platform-auth';

// RFC 6238 SHA-1 vectors, reduced to the six digits accepted by the application.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
describe('restaurant fixture authenticator', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches the independent RFC vector at %i seconds', (seconds, code) => {
    expect(fixtureTotp(secret, Number(seconds) * 1000)).toBe(code);
  });
  it('refuses missing and malformed setup keys without echoing them', () => {
    expect(() => fixtureTotp('')).toThrow('Missing fixture authenticator setup key.');
    expect(() => fixtureTotp('!not-a-key')).toThrow('Invalid fixture authenticator setup key.');
  });
  it('never invents an OTP for an actor that has not enrolled', () => {
    expect(() =>
      platformActorCode('http://admin.localhost:4319', 'unenrolled@e2e.invalid')
    ).toThrow('Sign in through the fixture enrollment UI before requesting OTP.');
  });
});
