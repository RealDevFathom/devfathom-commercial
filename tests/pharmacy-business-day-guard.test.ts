import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// DEV-958A. A pharmacy branch's business day ends at its "day ends at" hour, not at midnight.
// Every pharmacy module that decides which day an instant is on, or bounds a by-day window,
// goes through `src/lib/pharmacy/business-day.ts`: `pharmacyBusinessDay*` for business days
// (with the branch's hour), `pharmacyCalendarDay*` for dates that are plain calendar dates.
// Working a day out on organisation midnight directly (`workspaceToday`, `workspaceDateRange`,
// `workspaceDateOffset`) or on another clock (`resolveBusinessDate`) is refused here, so a new
// booking or report cannot silently disagree with the day close.

const ROOT = path.resolve(__dirname, '..');

/** The pharmacy modules: every file under these, plus files whose name starts with these. */
const PHARMACY_DIRECTORIES = [
  'src/lib/pharmacy',
  'src/app/(app)/pharmacy',
  'src/app/api/pharmacy',
  'src/components/pharmacy',
];
const PHARMACY_FILE_PREFIXES = [
  'src/server/routers/pharmacy-',
  'src/server/pharmacy-',
  'src/lib/ai/tools/pharmacy-',
];

/** The day helpers a pharmacy module may not import, by module. */
const FORBIDDEN: Record<string, readonly string[]> = {
  '@/lib/timezone': ['workspaceToday', 'workspaceDateRange', 'workspaceDateOffset'],
  '@/lib/restaurant/business-date': ['resolveBusinessDate'],
};

/**
 * Reviewed exceptions, with the reason. Pinned: a new entry is a reviewed change to this list.
 */
const ALLOWED: Record<string, string> = {
  // The shared helper itself.
  'src/lib/pharmacy/business-day.ts': 'the one place the day is decided',
  // SOP schedules run on the SOP site's own zone and cutoff (`PharmacySopSite`), a separate
  // setting for task schedules, not money.
  'src/server/routers/pharmacy-sop.ts': 'SOP site clock (PharmacySopSite.businessDayCutoff)',
};

function walk(directory: string): string[] {
  const absolute = path.join(ROOT, directory);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = path.posix.join(directory, entry);
    return statSync(path.join(ROOT, relative)).isDirectory() ? walk(relative) : [relative];
  });
}

function pharmacyModules(): string[] {
  const prefixed = [...new Set(PHARMACY_FILE_PREFIXES.map((prefix) => path.posix.dirname(prefix)))]
    .flatMap(walk)
    .filter((file) => PHARMACY_FILE_PREFIXES.some((prefix) => file.startsWith(prefix)));
  return [...new Set([...PHARMACY_DIRECTORIES.flatMap(walk), ...prefixed])]
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
    .sort();
}

/**
 * The module a specifier names, as the `@/` alias would: a relative specifier is resolved from
 * `file`, so `'../timezone'` inside `src/lib/pharmacy` is caught as `@/lib/timezone`.
 */
function moduleOf(specifier: string, file?: string): string {
  if (!specifier.startsWith('.') || !file) return specifier;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return resolved.startsWith('src/')
    ? `@/${resolved.slice(4).replace(/\.(ts|tsx)$/, '')}`
    : resolved;
}

/** The forbidden day helpers `source` (the module at `file`) imports, as `module:name`. */
export function forbiddenDayImports(source: string, file?: string): string[] {
  const found: string[] = [];
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(imports)) {
    const banned = FORBIDDEN[moduleOf(match[2]!, file)];
    if (!banned) continue;
    for (const raw of match[1]!.split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (banned.includes(name)) found.push(`${moduleOf(match[2]!, file)}:${name}`);
    }
  }
  // A namespace or default import would reach the same helpers by another name.
  const whole = /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(whole)) {
    const name = moduleOf(match[1]!, file);
    if (FORBIDDEN[name]) found.push(`${name}:*`);
  }
  // So would a dynamic import or a require.
  const dynamic = /(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(dynamic)) {
    const name = moduleOf(match[1]!, file);
    if (FORBIDDEN[name]) found.push(`${name}:*`);
  }
  return found;
}

/**
 * A day worked out by hand rather than through the helper: a `YYYY-MM-DD` formatter
 * (`Intl.DateTimeFormat('en-CA', …)`), or the UTC date of the current instant
 * (`now.toISOString().slice(0, 10)`, also `new Date()`, `Date.now()` or `at`).
 */
export function handRolledDays(source: string): string[] {
  const found: string[] = [];
  if (/Intl\.DateTimeFormat\(\s*['"]en-CA['"]/.test(source)) found.push('en-CA formatter');
  if (
    /(?:new Date\(\)|\bnow\b|\bat\b|Date\.now\(\))\.toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/.test(
      source
    )
  )
    found.push('UTC date of an instant');
  return found;
}

/**
 * Hand-rolled day code that is not a business day, pinned with the reason. Pinned: a new entry
 * is a reviewed change to this list, and one that is no longer there must be removed.
 */
const PINNED_HAND_ROLLED: Record<string, string> = {
  'src/lib/pharmacy/sms/fallback.ts → UTC date of an instant':
    'a once-a-day SMS de-duplication key, not a business day',
  'src/lib/pharmacy/owner-digest.ts → en-CA formatter':
    'the wall-clock time a digest is sent at (`nextDigestDueAt`); its business day uses the helper',
  'src/lib/pharmacy/whatsapp/khata-reminders.ts → en-CA formatter':
    'a once-a-day WhatsApp reminder de-duplication key, not a business day',
  'src/lib/pharmacy/sop-adapter.ts → en-CA formatter':
    'SOP schedules on the SOP site clock (PharmacySopSite.businessDayCutoff)',
  'src/lib/pharmacy/marketing-dates.ts → en-CA formatter':
    'campaign and voucher calendar dates and times, not business days',
  'src/lib/pharmacy/staffing-suggestions.ts → en-CA formatter':
    'the local hour of day a receipt falls in, for hourly staffing bins',
  'src/lib/pharmacy/hosted-receipt-service.ts → en-CA formatter':
    'a once-a-day receipt-link de-duplication key, not a business day',
  'src/lib/pharmacy/expiry-advisor-operations.ts → UTC date of an instant':
    'a reference stamp on an expiry advice record, not a business day',
  'src/server/routers/pharmacy-inventory.ts → UTC date of an instant':
    'a reference stamp on a stock document number, not a business day',
};

describe('pharmacy modules decide a business day only through business-day.ts (DEV-958A)', () => {
  const modules = pharmacyModules();

  it('finds the pharmacy modules it guards', () => {
    expect(modules.length).toBeGreaterThan(300);
    for (const file of [
      'src/lib/pharmacy/settlement.ts',
      'src/lib/pharmacy/day-close.ts',
      'src/server/routers/pharmacy-sales.ts',
      'src/server/routers/pharmacy-offline.ts',
      'src/server/routers/pharmacy-reports.ts',
      'src/components/pharmacy/counter/counter-console.tsx',
      'src/app/(app)/pharmacy/finance/ledger-reports.tsx',
      'src/lib/ai/tools/pharmacy-reports.ts',
    ])
      expect(modules).toContain(file);
  });

  it('refuses a pharmacy module that works a day out without the shared helper', () => {
    const offenders = modules
      .filter((file) => !(file in ALLOWED))
      .flatMap((file) =>
        forbiddenDayImports(readFileSync(path.join(ROOT, file), 'utf8'), file).map(
          (name) => `${file} → ${name}`
        )
      );
    expect(offenders).toEqual([]);
  });

  it('refuses a pharmacy module that works a day out by hand', () => {
    const found = modules
      .filter((file) => !(file in ALLOWED))
      .flatMap((file) =>
        handRolledDays(readFileSync(path.join(ROOT, file), 'utf8')).map(
          (kind) => `${file} → ${kind}`
        )
      );
    expect(found.filter((entry) => !(entry in PINNED_HAND_ROLLED))).toEqual([]);
    // The pinned list only shrinks: an entry whose code has gone is removed from it.
    expect(Object.keys(PINNED_HAND_ROLLED).filter((entry) => !found.includes(entry))).toEqual([]);
  });

  it('keeps every allowance pointing at a real module', () => {
    for (const file of Object.keys(ALLOWED)) expect(modules).toContain(file);
  });
});

describe('the business-day guard detector', () => {
  it('catches named, renamed, namespace and dynamic imports of a day helper', () => {
    expect(
      forbiddenDayImports(`import { formatWorkspaceDate, workspaceToday } from '@/lib/timezone';`)
    ).toEqual(['@/lib/timezone:workspaceToday']);
    expect(
      forbiddenDayImports(`import {\n  workspaceDateRange as range,\n} from "@/lib/timezone";`)
    ).toEqual(['@/lib/timezone:workspaceDateRange']);
    expect(forbiddenDayImports(`import * as tz from '@/lib/timezone';`)).toEqual([
      '@/lib/timezone:*',
    ]);
    expect(forbiddenDayImports(`const tz = await import('@/lib/timezone');`)).toEqual([
      '@/lib/timezone:*',
    ]);
    expect(
      forbiddenDayImports(`import { resolveBusinessDate } from '@/lib/restaurant/business-date';`)
    ).toEqual(['@/lib/restaurant/business-date:resolveBusinessDate']);
  });

  it('resolves a relative import to the module it names', () => {
    expect(
      forbiddenDayImports(`import { workspaceToday } from '../timezone';`, 'src/lib/pharmacy/x.ts')
    ).toEqual(['@/lib/timezone:workspaceToday']);
    expect(
      forbiddenDayImports(
        `import { resolveBusinessDate } from '../../lib/restaurant/business-date';`,
        'src/server/routers/pharmacy-x.ts'
      )
    ).toEqual(['@/lib/restaurant/business-date:resolveBusinessDate']);
    expect(
      forbiddenDayImports(`import * as tz from '../../timezone';`, 'src/lib/pharmacy/a/b.ts')
    ).toEqual(['@/lib/timezone:*']);
    expect(
      forbiddenDayImports(`import { workspaceToday } from './timezone';`, 'src/lib/pharmacy/x.ts')
    ).toEqual([]);
  });

  it('catches a day worked out by hand', () => {
    expect(
      handRolledDays(`const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);`)
    ).toEqual(['en-CA formatter']);
    expect(handRolledDays(`const today = new Date().toISOString().slice(0, 10);`)).toEqual([
      'UTC date of an instant',
    ]);
    expect(handRolledDays(`const key = now.toISOString().slice(0,10);`)).toEqual([
      'UTC date of an instant',
    ]);
    // A stored date's own day name is not a new instant's day.
    expect(handRolledDays(`const day = businessDate.toISOString().slice(0, 10);`)).toEqual([]);
    expect(handRolledDays(`new Intl.DateTimeFormat('en-GB', { day: 'numeric' })`)).toEqual([]);
  });

  it('lets the zone helpers that pick no day through', () => {
    expect(
      forbiddenDayImports(
        `import { formatWorkspaceDateTime, workspaceTimezone, workspaceZoneLabel } from '@/lib/timezone';\nimport { pharmacyBusinessDay } from '@/lib/pharmacy/business-day';`
      )
    ).toEqual([]);
  });
});
