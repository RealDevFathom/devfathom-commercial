import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as catalogue from './plain-language';

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
/**
 * Screen files never shown outside Details, each with the exact number of matches it may keep and
 * the reason. A file that gains one more match fails.
 */
const TIME_ALLOWLIST: Record<string, { matches: number; reason: string }> = {
  'src/components/pharmacy/sop/sop-test-harness.tsx :: ISO-instant example': {
    matches: 7,
    reason: 'Fixture data imported only by SOP tests; no route renders it.',
  },
};
/**
 * Copy catalogue entries, by copy path, that may use a time term because they render only inside
 * Details. Every other catalogue string is checked on its own.
 */
const COPY_ALLOWLIST: Record<string, { term: string; reason: string }> = {
  'SHOP_SCREEN_COPY.cheques.recordedChequesRetainedFromTheLatestWorkspaceResponse': {
    term: 'bare UTC',
    reason: 'The cheque-maturity page renders this caveat only inside ReportDetails.',
  },
};
/**
 * Screens that still show "UTC" outside Details and are not yet converted to the organisation's
 * clock (DEV-722 follow-up), with their current match counts. Counts may only fall: fix a screen,
 * lower or delete its entry. A screen that gains a match fails.
 */
const TIME_REMAINING: Record<string, number> = {
  'src/app/(app)/pharmacy/finance/ledger-reports.tsx :: bare UTC': 6,
  'src/app/(app)/pharmacy/finance/financial-statements.tsx :: bare UTC': 2,
  'src/app/(app)/pharmacy/loyalty/page.tsx :: bare UTC': 4,
  'src/app/(app)/pharmacy/loyalty/loyalty-card-panel.tsx :: bare UTC': 1,
  'src/app/(app)/pharmacy/reports/lost-sales-recovery.tsx :: bare UTC': 1,
  'src/app/(app)/pharmacy/accounts/fiscal-exceptions/query.ts :: bare UTC': 1,
  'src/app/(app)/pharmacy/accounts/fiscal-exceptions/page.tsx :: bare UTC': 5,
  'src/components/pharmacy/counter/counter-receipt-view.tsx :: bare UTC': 1,
};

const countMatches = (pattern: RegExp, text: string) =>
  (text.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')) ?? []).length;

/** Every string leaf of the catalogue's exported objects, with its copy path. */
function copyStrings(value: unknown, path: string): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, child]) => copyStrings(child, `${path}.${key}`));
  return [];
}

/** Screen files over their allowed count: none allowed unless pinned in an allowlist. */
function screenTimeHits(files: { path: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    const visible = visibleOutsideDetails(text);
    for (const { name, pattern } of TIME_TERMS) {
      const key = `${path} :: ${name}`;
      const allowed = TIME_ALLOWLIST[key]?.matches ?? TIME_REMAINING[key] ?? 0;
      const found = countMatches(pattern, visible);
      if (found !== allowed) hits.push(`${key} (found ${found}, allowed ${allowed})`);
    }
  }
  return hits;
}

/**
 * Catalogue strings using a time term outside COPY_ALLOWLIST, plus any match in the catalogue file
 * that is not inside an allowlisted string (a function body, for example).
 */
function catalogueTimeHits(copy: [string, string][], fileText: string): string[] {
  const hits: string[] = [];
  for (const { name, pattern } of TIME_TERMS) {
    let allowedMatches = 0;
    for (const [path, text] of copy) {
      const found = countMatches(pattern, text);
      if (!found) continue;
      if (COPY_ALLOWLIST[path]?.term === name) allowedMatches += found;
      else hits.push(`${path} :: ${name}`);
    }
    const inFile = countMatches(pattern, visibleOutsideDetails(fileText));
    if (inFile !== allowedMatches)
      hits.push(`${CATALOGUE} :: ${name} (found ${inFile}, allowed ${allowedMatches})`);
  }
  return hits;
}

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

  const screenFiles = () =>
    ROOTS.flatMap(sources).map((file) => ({
      path: relative('.', file),
      text: readFileSync(file, 'utf8'),
    }));
  const catalogueCopy = () =>
    Object.entries(catalogue).flatMap(([name, value]) => copyStrings(value, name));

  it('keeps bare UTC and ISO-instant examples outside Details off pharmacy screens', () => {
    expect(screenTimeHits(screenFiles())).toEqual([]);
  });

  it('allows a time term in the copy catalogue only in its allowlisted entries', () => {
    expect(catalogueTimeHits(catalogueCopy(), readFileSync(CATALOGUE, 'utf8'))).toEqual([]);
  });

  it('fails when a catalogue entry or a remaining screen gains UTC text (self-test)', () => {
    const injected: [string, string] = ['SHOP_SCREEN_COPY.cheques.dueDateUtc', 'Due date (UTC)'];
    const fileText = `${readFileSync(CATALOGUE, 'utf8')}\n  dueDateUtc: 'Due date (UTC)',\n`;
    expect(catalogueTimeHits([...catalogueCopy(), injected], fileText)).toEqual([
      'SHOP_SCREEN_COPY.cheques.dueDateUtc :: bare UTC',
      `${CATALOGUE} :: bare UTC (found 2, allowed 1)`,
    ]);
    const remaining = 'src/app/(app)/pharmacy/loyalty/loyalty-card-panel.tsx';
    const grown = screenFiles().map((file) =>
      file.path === remaining
        ? { ...file, text: `${file.text}\nconst label = 'Time UTC now';\n` }
        : file
    );
    expect(screenTimeHits(grown)).toEqual([`${remaining} :: bare UTC (found 2, allowed 1)`]);
  });

  it('keeps every allowlist entry reasoned and the remaining list small', () => {
    for (const { reason } of [...Object.values(TIME_ALLOWLIST), ...Object.values(COPY_ALLOWLIST)])
      expect(reason.length).toBeGreaterThan(20);
    // Each COPY_ALLOWLIST path must exist and still use its term, so the list cannot go stale.
    const copy = new Map(catalogueCopy());
    for (const [path, { term }] of Object.entries(COPY_ALLOWLIST)) {
      const pattern = TIME_TERMS.find((entry) => entry.name === term)!.pattern;
      expect(pattern.test(copy.get(path) ?? ''), path).toBe(true);
    }
    for (const [key, count] of Object.entries(TIME_REMAINING))
      expect(count, key).toBeGreaterThan(0);
    expect(
      Object.keys(TIME_ALLOWLIST).length + Object.keys(COPY_ALLOWLIST).length
    ).toBeLessThanOrEqual(2);
    expect(Object.keys(TIME_REMAINING).length).toBeLessThanOrEqual(8);
  });
});
