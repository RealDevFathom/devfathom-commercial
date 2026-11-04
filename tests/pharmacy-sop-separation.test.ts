import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * DEV-751 — pharmacy procedures (SOPs) are instructions for the person they are
 * assigned to, plus the proof that person sends. They are follow-up work only:
 * an incomplete, overdue or rejected SOP never blocks, gates, authorizes or
 * changes opening, closing, selling, dispensing, receiving or any other
 * pharmacy workflow. Required proof gates only the SOP's own submission and
 * review. These checks pin that separation at the source level:
 *
 * 1. No pharmacy operation code reads or imports the SOP layer, so no operation
 *    can depend on SOP state. Two explicit, read-only exceptions: the safety
 *    router installs the template library on request, and the inspection pack
 *    exports SOP history for inspectors.
 * 2. SOP code never writes a pharmacy operation table. It may only append its
 *    own site and record-link rows; record links point at existing records.
 * 3. SOP code reaches pharmacy operation code only through a read helper.
 * 4. SOP code never enqueues a scheduler/restaurant job, and the per-branch
 *    automatic-scheduling setting is read by no pharmacy operation code. The
 *    automatic generator has no trigger wired: nothing calls it yet.
 */

const ROOT = join(__dirname, '..');

/** Files that ARE the SOP layer (owned by DEV-751). */
const SOP_FILES = new Set([
  'src/lib/pharmacy/sop-adapter.ts',
  'src/lib/pharmacy/sop-library.ts',
  'src/lib/pharmacy/sop-evidence.ts',
  'src/lib/pharmacy/sop-shared.ts',
  'src/lib/pharmacy/sop-settings.ts',
  'src/server/routers/pharmacy-sop.ts',
  'src/app/api/pharmacy/sop/evidence/route.ts',
]);
const SOP_DIRS = ['src/components/pharmacy/sop/', 'src/app/(app)/pharmacy/sop/'];

/** Read-only touch points, each limited to what is listed. */
const READ_ONLY_EXCEPTIONS: Record<string, RegExp[]> = {
  // Installs the template library on an explicit request; no gate reads it.
  'src/server/routers/pharmacy-safety.ts': [/installPharmacySopLibrary/],
  // Exports SOP history (SELECT only) into the inspection pack.
  'src/lib/pharmacy/inspection-pack.ts': [/sop/i],
};

const OPERATION_ROOTS = [
  'src/lib/pharmacy',
  'src/server/routers',
  'src/app/api/pharmacy',
  'src/app/(app)/pharmacy',
  'src/components/pharmacy',
];

const SOP_REFERENCE =
  /restaurantSop|restaurant_sop_|pharmacySop|pharmacy_sop_|PharmacySop|@\/lib\/restaurant\/sop-|@\/lib\/pharmacy\/sop-|pharmacy\/sop\b/;

function walk(dir: string): string[] {
  const abs = join(ROOT, dir);
  return readdirSync(abs).flatMap((name) => {
    const path = join(abs, name);
    if (statSync(path).isDirectory()) return walk(relative(ROOT, path));
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
      ? [relative(ROOT, path).split('\\').join('/')]
      : [];
  });
}

const isSopFile = (file: string) =>
  SOP_FILES.has(file) || SOP_DIRS.some((dir) => file.startsWith(dir));

const operationFiles = OPERATION_ROOTS.flatMap(walk).filter(
  (file) =>
    !isSopFile(file) &&
    // Only pharmacy routers are pharmacy operations; restaurant routers own the
    // shared engine's restaurant surface.
    (!file.startsWith('src/server/routers/') || /\/pharmacy-[^/]+\.ts$/.test(file))
);

describe('pharmacy SOPs never gate pharmacy operations (DEV-751)', () => {
  it('finds the pharmacy operation code it guards', () => {
    expect(operationFiles.length).toBeGreaterThan(50);
    expect(operationFiles).toContain('src/server/routers/pharmacy-sales.ts');
  });

  it('no pharmacy operation reads or imports the SOP layer', () => {
    const offenders = operationFiles.filter((file) => {
      if (Object.hasOwn(READ_ONLY_EXCEPTIONS, file)) return false;
      return SOP_REFERENCE.test(readFileSync(join(ROOT, file), 'utf8'));
    });
    expect(offenders).toEqual([]);
  });

  it('the two exceptions only install templates or export history', () => {
    const safety = readFileSync(join(ROOT, 'src/server/routers/pharmacy-safety.ts'), 'utf8');
    const sopLines = safety.split('\n').filter((line) => SOP_REFERENCE.test(line));
    for (const line of sopLines) {
      expect(
        READ_ONLY_EXCEPTIONS['src/server/routers/pharmacy-safety.ts']!.some((re) => re.test(line))
      ).toBe(true);
    }
    // The inspection export reads SOP history with SELECT statements only.
    const pack = readFileSync(join(ROOT, 'src/lib/pharmacy/inspection-pack.ts'), 'utf8');
    expect(pack).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b[^;]*\b(restaurant_sop_|pharmacy_sop_)/i);
    expect(pack).not.toMatch(/\.(restaurantSop|pharmacySop)\w*\.(create|update|upsert|delete)/);
  });

  it('SOP code never writes a pharmacy operation table', () => {
    for (const file of SOP_FILES) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const writes = [
        ...source.matchAll(
          /\.(pharmacy[A-Za-z]*)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g
        ),
      ].map((match) => match[1]);
      // Only its own append-only rows.
      expect(
        writes.filter((model) => !/^pharmacySop(Site|SiteSetting|RecordLink)$/.test(model!))
      ).toEqual([]);
      // No raw SQL write against a pharmacy table.
      expect(source).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?pharmacy_/i);
    }
  });

  it('SOP code reaches pharmacy operation code only through a read helper', () => {
    for (const file of SOP_FILES) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const imports = [
        ...source.matchAll(
          /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@\/lib\/pharmacy\/([^']+)'/g
        ),
      ];
      for (const [, names, module] of imports) {
        if (/^sop-(adapter|library|evidence|shared|settings)$/.test(module!)) continue;
        expect(module).toBe('controlled-register');
        expect(
          names!
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        ).toEqual(['assignedRegisterBranchIds']);
      }
    }
  });

  it('SOP code never enqueues a scheduler, engine or restaurant job', () => {
    const sopSources = [...SOP_FILES, ...SOP_DIRS.flatMap((dir) => walk(dir.replace(/\/$/, '')))];
    expect(sopSources).toContain('src/lib/pharmacy/sop-settings.ts');
    expect(sopSources).toContain('src/components/pharmacy/sop/sop-setup.tsx');
    const ENQUEUE =
      /restaurantJob\b|restaurant_jobs\b|@\/lib\/restaurant\/(scheduler|job-handlers)|\benqueue[A-Z]?\w*\s*\(|SOP_GENERATE_OCCURRENCES_JOB|SOP_ESCALATION_JOB|'sop\.(generateOccurrences|runEscalation)'/;
    const offenders = sopSources.filter((file) =>
      ENQUEUE.test(readFileSync(join(ROOT, file), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('the automatic-scheduling setting never appears in pharmacy operation code', () => {
    const SETTING = /autoSchedule|pharmacySopSiteSetting|pharmacy_sop_site_settings|sop-settings/i;
    // Including the two read-only exceptions: neither may consult the setting.
    const offenders = operationFiles.filter((file) =>
      SETTING.test(readFileSync(join(ROOT, file), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('the automatic generator has no trigger wired (no route, job or scheduler calls it)', () => {
    const callers = walk('src').filter(
      (file) =>
        file !== 'src/lib/pharmacy/sop-settings.ts' &&
        /generateAutoPharmacySopOccurrences/.test(readFileSync(join(ROOT, file), 'utf8'))
    );
    // Wiring a recurring trigger is an ops decision; update this pin with it.
    expect(callers).toEqual([]);
  });

  it('SOP grants never come from, or depend on, a pharmacy operation capability', async () => {
    const { PHARMACY_ROLE_TEMPLATES, PHARMACY_SOP_TEMPLATE_GRANTS } =
      await import('@/lib/vertical-catalog');
    for (const grants of Object.values(PHARMACY_SOP_TEMPLATE_GRANTS)) {
      for (const grant of grants) expect(grant.startsWith('sop:')).toBe(true);
    }
    // Every operation capability a role holds is identical with or without SOP.
    for (const role of PHARMACY_ROLE_TEMPLATES) {
      const operation = role.capabilities.filter((grant) => !grant.startsWith('sop:'));
      const appended = PHARMACY_SOP_TEMPLATE_GRANTS[role.key] ?? [];
      expect(role.capabilities).toEqual([...operation, ...appended]);
    }
  });
});
