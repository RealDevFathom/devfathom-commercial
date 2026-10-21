import { describe, expect, test } from 'vitest';
import { CAMERA_BRAND_PRESETS, seedCameraBrandPresets } from './camera-brand-presets';

describe('camera brand preset seed', () => {
  test('contains exactly four families and preserves existing rows', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const db = {
      platformCameraBrandPreset: {
        async createMany({
          data,
        }: {
          data: readonly Record<string, unknown>[];
          skipDuplicates: true;
        }) {
          for (const item of data)
            if (!rows.has(String(item.key))) rows.set(String(item.key), { ...item });
        },
      },
    };
    await seedCameraBrandPresets(db);
    rows.get('hikvision-ezviz')!.familyName = 'Operator edit';
    await seedCameraBrandPresets(db);
    expect(CAMERA_BRAND_PRESETS).toHaveLength(4);
    expect(rows).toHaveLength(4);
    expect(rows.get('hikvision-ezviz')!.familyName).toBe('Operator edit');
  });
});
