import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveEntitlementLimit } from '@/lib/entitlement-limits';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { emitUniversityEvent } from './events';
import { importStudentOpeningBalance } from './finance';
import { officeRoleAllowed, type UniversityContext, type UniversityOffice } from './office-types';

const registrars = ['university-registrar'];
const approvers = ['university-finance-approver'];
const reference = z.string().trim().min(1).max(120);
const day = z.iso.date();
const controlsSchema = z.strictObject({
  students: z.int().nonnegative(),
  activeStudents: z.int().nonnegative(),
  enrollments: z.int().nonnegative(),
  transcripts: z.int().nonnegative(),
  openingDebitPaisa: z.int().nonnegative(),
  openingCreditPaisa: z.int().nonnegative(),
});
const studentSchema = z.strictObject({
  legacyId: reference,
  existingPersonId: reference.optional(),
  email: z.email().max(254).toLowerCase(),
  fullName: z.string().trim().min(1).max(200),
  intakeId: reference,
  status: z.enum(['ACTIVE', 'WITHDRAWN', 'GRADUATED']),
  matriculatedOn: day,
  endedOn: day.optional(),
  participation: z
    .array(
      z.strictObject({
        sectionId: reference,
        recordedOn: day,
        mark: z.int().min(0).max(100).optional(),
      })
    )
    .max(100),
  transcript: z
    .strictObject({
      sourceReference: reference,
      issuedOn: day,
      version: reference,
      documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      snapshot: z.record(z.string(), z.json()),
    })
    .optional(),
  openingBalance: z
    .strictObject({
      reference,
      signedPaisa: z.int().refine((n) => n !== 0, 'Omit zero balances.'),
      asOf: day,
    })
    .optional(),
});
const manifestSchema = z.strictObject({
  format: z.literal(1),
  controls: controlsSchema,
  students: z.array(studentSchema).min(1).max(50),
});
type Manifest = z.infer<typeof manifestSchema>;
type Student = Manifest['students'][number];
type Batch = {
  id: string;
  state: 'STAGED' | 'VALIDATED' | 'FINALIZED' | 'CANCELLED';
  manifest: Manifest;
  source_system: string;
  digest: string;
  evidence: string;
  prepared_by: string;
  validated_by: string | null;
  finance_signed_by: string | null;
};
type Input = Record<string, string>;
const roles = [...registrars, ...approvers, 'university-admin'];

export function reconcileHistoricalManifest(value: unknown): Manifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('Invalid import format at ' + parsed.error.issues[0].path.join('.') + '.');
  const manifest = parsed.data;
  const actual = {
    students: manifest.students.length,
    activeStudents: 0,
    enrollments: 0,
    transcripts: 0,
    openingDebitPaisa: 0,
    openingCreditPaisa: 0,
  };
  const keys = new Set<string>(),
    emails = new Set<string>(),
    balances = new Set<string>(),
    people = new Set<string>();
  for (const row of manifest.students) {
    if (
      keys.has(row.legacyId) ||
      emails.has(row.email) ||
      (row.existingPersonId && people.has(row.existingPersonId))
    )
      throw new Error('Each batch must identify distinct students and verified email addresses.');
    keys.add(row.legacyId);
    emails.add(row.email);
    if (row.existingPersonId) people.add(row.existingPersonId);
    if (
      (row.status === 'ACTIVE') === !!row.endedOn ||
      (row.endedOn && row.endedOn < row.matriculatedOn)
    )
      throw new Error('Historical status and program dates do not agree.');
    if (new Set(row.participation.map((x) => x.sectionId)).size !== row.participation.length)
      throw new Error('A student section is repeated.');
    if (
      row.participation.some(
        (x) => x.recordedOn < row.matriculatedOn || (row.endedOn && x.recordedOn > row.endedOn)
      )
    )
      throw new Error('Participation falls outside program membership.');
    if (row.transcript && row.transcript.issuedOn < row.matriculatedOn)
      throw new Error('Transcript predates matriculation.');
    actual.activeStudents += Number(row.status === 'ACTIVE');
    actual.enrollments += row.participation.length;
    actual.transcripts += Number(!!row.transcript);
    if (row.openingBalance) {
      if (balances.has(row.openingBalance.reference))
        throw new Error('Duplicate opening balance reference.');
      balances.add(row.openingBalance.reference);
      actual.openingDebitPaisa += Math.max(0, row.openingBalance.signedPaisa);
      actual.openingCreditPaisa += Math.max(0, -row.openingBalance.signedPaisa);
    }
  }
  if (actual.enrollments > 250)
    throw new Error('Split batches with more than 250 section records.');
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
    if (!Number.isSafeInteger(actual[key]) || actual[key] !== manifest.controls[key])
      throw new Error('Reconciliation failed for ' + key + '.');
  }
  return manifest;
}

async function requireImportAccess(ctx: UniversityContext, manifest: Manifest) {
  const view =
    ctx.entitlements ?? (await resolveOrganizationEntitlements(ctx.organizationId, ctx.db));
  if (
    view.vertical !== 'UNIVERSITY' ||
    !['university-core', 'university-admissions', 'university-academics'].every((k) =>
      hasModule(view, k)
    )
  )
    throw new Error('Admissions and academic records must be licensed for historical import.');
  if (manifest.students.some((s) => s.openingBalance) && !hasModule(view, 'university-finance'))
    throw new Error('Historical balances require the finance module.');
  return view;
}
function requireRole(ctx: UniversityContext, allowed: readonly string[]) {
  if (!officeRoleAllowed(ctx, allowed)) throw new Error('This staff role cannot sign this import.');
}
async function openBatch(ctx: UniversityContext, input: Input) {
  const [batch] = await ctx.db.$queryRaw<
    Batch[]
  >`SELECT * FROM university_import_batches WHERE organization_id=${ctx.organizationId} AND id=${input.batchId} FOR UPDATE`;
  if (!batch || batch.digest !== input.digest.trim().toLowerCase())
    throw new Error('Select the batch and confirm its exact SHA-256 digest.');
  return batch;
}

async function stage(ctx: UniversityContext, input: Input) {
  requireRole(ctx, registrars);
  const source = reference.parse(input.sourceSystem),
    batchKey = reference.parse(input.sourceBatch),
    evidence = reference.parse(input.evidence);
  const revision = z.coerce.number().int().positive().parse(input.revision);
  const digest = createHash('sha256').update(input.manifest).digest('hex');
  if (input.digest.trim().toLowerCase() !== digest)
    throw new Error('The source checksum does not match the submitted JSON.');
  let value: unknown;
  try {
    value = JSON.parse(input.manifest);
  } catch {
    throw new Error('Enter valid JSON for the source manifest.');
  }
  const manifest = reconcileHistoricalManifest(value);
  await requireImportAccess(ctx, manifest);
  const { db, organizationId: org, userId } = ctx;
  await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('university-imports:' || ${org},0))`;
  const [previous] = await db.$queryRaw<
    { id: string; revision: number; digest: string; state: string; evidence: string }[]
  >`SELECT id,revision,digest,state,evidence FROM university_import_batches WHERE organization_id=${org} AND source_system=${source} AND source_batch=${batchKey} ORDER BY revision DESC LIMIT 1`;
  if (
    previous &&
    previous.revision === revision &&
    previous.digest === digest &&
    previous.evidence === evidence
  )
    return previous;
  if (previous && (previous.state !== 'CANCELLED' || previous.revision >= revision))
    throw new Error('Cancel the open batch before staging a higher revision.');
  const [row] = await db.$queryRaw<
    { id: string; state: string }[]
  >`INSERT INTO university_import_batches(organization_id,source_system,source_batch,revision,digest,evidence,manifest,controls,prepared_by)
    VALUES(${org},${source},${batchKey},${revision},${digest},${evidence},${JSON.stringify(manifest)}::jsonb,${JSON.stringify(manifest.controls)}::jsonb,${userId}) RETURNING id,state`;
  return { ...row, digest, controls: manifest.controls };
}

type Target = { student: Student; personId: string; personExists: boolean; linked: boolean };
async function preflight(ctx: UniversityContext, batch: Batch) {
  const { db, organizationId: org } = ctx;
  const manifest = reconcileHistoricalManifest(batch.manifest);
  const view = await requireImportAccess(ctx, manifest);
  await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('university-academics:' || ${org},0))`;
  const [usage] = await db.$queryRaw<
    { n: number }[]
  >`SELECT count(DISTINCT person_id)::int n FROM university_student_programs WHERE organization_id=${org} AND status='ACTIVE'`;
  const sectionLoads = manifest.students.flatMap((student) =>
    student.participation.map((section) => section.sectionId)
  );
  const [capacity] = await db.$queryRaw<{ overbooked: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM (SELECT value AS id, count(*) AS imported FROM jsonb_array_elements_text(${JSON.stringify(sectionLoads)}::jsonb) GROUP BY value) incoming
    JOIN university_sections s ON s.organization_id=${org} AND s.id=incoming.id
    WHERE incoming.imported + (SELECT count(*) FROM university_enrollments e WHERE e.organization_id=s.organization_id AND e.section_id=s.id AND e.status='ENROLLED') > s.capacity
  ) AS overbooked`;
  if (capacity.overbooked)
    throw new Error(
      'A historical section exceeds its configured capacity. Reconcile the source roster and section capacity.'
    );
  const balanceRefs = manifest.students.flatMap((student) =>
    student.openingBalance ? [student.openingBalance.reference] : []
  );
  if (balanceRefs.length) {
    const [collision] = await db.$queryRaw<
      { used: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM university_challans c JOIN jsonb_array_elements_text(${JSON.stringify(balanceRefs)}::jsonb) r ON c.reference=r.value WHERE c.organization_id=${org}) used`;
    if (collision.used)
      throw new Error('A source opening balance reference has already been posted.');
  }
  const targets: Target[] = [];
  let newActive = 0;
  for (const student of manifest.students) {
    const [link] = await db.$queryRaw<
      { person_id: string }[]
    >`SELECT person_id FROM university_import_person_links WHERE organization_id=${org} AND source_system=${batch.source_system} AND source_student_id=${student.legacyId}`;
    if (link && student.existingPersonId && student.existingPersonId !== link.person_id)
      throw new Error('Legacy identifier is already linked to another person.');
    const requested = link?.person_id ?? student.existingPersonId ?? null;
    const [person] = await db.$queryRaw<
      { id: string; email: string }[]
    >`SELECT id,email FROM university_people WHERE organization_id=${org} AND email=${student.email}`;
    if ((person && person.id !== requested) || (requested && person?.id !== requested))
      throw new Error('Resolve this person explicitly against a verified existing email.');
    const personId =
      requested ??
      'import-' +
        createHash('sha256')
          .update(JSON.stringify([org, batch.source_system, student.legacyId]))
          .digest('hex');
    const [checks] = await db.$queryRaw<
      { eligible: boolean; conflict: boolean; already_active: boolean; offered: number }[]
    >`SELECT
      EXISTS(SELECT 1 FROM university_intakes i JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id)
        WHERE i.organization_id=${org} AND i.id=${student.intakeId} AND i.status IN ('APPROVED','CLOSED') AND ${student.matriculatedOn}::date BETWEEN p.valid_from AND p.valid_to) eligible,
      EXISTS(SELECT 1 FROM university_applications WHERE organization_id=${org} AND person_id=${personId} AND intake_id=${student.intakeId}) conflict,
      EXISTS(SELECT 1 FROM university_student_programs WHERE organization_id=${org} AND person_id=${personId} AND status='ACTIVE') already_active,
      (SELECT count(*)::int FROM university_sections s JOIN jsonb_array_elements_text(${JSON.stringify(student.participation.map((x) => x.sectionId))}::jsonb) k ON k.value=s.id
         WHERE s.organization_id=${org} AND s.intake_id=${student.intakeId}) offered`;
    if (!checks.eligible || checks.conflict || checks.offered !== student.participation.length)
      throw new Error(
        'Check the historic intake, program validity, sections and existing admissions for ' +
          student.legacyId +
          '.'
      );
    if (student.status === 'ACTIVE' && !checks.already_active) newActive++;
    targets.push({ student, personId, personExists: !!person, linked: !!link });
  }
  if (newActive) {
    const limit = resolveEntitlementLimit(view.limits, {
      label: 'Active students',
      explicitKey: 'university.activeStudents.max',
      bootstrappedKey: 'university-core.university.activeStudents.max',
    });
    if (limit.status !== 'configured' || usage.n + newActive > limit.value)
      throw new Error('The historical cohort exceeds the licensed active-student allowance.');
  }
  return targets;
}

async function signAcademic(ctx: UniversityContext, input: Input) {
  requireRole(ctx, registrars);
  const batch = await openBatch(ctx, input);
  if (batch.state === 'VALIDATED' && batch.validated_by === ctx.userId)
    return { state: batch.state };
  if (batch.state !== 'STAGED' || batch.prepared_by === ctx.userId)
    throw new Error('An independent registrar must validate the staged source.');
  await preflight(ctx, batch);
  await ctx.db
    .$executeRaw`UPDATE university_import_batches SET state='VALIDATED',validated_by=${ctx.userId},validated_at=now() WHERE organization_id=${ctx.organizationId} AND id=${batch.id}`;
  return { state: 'VALIDATED', controls: batch.manifest.controls };
}
async function signFinance(ctx: UniversityContext, input: Input) {
  requireRole(ctx, approvers);
  const batch = await openBatch(ctx, input);
  if (
    batch.state !== 'VALIDATED' ||
    !batch.manifest.students.some((s) => s.openingBalance) ||
    [batch.prepared_by, batch.validated_by].includes(ctx.userId)
  )
    throw new Error('Validated balances require an independent finance signature.');
  if (batch.finance_signed_by === ctx.userId) return { signed: true };
  if (batch.finance_signed_by) throw new Error('Finance has already signed this source.');
  await requireImportAccess(ctx, batch.manifest);
  await ctx.db
    .$executeRaw`UPDATE university_import_batches SET finance_signed_by=${ctx.userId},finance_signed_at=now() WHERE organization_id=${ctx.organizationId} AND id=${batch.id}`;
  return { signed: true, controls: batch.manifest.controls };
}

async function publishTarget(ctx: UniversityContext, batch: Batch, target: Target) {
  const { organizationId: org, db } = ctx,
    { student, personId } = target;
  if (!target.personExists)
    await db.$executeRaw`INSERT INTO university_people(organization_id,id,email,full_name) VALUES(${org},${personId},${student.email},${student.fullName})`;
  if (!target.linked)
    await db.$executeRaw`INSERT INTO university_import_person_links(organization_id,source_system,source_student_id,person_id,first_batch_id) VALUES(${org},${batch.source_system},${student.legacyId},${personId},${batch.id})`;
  await db.$executeRaw`INSERT INTO university_applications(organization_id,person_id,intake_id,status,decision_reason,submitted_at) VALUES(${org},${personId},${student.intakeId},'MATRICULATED',${'Historical admission from import ' + batch.id},${student.matriculatedOn}::date)`;
  const [program] = await db.$queryRaw<
    { id: string }[]
  >`INSERT INTO university_student_programs(organization_id,person_id,intake_id,status,matriculated_at,ended_at)
    VALUES(${org},${personId},${student.intakeId},${student.status},${student.matriculatedOn}::date,${student.endedOn ?? null}::date) RETURNING id`;
  for (const record of student.participation) {
    const [enrollment] = await db.$queryRaw<
      { id: string }[]
    >`INSERT INTO university_enrollments(organization_id,person_id,section_id,status,queued_at) VALUES(${org},${personId},${record.sectionId},'ENROLLED',${record.recordedOn}::date) RETURNING id`;
    if (record.mark !== undefined)
      await db.$executeRaw`INSERT INTO university_grades(organization_id,enrollment_id,revision,mark,status,submitted_by,approved_by,published_at)
      VALUES(${org},${enrollment.id},1,${record.mark},'PUBLISHED',${batch.prepared_by},${batch.validated_by},${record.recordedOn}::date)`;
  }
  if (student.transcript) {
    const snapshot = {
      type: 'historic-issued-transcript',
      importBatch: batch.id,
      sourceDigest: batch.digest,
      ...student.transcript,
    };
    await db.$executeRaw`INSERT INTO university_transcripts(organization_id,student_program_id,snapshot,issued_at,issued_by)
      VALUES(${org},${program.id},${JSON.stringify(snapshot)}::jsonb,${student.transcript.issuedOn}::date,${batch.validated_by})`;
  }
  if (student.openingBalance)
    await importStudentOpeningBalance(ctx, {
      personId,
      reference: student.openingBalance.reference,
      balancePaisa: student.openingBalance.signedPaisa,
      asOf: student.openingBalance.asOf,
      evidence: batch.evidence,
    });
}

async function finalize(ctx: UniversityContext, input: Input) {
  requireRole(ctx, registrars);
  const batch = await openBatch(ctx, input);
  if (batch.state === 'FINALIZED') return { state: batch.state, controls: batch.manifest.controls };
  if (
    batch.state !== 'VALIDATED' ||
    !batch.validated_by ||
    (batch.manifest.students.some((s) => s.openingBalance) && !batch.finance_signed_by)
  )
    throw new Error(
      'Validate the academic source and sign any financial opening balances before cutover.'
    );
  // The office dispatcher owns this transaction. Failed publication rolls back every canonical insert.
  const targets = await preflight(ctx, batch);
  for (const target of targets) await publishTarget(ctx, batch, target);
  await ctx.db
    .$executeRaw`UPDATE university_import_batches SET state='FINALIZED',finalized_by=${ctx.userId},finalized_at=now() WHERE organization_id=${ctx.organizationId} AND id=${batch.id}`;
  await emitUniversityEvent(ctx, 'migration.finalized', batch.id, {
    digest: batch.digest,
    controls: batch.manifest.controls,
  });
  return { state: 'FINALIZED', controls: batch.manifest.controls };
}
async function cancel(ctx: UniversityContext, input: Input) {
  requireRole(ctx, registrars);
  const batch = await openBatch(ctx, input);
  if (batch.state === 'CANCELLED') return { state: 'CANCELLED' };
  if (batch.state === 'FINALIZED')
    throw new Error(
      'The cutover was finalized. Correct official records through their owning offices.'
    );
  const reason = reference.parse(input.reason);
  await ctx.db
    .$executeRaw`UPDATE university_import_batches SET state='CANCELLED',cancelled_by=${ctx.userId},cancelled_at=now(),cancellation_reason=${reason} WHERE organization_id=${ctx.organizationId} AND id=${batch.id}`;
  return { state: 'CANCELLED' };
}
const confirm = [
  { name: 'batchId', label: 'Batch ID', required: true },
  { name: 'digest', label: 'Source SHA-256 digest', required: true },
] as const;
export const importsOffice: UniversityOffice = {
  title: 'Historical cohort imports',
  description:
    'Reconcile source headcounts, historical academic records and opening balances before institutional cutover.',
  moduleKey: 'university-core',
  roles,
  read: (ctx) =>
    ctx.db
      .$queryRaw`SELECT id,source_system,source_batch,revision,state,digest,evidence,controls,prepared_by,validated_by,finance_signed_by,finalized_at,cancellation_reason FROM university_import_batches WHERE organization_id=${ctx.organizationId} ORDER BY created_at DESC LIMIT 100`,
  actions: [
    {
      key: 'specimen',
      label: 'View source manifest example',
      roles: registrars,
      fields: [],
      run: async () => ({
        format: 1,
        controls: {
          students: 1,
          activeStudents: 1,
          enrollments: 1,
          transcripts: 1,
          openingDebitPaisa: 10000,
          openingCreditPaisa: 0,
        },
        students: [
          {
            legacyId: 'S-100',
            email: 'student@example.edu.pk',
            fullName: 'Student name',
            intakeId: 'existing-intake-id',
            status: 'ACTIVE',
            matriculatedOn: '2024-08-01',
            participation: [
              { sectionId: 'existing-section-id', recordedOn: '2024-12-01', mark: 75 },
            ],
            transcript: {
              sourceReference: 'T-100',
              issuedOn: '2025-01-10',
              version: '1',
              documentSha256: '0'.repeat(64),
              snapshot: { term: 'Fall 2024', awardedCredits: 3 },
            },
            openingBalance: { reference: 'BAL-100', signedPaisa: 10000, asOf: '2025-01-01' },
          },
        ],
      }),
    },
    {
      key: 'stage',
      label: 'Stage source batch',
      roles: registrars,
      fields: [
        { name: 'sourceSystem', label: 'Source system', required: true },
        { name: 'sourceBatch', label: 'Source batch reference', required: true },
        { name: 'revision', label: 'Source revision', type: 'number', required: true },
        { name: 'evidence', label: 'Signed source report reference', required: true },
        { name: 'digest', label: 'SHA-256 of submitted JSON text', required: true },
        { name: 'manifest', label: 'Source manifest JSON', type: 'textarea', required: true },
      ],
      run: stage,
    },
    {
      key: 'validate',
      label: 'Sign academic reconciliation',
      roles: registrars,
      fields: confirm,
      run: signAcademic,
    },
    {
      key: 'finance',
      label: 'Sign opening balances',
      roles: approvers,
      fields: confirm,
      run: signFinance,
    },
    {
      key: 'finalize',
      label: 'Finalize cutover',
      roles: registrars,
      fields: confirm,
      run: finalize,
    },
    {
      key: 'cancel',
      label: 'Cancel pre-cutover revision',
      roles: registrars,
      fields: [...confirm, { name: 'reason', label: 'Correction reason', required: true }],
      run: cancel,
    },
  ],
};
