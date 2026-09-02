export function ianaTimezoneOptions() {
  const zones = Intl.supportedValuesOf('timeZone');
  return ['UTC', ...zones.filter((zone) => zone !== 'UTC')].map((zone) => ({
    label: zone,
    value: zone,
  }));
}
