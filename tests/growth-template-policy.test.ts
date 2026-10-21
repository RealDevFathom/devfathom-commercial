import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps product placeholders confined to the utility refill reminder', () => {
  const seed = readFileSync('prisma/seed-growth.ts', 'utf8');
  const templates = [...seed.matchAll(/key: '([^']+)',\s+body: '([^']+)'/g)];
  expect(templates).toHaveLength(8);
  for (const [, key, body] of templates) {
    if (key === 'refill_reminder') {
      expect(body).toContain('{{product}}');
      expect(body).not.toMatch(/discount|off|offer|sale/i);
    } else {
      expect(body).not.toContain('{{product}}');
    }
    expect(body).not.toMatch(/\b(drug|Rx|medicine)\b/i);
  }
});
