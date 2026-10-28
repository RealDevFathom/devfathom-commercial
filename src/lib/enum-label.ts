/** Human-readable fallback for stored enum and catalog keys. */
export function enumLabel(value: string): string {
  if (value === 'HR') return value;
  const words = value.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
