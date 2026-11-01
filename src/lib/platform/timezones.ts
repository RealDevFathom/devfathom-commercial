/**
 * Whether `timezone` is one the runtime can actually resolve.
 *
 * This is the exact condition under which `Intl.DateTimeFormat` — and therefore
 * every calendar-date computation that reads an org's timezone — will not throw.
 * Checking it up front lets a surface reject a mis-configured workspace with a
 * validation error instead of letting the `RangeError` surface as a 500.
 */
export function isSupportedTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function ianaTimezoneOptions() {
  const zones = Intl.supportedValuesOf('timeZone');
  return ['UTC', ...zones.filter((zone) => zone !== 'UTC')].map((zone) => ({
    label: zone,
    value: zone,
  }));
}
