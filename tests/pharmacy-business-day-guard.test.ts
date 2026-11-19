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

/** The forbidden day helpers `source` imports, as `module:name`. */
export function forbiddenDayImports(source: string): string[] {
  const found: string[] = [];
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(imports)) {
    const banned = FORBIDDEN[match[2]!];
    if (!banned) continue;
    for (const raw of match[1]!.split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (banned.includes(name)) found.push(`${match[2]}:${name}`);
    }
  }
  // A namespace or default import would reach the same helpers by another name.
  const whole = /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(whole)) if (FORBIDDEN[match[1]!]) found.push(`${match[1]}:*`);
  // So would a dynamic import or a require.
  const dynamic = /(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(dynamic))
    if (FORBIDDEN[match[1]!]) found.push(`${match[1]}:*`);
  return found;
}

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
        forbiddenDayImports(readFileSync(path.join(ROOT, file), 'utf8')).map(
          (name) => `${file} → ${name}`
        )
      );
    expect(offenders).toEqual([]);
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

  it('lets the zone helpers that pick no day through', () => {
    expect(
      forbiddenDayImports(
        `import { formatWorkspaceDateTime, workspaceTimezone, workspaceZoneLabel } from '@/lib/timezone';\nimport { pharmacyBusinessDay } from '@/lib/pharmacy/business-day';`
      )
    ).toEqual([]);
  });
});
