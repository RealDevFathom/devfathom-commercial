import { describe, expect, it } from 'vitest';

import { ianaTimezone, isIanaTimezone, workspaceTimezone, workspaceToday } from './timezone';

// 22:30 UTC on 21 October: already the 22nd in Asia/Tokyo, still the 21st in UTC.
const instant = new Date('2026-10-21T22:30:00.000Z');

describe('workspace time zones', () => {
  it('accepts an IANA zone and refuses an abbreviation or a loose offset, as Intl does', () => {
    for (const zone of ['Asia/Karachi', 'Asia/Tokyo', 'America/Chicago', 'UTC'])
      expect(isIanaTimezone(zone), zone).toBe(true);
    for (const zone of ['PKT', 'UTC+5', 'GMT+5', 'Mars/Olympus', '', ' Asia/Tokyo'])
      expect(isIanaTimezone(zone), zone).toBe(false);
  });

  it('stores only a zone Intl accepts, trimmed, with a sentence for the field', () => {
    expect(ianaTimezone.parse(' Asia/Tokyo ')).toBe('Asia/Tokyo');
    for (const zone of ['PKT', 'UTC+5', '']) {
      const parsed = ianaTimezone.safeParse(zone);
      expect(parsed.success, zone).toBe(false);
    }
    expect(ianaTimezone.safeParse('PKT').error?.issues[0]?.message).toBe(
      'Choose a valid IANA timezone.'
    );
  });

  it('reads a missing or refused stored zone as UTC, and a good one as itself', () => {
    expect(workspaceTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    for (const zone of ['PKT', 'UTC+5', '', null, undefined])
      expect(workspaceTimezone(zone), String(zone)).toBe('UTC');
  });

  it('picks today in the workspace zone, and in UTC for a zone Intl refuses', () => {
    expect(workspaceToday('Asia/Tokyo', instant)).toBe('2026-10-22');
    expect(workspaceToday('America/Chicago', instant)).toBe('2026-10-21');
    expect(workspaceToday('PKT', instant)).toBe('2026-10-21');
    expect(workspaceToday(undefined, instant)).toBe('2026-10-21');
  });
});
