import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Prisma migration directory names', () => {
  it('uses unique, valid timestamps', () => {
    const names = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const timestamps = names.map((name) => name.match(/^(\d{14})_/)?.[1]);
    expect(timestamps.every(Boolean)).toBe(true);
    const counts = new Map<string, number>();
    for (const timestamp of timestamps as string[])
      counts.set(timestamp, (counts.get(timestamp) ?? 0) + 1);
    const duplicates = [...counts]
      .filter(([, count]) => count > 1)
      .map(([timestamp, count]) => `${timestamp}:${count}`)
      .sort();
    // Applied legacy migrations cannot safely be renamed. Pin their exact historical collisions
    // so any new duplicate prefix (or another migration added to an old prefix) fails this check.
    expect(duplicates).toEqual([
      '20260827070000:2',
      '20260827120000:2',
      '20260829090000:2',
      '20260829120000:2',
      '20260829180000:2',
      '20260830120000:2',
      '20260902120000:3',
      '20260902130000:3',
      '20260902150000:2',
      '20260902170000:2',
      '20260902180000:3',
      '20260904133000:2',
      '20260929120000:2',
      '20261021120000:3',
      '20261021130000:2',
      '20261021160000:2',
    ]);
    // Applied on main before this check existed, so these cannot be renamed either (minute
    // 60 and above). Pinned like the duplicates: no new invalid timestamp may join them.
    const appliedInvalid = new Set([
      '20260728106000',
      '20260904196000',
      '20260904197000',
      '20260904198000',
    ]);
    for (const timestamp of (timestamps as string[]).filter(
      (value) => !appliedInvalid.has(value)
    )) {
      const [year, month, day, hour, minute, second] = [
        timestamp.slice(0, 4),
        timestamp.slice(4, 6),
        timestamp.slice(6, 8),
        timestamp.slice(8, 10),
        timestamp.slice(10, 12),
        timestamp.slice(12, 14),
      ].map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      expect(parsed.toISOString().replace(/[-:T]/g, '').slice(0, 14)).toBe(timestamp);
    }
  });
});
