import { describe, expect, it } from 'vitest';
import { counterLabel } from './counter-label';

describe('counterLabel', () => {
  it('prefers the registered counter name', () => {
    expect(counterLabel('counter-bbd93263-ccd1', '  Front till ')).toBe('Front till');
  });
  it('falls back to a short code, never the raw device id', () => {
    expect(counterLabel('counter-bbd93263-ccd1-4c8d-9f65-7011e1bf6a48')).toBe('Counter 6A48');
  });
  it('is null without a device', () => {
    expect(counterLabel(null)).toBeNull();
  });
});
