import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePharmacyCatalog, PHARMACY_CATALOG_VERSION } from './preload';

describe('bundled pharmacy catalogue asset', () => {
  const assetPath = path.join(process.cwd(), 'prisma/seed-assets/pharmacy-catalog-v1.json.gz');
  const digestPath = path.join(process.cwd(), 'prisma/seed-assets/pharmacy-catalog-v1.sha256');

  it('has the declared shape and contains no inventory or supplier facts', () => {
    const catalog = parsePharmacyCatalog(JSON.parse(gunzipSync(readFileSync(assetPath)).toString('utf8')));
    expect(catalog.version).toBe(PHARMACY_CATALOG_VERSION);
    expect(catalog.count).toBe(catalog.items.length);
    expect(catalog.count).toBeGreaterThan(0);
    const forbidden = new Set(['qty', 'stockvalue', 'supplier', 'stock']);
    for (const item of catalog.items) {
      for (const key of Object.keys(item)) expect(forbidden.has(key.toLowerCase())).toBe(false);
    }
  });

  it('matches the pinned SHA-256 when a digest file is present', () => {
    if (!existsSync(digestPath)) return;
    const expected = readFileSync(digestPath, 'utf8').trim().split(/\s+/)[0];
    const actual = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(actual).toBe(expected);
  });
});
