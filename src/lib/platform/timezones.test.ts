import { describe, expect, it } from 'vitest';

import { ianaTimezoneOptions, isSupportedTimezone } from './timezones';

describe('isSupportedTimezone', () => {
  it('accepts IANA zones the runtime can resolve', () => {
    expect(isSupportedTimezone('Asia/Karachi')).toBe(true);
    expect(isSupportedTimezone('UTC')).toBe(true);
    expect(isSupportedTimezone('America/New_York')).toBe(true);
  });

  it('rejects a mis-configured zone rather than letting it throw later (#162)', () => {
    expect(isSupportedTimezone('Not/AZone')).toBe(false);
    expect(isSupportedTimezone('Mars/Phobos')).toBe(false);
    expect(isSupportedTimezone('')).toBe(false);
    expect(isSupportedTimezone('Asia/Karachi ')).toBe(false);
  });

  it('accepts every zone the option list offers', () => {
    for (const option of ianaTimezoneOptions()) {
      expect(isSupportedTimezone(option.value)).toBe(true);
    }
  });
});
