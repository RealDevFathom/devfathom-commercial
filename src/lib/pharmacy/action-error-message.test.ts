import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { pharmacyActionErrorMessage } from './action-error-message';

describe('pharmacyActionErrorMessage', () => {
  it.each([
    ['inventory', 'The inventory action could not be completed. Review the fields and try again.'],
    ['finance', 'The finance action could not be completed. Review the fields and try again.'],
  ] as const)('returns fixed copy for the %s page', (surface, expected) => {
    expect(pharmacyActionErrorMessage(surface)).toBe(expected);
  });

  it('cannot observe or stringify a hostile thrown value, even when called from untyped code', () => {
    const failure = new Proxy(
      {},
      {
        get() {
          throw new Error('the failure value was inspected');
        },
        has() {
          throw new Error('the failure value was inspected');
        },
        ownKeys() {
          throw new Error('the failure value was inspected');
        },
      }
    );
    const untypedCall = pharmacyActionErrorMessage as (...args: unknown[]) => string;

    expect(untypedCall('finance', failure)).toBe(
      'The finance action could not be completed. Review the fields and try again.'
    );
  });

  it.each(['inventory', 'finance'])(
    'keeps raw errors out of the %s server-action redirect',
    (page) => {
      const source = readFileSync(`src/app/(app)/pharmacy/${page}/page.tsx`, 'utf8');

      expect(source).toContain(`pharmacyActionErrorMessage('${page}')`);
      expect(source).not.toMatch(/\berror\.message\b/);
    }
  );
});

describe('pharmacy server-action error disclosure regression', () => {
  const actionCatch = (relativePagePath: string, surface: 'inventory' | 'finance') => {
    const source = readFileSync(new URL(relativePagePath, import.meta.url), 'utf8');
    const safeMessageCall = `pharmacyActionErrorMessage('${surface}')`;
    const safeMessageOffset = source.indexOf(safeMessageCall);

    expect(safeMessageOffset, `${relativePagePath} must use fixed error copy`).toBeGreaterThan(-1);

    const catchOffset = source.lastIndexOf('} catch (error) {', safeMessageOffset);
    const catchEnd = source.indexOf('\n    }', safeMessageOffset);
    expect(catchOffset).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(safeMessageOffset);

    return source.slice(catchOffset, catchEnd);
  };

  it.each([
    ['../../app/(app)/pharmacy/inventory/page.tsx', 'inventory'],
    ['../../app/(app)/pharmacy/finance/page.tsx', 'finance'],
  ] as const)('keeps caught values out of the %s redirect notice', (page, surface) => {
    const catchBlock = actionCatch(page, surface);

    expect(catchBlock).toContain(`pharmacyActionErrorMessage('${surface}')`);
    expect(catchBlock).not.toMatch(/error\s*\.\s*message/);
    expect(catchBlock).not.toMatch(/String\s*\(\s*error\s*\)/);
    expect(catchBlock).not.toMatch(/`[^`]*\$\{\s*error/);
  });
});
