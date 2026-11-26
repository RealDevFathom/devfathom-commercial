import { describe, expect, it } from 'vitest';
import { wahaSendAllowed } from './waha-policy';

const base = {
  optedIn: true,
  quiet: false,
  restricted: false,
  portalAllowed: true,
  connected: true,
  minute: 0,
  day: 0,
  minuteCap: 3,
  dayCap: 10,
  lastCold: null,
  hasInbound: false,
  now: 1_000_000,
};
describe('WAHA delivery policy', () => {
  it.each([
    { optedIn: false },
    { quiet: true },
    { restricted: true },
    { portalAllowed: false },
    { connected: false },
    { minute: 3 },
    { day: 10 },
    { lastCold: 999999 },
  ])('withholds a send when a protection applies', (override) => {
    expect(wahaSendAllowed({ ...base, ...override })).toBe(false);
  });
  it('permits a consented recipient with inbound history during cold-recipient spacing', () => {
    expect(wahaSendAllowed({ ...base, hasInbound: true, lastCold: 999999 })).toBe(true);
  });
});
