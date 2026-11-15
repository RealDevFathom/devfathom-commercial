/** Parse a typed rupee amount ("1500", "1,500.5") into whole paisa; null when not a positive amount. */
export function parseMajorToMinor(raw: string): number | null {
  const text = raw.trim().replace(/,/g, '');
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return minor > 0 ? minor : null;
}
