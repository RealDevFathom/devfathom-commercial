import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The existing USD rendering fixture remains in day-close-console.test.tsx.
// Keep the newly introduced tender summary from reintroducing a fixed denomination.
describe('day-close tender denomination', () => {
  it('uses the organization currency in tender totals', () => {
    const source = readFileSync(new URL('./day-close-console.tsx', import.meta.url), 'utf8');
    const tenderSection = source.slice(source.indexOf('aria-label="Tender totals"'), source.indexOf('{report ? ('));
    expect(tenderSection).toContain('{formatMinor(row.netMinor)} {currency}');
    expect(tenderSection).not.toContain('PKR');
  });
});
