import { describe, expect, it } from 'vitest';
import { formatUtcInstant, toUtcMinuteInput, utcInstantFromInput } from './utc-instant';

describe('utc instant helpers', () => {
  it('reads a zone-less picker value as UTC and leaves full instants alone', () => {
    expect(utcInstantFromInput('2026-05-01T09:30')).toBe('2026-05-01T09:30:00Z');
    expect(utcInstantFromInput('2026-05-01T09:30:15')).toBe('2026-05-01T09:30:15Z');
    expect(utcInstantFromInput('2026-05-01T09:30:00+05:00')).toBe('2026-05-01T09:30:00+05:00');
    expect(utcInstantFromInput('soon')).toBe('soon');
  });

  it('fills a datetime-local picker in UTC', () => {
    expect(toUtcMinuteInput('2026-05-01T09:30:45Z')).toBe('2026-05-01T09:30');
    expect(toUtcMinuteInput(new Date('2026-05-01T04:30:00+05:00'))).toBe('2026-04-30T23:30');
    expect(toUtcMinuteInput('not a date')).toBe('');
  });

  it('shows instants in words, never raw ISO', () => {
    expect(formatUtcInstant(new Date('2026-10-07T07:00:00Z'))).toBe('7 Oct 2026, 07:00 UTC');
    expect(formatUtcInstant('2026-05-01T00:00:00Z')).not.toMatch(/T\d{2}:/);
  });
});
