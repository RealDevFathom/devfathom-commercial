import { describe, expect, it } from 'vitest';

import {
  formatWorkspaceDateTime,
  ianaTimezone,
  isIanaTimezone,
  workspaceDateRange,
  workspaceTimezone,
  workspaceToday,
  workspaceZoneLabel,
} from './timezone';

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

  it('keeps 00:00–04:59 PKT on the Karachi business day, not the UTC one', () => {
    // 20:30 UTC on 14 November is 01:30 on the 15th in Karachi.
    const afterMidnight = new Date('2026-11-14T20:30:00.000Z');
    expect(workspaceToday('Asia/Karachi', afterMidnight)).toBe('2026-11-15');
  });

  it('shows an instant on the workspace clock and names the zone', () => {
    expect(formatWorkspaceDateTime('2026-11-03T13:24:15.000Z', 'Asia/Karachi')).toBe(
      '3 Nov 2026, 6:24 PM PKT'
    );
    expect(formatWorkspaceDateTime(new Date('2026-11-14T20:30:00.000Z'), 'Asia/Karachi')).toBe(
      '15 Nov 2026, 1:30 AM PKT'
    );
    expect(formatWorkspaceDateTime('2026-11-03T13:24:15.000Z', null)).toBe(
      '3 Nov 2026, 1:24 PM UTC'
    );
  });

  it('bounds inclusive workspace dates by the workspace midnights', () => {
    expect(workspaceDateRange('2026-11-09', '2026-11-15', 'Asia/Karachi')).toEqual({
      from: new Date('2026-11-08T19:00:00.000Z'),
      to: new Date('2026-11-15T19:00:00.000Z'),
    });
    // Daylight-saving days far from UTC: 27 Sep starts on NZST (+12), 5 Apr on NZDT (+13).
    expect(workspaceDateRange('2026-09-27', '2026-09-27', 'Pacific/Auckland')).toEqual({
      from: new Date('2026-09-26T12:00:00.000Z'),
      to: new Date('2026-09-27T11:00:00.000Z'),
    });
    expect(workspaceDateRange('2026-04-05', '2026-04-05', 'Pacific/Auckland')).toEqual({
      from: new Date('2026-04-04T11:00:00.000Z'),
      to: new Date('2026-04-05T12:00:00.000Z'),
    });
    // The last date a report accepts: its exclusive end is in year 10000.
    expect(workspaceDateRange('9999-12-31', '9999-12-31', null)).toEqual({
      from: new Date('9999-12-31T00:00:00.000Z'),
      to: new Date('+010000-01-01T00:00:00.000Z'),
    });
    expect(workspaceDateRange('9999-12-31', '9999-12-31', 'Asia/Karachi').to).toEqual(
      new Date('9999-12-31T19:00:00.000Z')
    );
    // Santiago skips 00:00–00:59 on 6 Sep 2026: the day starts at 01:00 (-03).
    expect(workspaceDateRange('2026-09-06', '2026-09-06', 'America/Santiago').from).toEqual(
      new Date('2026-09-06T04:00:00.000Z')
    );
    expect(workspaceDateRange('2026-02-28', '2026-02-28', null)).toEqual({
      from: new Date('2026-02-28T00:00:00.000Z'),
      to: new Date('2026-03-01T00:00:00.000Z'),
    });
  });

  it('names the workspace zone the way the owner reads it', () => {
    expect(workspaceZoneLabel('Asia/Karachi')).toBe('PKT');
    expect(workspaceZoneLabel(null)).toBe('UTC');
    // A seasonal abbreviation (GMT/BST) would be wrong for half of a historical range.
    expect(workspaceZoneLabel('Europe/London')).toBe('Europe/London');
  });
});

describe('workspace picker instants', () => {
  it('reads a datetime-local value on the workspace clock and writes it back', async () => {
    const { workspaceInstantFromInput, workspaceMinuteInput } = await import('./timezone');
    expect(workspaceInstantFromInput('2026-05-01T01:30', 'Asia/Karachi')).toBe(
      '2026-04-30T20:30:00Z'
    );
    expect(workspaceMinuteInput('2026-04-30T20:30:00Z', 'Asia/Karachi')).toBe('2026-05-01T01:30');
    expect(workspaceInstantFromInput('2026-05-01T09:30', undefined)).toBe('2026-05-01T09:30:00Z');
    expect(workspaceInstantFromInput('2026-07-01T12:00', 'Europe/London')).toBe(
      '2026-07-01T11:00:00Z'
    );
    expect(workspaceInstantFromInput('2026-05-01T09:30:00Z', 'Asia/Karachi')).toBe(
      '2026-05-01T09:30:00Z'
    );
  });
});
