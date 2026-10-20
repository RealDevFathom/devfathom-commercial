import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `dashboard.getStats` computes no month-over-month or quarter-over-quarter
 * deltas, so a KPI card may show a delta only when it is derived from data.
 * Regression for the hard-coded "+12% vs last month" and "2 new this quarter"
 * that sat on the revenue and projects cards regardless of the figures.
 */
describe('agency dashboard KPI deltas', () => {
  const source = readFileSync(join(__dirname, 'dashboard-content.tsx'), 'utf8');
  const kpiCards = source.match(/<KPICard[\s\S]*?\/>/g) ?? [];

  it('renders KPI cards', () => {
    expect(kpiCards.length).toBeGreaterThanOrEqual(4);
  });

  it('never ships a literal delta string on a KPI card', () => {
    const literalDeltas = kpiCards.filter((card) => /\bchange="[^"]*"/.test(card));
    expect(literalDeltas).toEqual([]);
    expect(source).not.toMatch(/\+12%|new this quarter|vs last month/);
  });

  it('only claims a direction on a card whose delta is computed', () => {
    for (const card of kpiCards) {
      if (/\btrend="(up|down)"/.test(card)) expect(card).toMatch(/\bchange=\{/);
    }
  });
});
