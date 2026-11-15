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
 *    own site, setting, record-link, capture-receipt and rework-note rows;
 *    record links point at existing records. Only the pharmacy evidence route
 *    and the manual legacy backfill script write capture receipts; only the
 *    pharmacy SOP router writes rework notes.
 * 3. SOP code reaches pharmacy operation code only through a read helper.
 * 4. SOP code enqueues exactly one job type, its own hourly automatic-
 *    scheduling job, from exactly one module; it never enqueues an engine,
 *    escalation, sweep or restaurant job. The per-branch automatic-scheduling
 *    setting is read by no pharmacy operation code, and only that job module
 *    calls the automatic generator.
 * 5. The one exception to 4 is opt-in overdue escalation (OFF by default): one
 *    module enqueues its own sweep and the shared engine's escalation job, and
 *    nothing else; no other SOP code enqueues either.
 */

const ROOT = join(__dirname, '..');

/** Files that ARE the SOP layer (owned by DEV-751). */
const SOP_FILES = new Set([
  'src/lib/pharmacy/sop-adapter.ts',
  'src/lib/pharmacy/sop-library.ts',
  'src/lib/pharmacy/sop-evidence.ts',
  'src/lib/pharmacy/sop-evidence-mac.ts',
  'src/lib/pharmacy/sop-shared.ts',
  'src/lib/pharmacy/sop-settings.ts',
  'src/lib/pharmacy/sop-auto-schedule-job.ts',
  'src/lib/pharmacy/sop-overdue-escalation.ts',
  'src/server/routers/pharmacy-sop.ts',
  'src/app/api/pharmacy/sop/evidence/route.ts',
]);
const SOP_DIRS = ['src/components/pharmacy/sop/', 'src/app/(app)/pharmacy/sop/'];

/** The one SOP module allowed to enqueue a job (its own type only). */
const AUTO_SCHEDULE_JOB_MODULE = 'src/lib/pharmacy/sop-auto-schedule-job.ts';

/** The one SOP module allowed to enqueue overdue escalation (opt-in per branch). */
const ESCALATION_JOB_MODULE = 'src/lib/pharmacy/sop-overdue-escalation.ts';

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
        writes.filter(
          (model) =>
            !/^pharmacySop(Site|SiteSetting|RecordLink|EvidenceCapture|ReworkNote)$/.test(model!)
        )
      ).toEqual([]);
      // No raw SQL write against a pharmacy table.
      expect(source).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?pharmacy_/i);
    }
  });

  it('only the pharmacy evidence route and the legacy backfill write capture receipts', () => {
    // The receipt writer itself lives in sop-evidence.ts; who may call it is pinned here.
    const RECEIPT_WRITE =
      /pharmacySopEvidenceCapture\.(create|createMany|upsert)\b|writePharmacySopUploadReceipt\s*\(|INSERT\s+INTO\s+"?pharmacy_sop_evidence_captures/;
    const writers = [...walk('src'), ...walk('scripts'), ...walk('prisma')]
      .filter((file) => !file.startsWith('src/generated/'))
      .filter((file) => RECEIPT_WRITE.test(readFileSync(join(ROOT, file), 'utf8')))
      .sort();
    expect(writers).toEqual([
      'scripts/pharmacy-sop-legacy-capture-backfill.ts',
      'src/app/api/pharmacy/sop/evidence/route.ts',
      'src/lib/pharmacy/sop-evidence.ts',
    ]);
    const evidence = readFileSync(join(ROOT, 'src/lib/pharmacy/sop-evidence.ts'), 'utf8');
    const callers = walk('src').filter(
      (file) =>
        file !== 'src/lib/pharmacy/sop-evidence.ts' &&
        /writePharmacySopUploadReceipt/.test(readFileSync(join(ROOT, file), 'utf8'))
    );
    expect(evidence).toMatch(/export async function writePharmacySopUploadReceipt/);
    expect(callers).toEqual(['src/app/api/pharmacy/sop/evidence/route.ts']);
    // Receipts are never updated or deleted by any code.
    for (const file of [...walk('src'), ...walk('scripts')].filter(
      (path) => !path.startsWith('src/generated/')
    )) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(
        /pharmacySopEvidenceCapture\.(update|updateMany|delete|deleteMany)\b|(UPDATE|DELETE\s+FROM)\s+"?pharmacy_sop_evidence_captures/
      );
    }
  });

  it('only the pharmacy SOP router writes rework notes, and nothing updates or deletes one', () => {
    const NOTE_WRITE =
      /pharmacySopReworkNote\.(create|createMany|createManyAndReturn|upsert)\b|INSERT\s+INTO\s+"?pharmacy_sop_rework_notes/;
    const writers = [...walk('src'), ...walk('scripts'), ...walk('prisma')]
      .filter((file) => !file.startsWith('src/generated/'))
      .filter((file) => NOTE_WRITE.test(readFileSync(join(ROOT, file), 'utf8')))
      .sort();
    expect(writers).toEqual(['src/server/routers/pharmacy-sop.ts']);
    // Exactly one write site, in the rework-note mutation.
    const router = readFileSync(join(ROOT, 'src/server/routers/pharmacy-sop.ts'), 'utf8');
    expect(router.match(/pharmacySopReworkNote\.create\b/g)).toHaveLength(1);
    for (const file of [...walk('src'), ...walk('scripts')].filter(
      (path) => !path.startsWith('src/generated/')
    )) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(
        /pharmacySopReworkNote\.(update|updateMany|delete|deleteMany)\b|(UPDATE|DELETE\s+FROM)\s+"?pharmacy_sop_rework_notes/
      );
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
        if (
          /^sop-(adapter|library|evidence|evidence-mac|shared|settings|auto-schedule-job|overdue-escalation)$/.test(
            module!
          )
        )
          continue;
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

  it('SOP code enqueues only its own two automatic-scheduling jobs, from one module', () => {
    const sopSources = [...SOP_FILES, ...SOP_DIRS.flatMap((dir) => walk(dir.replace(/\/$/, '')))];
    expect(sopSources).toContain('src/lib/pharmacy/sop-settings.ts');
    expect(sopSources).toContain('src/components/pharmacy/sop/sop-setup.tsx');
    const ENQUEUE =
      /restaurantJob\b|restaurant_jobs\b|@\/lib\/restaurant\/(scheduler|job-handlers)|\benqueue[A-Z]?\w*\s*\(|SOP_GENERATE_OCCURRENCES_JOB|SOP_ESCALATION_JOB|'sop\.(generateOccurrences|runEscalation)'/;
    const offenders = sopSources.filter(
      (file) =>
        file !== AUTO_SCHEDULE_JOB_MODULE &&
        file !== ESCALATION_JOB_MODULE &&
        ENQUEUE.test(readFileSync(join(ROOT, file), 'utf8'))
    );
    expect(offenders).toEqual([]);

    // The job module: exactly two enqueue calls, of its own two types, and no
    // other job: the hourly parent (next slot) and the per-branch child.
    const job = readFileSync(join(ROOT, AUTO_SCHEDULE_JOB_MODULE), 'utf8');
    expect(job).toContain(
      "export const PHARMACY_SOP_AUTO_GENERATE_JOB = 'pharmacy.sop.autoGenerate';"
    );
    expect(job).toContain(
      "export const PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB = 'pharmacy.sop.autoGenerateBranch';"
    );
    expect(job.match(/\benqueue[A-Z]?\w*\s*\(/g)).toEqual(['enqueue(', 'enqueue(']);
    // The two enqueued job literals, plus (between them in the source) the
    // read-only next-run lookup `nextPharmacySopAutoScheduleRunAt`, a findFirst
    // on its own slot type.
    expect(job.match(/\btype: [A-Z_]+,/g)).toEqual([
      'type: PHARMACY_SOP_AUTO_GENERATE_JOB,',
      'type: PHARMACY_SOP_AUTO_GENERATE_JOB,',
      'type: PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB,',
    ]);
    // Its only direct use of the job table is that one read: every write goes
    // through the scheduler's `enqueue`.
    expect(job.match(/\.restaurantJob\.\w+/g)).toEqual(['.restaurantJob.findFirst']);
    expect(job).not.toMatch(
      /SOP_(GENERATE_OCCURRENCES|ESCALATION|LATE_MISSED)_JOB|'sop\.\w+'|sop-escalation|sop-late-missed|@\/lib\/restaurant\/job-handlers'/
    );
    // Its types are registered once (job-handlers.ts) and referenced nowhere else.
    const references = [...walk('src'), ...walk('scripts')]
      .filter((file) => !file.startsWith('src/generated/'))
      .filter((file) =>
        /PHARMACY_SOP_AUTO_GENERATE(_BRANCH)?_JOB|pharmacy\.sop\.autoGenerate/.test(
          readFileSync(join(ROOT, file), 'utf8')
        )
      )
      .sort();
    expect(references).toEqual([AUTO_SCHEDULE_JOB_MODULE, 'src/lib/restaurant/job-handlers.ts']);
  });

  it('opt-in overdue escalation enqueues only its own sweep and the shared escalation job', () => {
    const job = readFileSync(join(ROOT, ESCALATION_JOB_MODULE), 'utf8');
    expect(job).toContain(
      "export const PHARMACY_SOP_ESCALATE_OVERDUE_JOB = 'pharmacy.sop.escalateOverdue';"
    );
    // Exactly two enqueue calls: the next sweep, and one shared escalation job
    // per overdue occurrence. No engine generation, late/missed sweep or other job.
    expect(job.match(/\benqueue[A-Z]?\w*\s*\(/g)).toEqual(['enqueue(', 'enqueue(']);
    expect(job.match(/\btype: [A-Z_]+,/g)).toEqual([
      'type: PHARMACY_SOP_ESCALATE_OVERDUE_JOB,',
      'type: SOP_ESCALATION_JOB,',
    ]);
    expect(job).not.toMatch(/\.restaurantJob\.\w+/);
    expect(job).not.toMatch(
      /SOP_(GENERATE_OCCURRENCES|LATE_MISSED)_JOB|'sop\.\w+'|sop-late-missed|@\/lib\/restaurant\/job-handlers'/
    );
    // It never writes an escalation event or notification itself: the shared
    // handler does, under its own lock.
    expect(job).not.toMatch(/restaurantSopEscalationEvent|appendNotificationRequest/);
    // Its type is registered once (job-handlers.ts) and referenced nowhere else.
    const references = [...walk('src'), ...walk('scripts')]
      .filter((file) => !file.startsWith('src/generated/'))
      .filter((file) =>
        /PHARMACY_SOP_ESCALATE_OVERDUE_JOB|pharmacy\.sop\.escalateOverdue/.test(
          readFileSync(join(ROOT, file), 'utf8')
        )
      )
      .sort();
    expect(references).toEqual([ESCALATION_JOB_MODULE, 'src/lib/restaurant/job-handlers.ts']);
  });

  it('the automatic-scheduling code never opens a client or transaction of its own', () => {
    // The worker hands each handler ONE tenant transaction; the request path
    // hands its own. Opening another client would compete with it for a pool
    // connection (the platform rule in scoped-db.ts).
    for (const file of [
      AUTO_SCHEDULE_JOB_MODULE,
      ESCALATION_JOB_MODULE,
      'src/lib/pharmacy/sop-settings.ts',
    ]) {
      // Code only: the modules' comments explain the rule by naming these.
      const source = readFileSync(join(ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(
        /\b(createTenantDb|withTenantDb|withPlatformDb|withOrganizationDefaults)\b/
      );
      expect(source, file).not.toMatch(
        /@\/lib\/db'|from '\.\.?\/[\w/-]*\bdb'|new PrismaClient|\bpg\b'/
      );
      // Only types come from scoped-db.
      for (const line of source.split('\n').filter((l) => l.includes('@/lib/tenancy/scoped-db'))) {
        expect(line, file).toMatch(
          /^import type \{ ScopedDb \} from '@\/lib\/tenancy\/scoped-db';$/
        );
      }
    }
  });

  it('the automatic-scheduling setting never appears in pharmacy operation code', () => {
    const SETTING = /autoSchedule|pharmacySopSiteSetting|pharmacy_sop_site_settings|sop-settings/i;
    // Including the two read-only exceptions: neither may consult the setting.
    const offenders = operationFiles.filter((file) =>
      SETTING.test(readFileSync(join(ROOT, file), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('only the automatic-scheduling jobs call the automatic generator (no route)', () => {
    const callers = walk('src').filter(
      (file) =>
        file !== 'src/lib/pharmacy/sop-settings.ts' &&
        !/\.test\.tsx?$/.test(file) &&
        /generateAutoPharmacySopBranchOccurrences|pharmacySopAutoScheduledBranchIds/.test(
          readFileSync(join(ROOT, file), 'utf8')
        )
    );
    expect(callers).toEqual([AUTO_SCHEDULE_JOB_MODULE]);
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
