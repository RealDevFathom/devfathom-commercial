import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const regions = [
  ['inventory/page.tsx', 'Inventory lots', true],
  ['marketing/page.tsx', 'Campaign history', false],
  ['finance/financial-statements.tsx', 'Trial balance', false],
  ['finance/financial-statements.tsx', 'Cash flow', false],
  ['finance/page.tsx', 'Recent transactions', true],
] as const;

describe('pharmacy scrolling tables', () => {
  it.each(regions)(
    'makes %s / %s keyboard reachable and named',
    (file, name, wrapsTableComponent) => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const openingTag = [...source.matchAll(/<div\b[^>]*>/gs)].find(
        ([tag]) => tag.includes('overflow-x-auto') && tag.includes(`aria-label="${name}"`)
      )?.[0];

      expect(openingTag).toBeDefined();
      expect(openingTag).toContain('role="region"');
      expect(openingTag).toContain('tabIndex={0}');
      expect(openingTag).toContain('focus-visible:outline-ring');
      expect(openingTag?.includes('[&_[data-slot=table-container]]:overflow-visible')).toBe(
        wrapsTableComponent
      );
    }
  );
});
