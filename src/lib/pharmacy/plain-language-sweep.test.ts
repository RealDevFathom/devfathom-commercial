import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEV-722: shop owners must never see developer vocabulary on pharmacy screens. This scans the
 * pharmacy page and component sources (not tests) for banned terms. Comments are ignored; they are
 * not shown to anyone. The allowlist is for Details-only strings and must not grow.
 */
const ROOTS = ['src/app/(app)/pharmacy', 'src/components/pharmacy'];
const BANNED: { name: string; pattern: RegExp }[] = [
  { name: 'minor units', pattern: /minor[- ]units?/i },
  { name: 'RFC3339', pattern: /RFC\s?3339/i },
  { name: 'UTC offset string', pattern: /\b(?:UTC|GMT)\s?[+-]\d{1,2}(?::?\d{2})?\b/ },
  // Raw enum names (ALL_CAPS_WITH_UNDERSCORES) written as visible JSX text.
  { name: 'raw enum name', pattern: />\s*[A-Z]{2,}(?:_[A-Z0-9]+)+\s*</ },
];
/** "relative/path :: banned term" entries for strings only shown inside a Details disclosure. */
const ALLOWLIST: string[] = [];

/** The shared copy catalogue: its strings reach the same screens. */
const CATALOGUE = 'src/lib/pharmacy/plain-language.ts';
/**
 * Time wording an owner should not need: a bare "UTC" and an ISO instant typed out as an example.
 * Precise wording is allowed inside a Details disclosure, so `<ReportDetails>` and `<details>`
 * blocks are left out, as are code-only uses (`'UTC'` as a zone value, `Date.UTC`).
 */
const TIME_TERMS: { name: string; pattern: RegExp }[] = [
  { name: 'bare UTC', pattern: /\bUTC\b/ },
  { name: 'ISO-instant example', pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\bISO[- ]instant/i },
];
/** Entries that are never shown on a screen outside Details, each with the reason. */
const TIME_ALLOWLIST: Record<string, string> = {
  'src/components/pharmacy/sop/sop-test-harness.tsx :: ISO-instant example':
    'Fixture data imported only by SOP tests; no route renders it.',
  'src/lib/pharmacy/plain-language.ts :: bare UTC':
    'Only cheques.recordedChequesRetainedFromTheLatestWorkspaceResponse says UTC, and the cheque-maturity page renders it inside ReportDetails.',
};
/**
 * Screens that still show "UTC" outside Details and are not yet converted to the organisation's
 * clock (DEV-722 follow-up). The list may only shrink: fix a screen, then delete its entry.
 */
const TIME_REMAINING: string[] = [
  'src/app/(app)/pharmacy/finance/ledger-reports.tsx :: bare UTC',
  'src/app/(app)/pharmacy/finance/financial-statements.tsx :: bare UTC',
  'src/app/(app)/pharmacy/loyalty/page.tsx :: bare UTC',
  'src/app/(app)/pharmacy/loyalty/loyalty-card-panel.tsx :: bare UTC',
  'src/app/(app)/pharmacy/reports/lost-sales-recovery.tsx :: bare UTC',
  'src/app/(app)/pharmacy/accounts/fiscal-exceptions/query.ts :: bare UTC',
  'src/app/(app)/pharmacy/accounts/fiscal-exceptions/page.tsx :: bare UTC',
  'src/components/pharmacy/counter/counter-receipt-view.tsx :: bare UTC',
];

const visibleOutsideDetails = (text: string) =>
  stripComments(text)
    .replace(/<ReportDetails>[\s\S]*?<\/ReportDetails>/g, '')
    .replace(/<details[\s>][\s\S]*?<\/details>/g, '')
    .replace(/(['"`])UTC\1/g, '')
    .replace(/\bDate\.UTC\b/g, '');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('plain-language sweep', () => {
  it('keeps developer terms off pharmacy screens', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const text = stripComments(readFileSync(file, 'utf8'));
        for (const { name, pattern } of BANNED) {
          if (pattern.test(text)) {
            const key = `${relative('.', file)} :: ${name}`;
            if (!ALLOWLIST.includes(key)) hits.push(key);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('does not let the allowlist grow', () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(0);
  });

  it('scans the copy catalogue for the same developer terms', () => {
    const text = stripComments(readFileSync(CATALOGUE, 'utf8'));
    const hits = BANNED.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
    expect(hits).toEqual([]);
  });

  it('keeps bare UTC and ISO-instant examples outside Details off pharmacy screens', () => {
    const hits: string[] = [];
    for (const file of [...ROOTS.flatMap(sources), CATALOGUE]) {
      const text = visibleOutsideDetails(readFileSync(file, 'utf8'));
      for (const { name, pattern } of TIME_TERMS) {
        const key = `${relative('.', file)} :: ${name}`;
        if (pattern.test(text) && !(key in TIME_ALLOWLIST) && !TIME_REMAINING.includes(key))
          hits.push(key);
      }
    }
    expect(hits).toEqual([]);
  });

  it('only shrinks the remaining UTC list and keeps every allowlist entry reasoned and live', () => {
    for (const key of [...TIME_REMAINING, ...Object.keys(TIME_ALLOWLIST)]) {
      const [file, name] = key.split(' :: ');
      const term = TIME_TERMS.find((entry) => entry.name === name)!;
      // An entry whose file no longer matches must be deleted, so neither list goes stale.
      expect(term.pattern.test(visibleOutsideDetails(readFileSync(file!, 'utf8'))), key).toBe(true);
    }
    for (const reason of Object.values(TIME_ALLOWLIST)) expect(reason.length).toBeGreaterThan(20);
    expect(Object.keys(TIME_ALLOWLIST).length).toBeLessThanOrEqual(2);
    expect(TIME_REMAINING.length).toBeLessThanOrEqual(10);
  });
});
