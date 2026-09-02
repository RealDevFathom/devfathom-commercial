import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildInspectionManifest } from './inspection-pack';

describe('SAFE-02 inspection manifest', () => {
  it('is byte-for-byte reproducible regardless of input record order', () => {
    const base = {
      branchId: 'branch-1',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-31T23:59:59.999Z'),
    };
    const first = buildInspectionManifest({
      ...base,
      sections: [
        {
          name: 'sales',
          records: [
            { id: 'b', totalMinor: 20 },
            { totalMinor: 10, id: 'a' },
          ],
        },
      ],
    });
    const second = buildInspectionManifest({
      ...base,
      sections: [
        {
          name: 'sales',
          records: [
            { id: 'a', totalMinor: 10 },
            { id: 'b', totalMinor: 20 },
          ],
        },
      ],
    });
    expect(second).toEqual(first);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds a 20k-row fixture within the ten-minute budget and records timing', () => {
    const records = Array.from({ length: 20_000 }, (_, index) => ({
      id: `sale-${index}`,
      quantityCanonicalUnits: index + 1,
    }));
    const started = performance.now();
    const manifest = buildInspectionManifest({
      branchId: 'branch-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
      sections: [{ name: 'sales', records }],
    });
    const elapsedMs = performance.now() - started;
    console.info(`SAFE-02 20k manifest timing: ${elapsedMs.toFixed(2)}ms`);
    expect(manifest.files[0]?.recordCount).toBe(20_000);
    expect(elapsedMs).toBeLessThan(600_000);
  });
});
