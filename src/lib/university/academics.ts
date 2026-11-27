import 'server-only';

import { TRPCError } from '@trpc/server';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { resolveEntitlementLimit } from '@/lib/entitlement-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { emitUniversityEvent } from './events';
import {
  checkRegistrationEligibility,
  readTransferCredits,
  checkConferralEligibility,
} from './academic-support';
import {
  officeRoleAllowed,
  type UniversityContext,
  type UniversityOffice,
  type UniversityField,
} from './office-types';

const registrar = ['university-registrar'];
const admissions = ['university-admissions-officer', ...registrar];
const examiners = ['university-examinations-officer', ...registrar];
const faculty = ['university-instructor', ...examiners];
type PersonContext = Pick<UniversityContext, 'db' | 'organizationId'>;
type Inputs = Record<string, string>;
type RecordRow = Record<string, unknown>;
type Outcome = { id: string; status: string };
type Section = {
  id: string;
  course: string;
  term: string;
  label: string;
  room: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
};
type Intake = {
  id: string;
  program: string;
  campus: string;
  label: string;
  closes_on: string;
  categories: { id: string; label: string }[];
};

function invalid(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}
function first<T>(rows: T[], message: string): T {
  return rows[0] ?? invalid(message);
}
function textValue(value: string | undefined, label: string, max = 300): string {
  const trimmed = value?.trim() || '';
  if (!trimmed || trimmed.length > max)
    invalid(`Enter a valid ${label} (up to ${max} characters).`);
  return trimmed;
}
function whole(value: string, label: string, min: number, max: number): number {
  const n = Number(value);
  if (!value?.trim() || !Number.isSafeInteger(n) || n < min || n > max)
    invalid(`Enter ${label} between ${min} and ${max}.`);
  return n;
}
function date(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    invalid('Enter a valid calendar date.');
  return value;
}
function requireOffice(ctx: UniversityContext, roles: string[]) {
  if (!officeRoleAllowed(ctx, roles))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This action requires the appropriate university office.',
    });
}

// These capacity, enrollment, and schedule decisions must see prior committed writes.
// An institution-level transaction lock also orders cross-section waitlist promotion.
async function lockAcademicWrites(db: ScopedDb, org: string) {
  await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('university-academics:' || ${org}, 0))`;
}
export async function listOpenIntakes(db: ScopedDb, organizationId: string): Promise<Intake[]> {
  return db.$queryRaw`SELECT i.id,p.name AS program,c.name AS campus,i.label,i.closes_on::text,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'label',q.label) ORDER BY q.label) FROM university_seat_categories q WHERE q.organization_id=i.organization_id AND q.intake_id=i.id),'[]'::jsonb) AS categories
    FROM university_intakes i JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id)
    JOIN university_campuses c ON (c.organization_id,c.id)=(p.organization_id,p.campus_id)
    JOIN organizations o ON o.id=i.organization_id
    WHERE i.organization_id=${organizationId} AND i.status='APPROVED'
    AND (now() AT TIME ZONE o.timezone)::date BETWEEN i.opens_on AND i.closes_on
    AND i.starts_on BETWEEN p.valid_from AND p.valid_to ORDER BY i.closes_on,p.name,c.name,i.id`;
}

export async function submitApplication(
  ctx: PersonContext,
  personId: string,
  intakeId: string,
  qualification?: string,
  equivalenceReference?: string,
  categoryId?: string
): Promise<Outcome> {
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const existing = await db.$queryRaw<
    Outcome[]
  >`SELECT id,status FROM university_applications WHERE organization_id=${org} AND person_id=${personId} AND intake_id=${intakeId}`;
  if (existing[0]) return existing[0];
  const openIntake = (await listOpenIntakes(db, org)).find((intake) => intake.id === intakeId);
  if (categoryId && !openIntake?.categories.some((q) => q.id === categoryId))
    invalid('Select a category offered by this intake.');
  if (!openIntake) invalid('This intake is closed to applications.');
  const supplied = qualification ? textValue(qualification, 'qualification', 1200) : null;
  const reference = equivalenceReference
    ? textValue(equivalenceReference, 'equivalence reference')
    : null;
  return first(
    await db.$queryRaw<
      Outcome[]
    >`INSERT INTO university_applications(organization_id,person_id,intake_id,qualification,equivalence_reference,category_id)
    VALUES (${org},${personId},${intakeId},${supplied},${reference},${categoryId || null}) RETURNING id,status`,
    'Application could not be created.'
  );
}
export async function acceptStudentOffer(
  ctx: PersonContext,
  personId: string,
  applicationId: string
): Promise<Outcome> {
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const app = first(
    await db.$queryRaw<
      Outcome[]
    >`SELECT id,status FROM university_applications WHERE organization_id=${org} AND id=${applicationId} AND person_id=${personId}`,
    'Offer unavailable.'
  );
  if (['ACCEPTED', 'MATRICULATED'].includes(app.status)) return app;
  if (app.status !== 'OFFERED') invalid('Only an offered place can be accepted.');
  return first(
    await db.$queryRaw<
      Outcome[]
    >`UPDATE university_applications SET status='ACCEPTED' WHERE organization_id=${org} AND id=${applicationId} RETURNING id,status`,
    'Offer unavailable.'
  );
}
function percentage(value: string, label: string) {
  if (!value?.trim() || !/^\d{1,3}(\.\d{1,3})?$/.test(value.trim()) || Number(value) > 100)
    invalid(`Enter ${label} as a percentage from 0 to 100.`);
  return Number(value);
}
export function weightedMerit(school: number, entrance: number | null, schoolWeight: number) {
  if (schoolWeight < 100 && entrance === null)
    invalid('An entry examination result is required by the cohort merit formula.');
  return Math.round((school * schoolWeight + (entrance ?? 0) * (100 - schoolWeight)) * 10) / 1000;
}
async function publishMeritList(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, admissions);
  await lockAcademicWrites(ctx.db, ctx.organizationId);
  return first(
    await ctx.db.$queryRaw<
      { id: string; version: number }[]
    >`INSERT INTO university_merit_lists(organization_id,intake_id,version,formula_version,school_weight,candidates,published_by)
    SELECT i.organization_id,i.id,COALESCE((SELECT max(l.version)+1 FROM university_merit_lists l WHERE l.organization_id=i.organization_id AND l.intake_id=i.id),1),i.merit_version,i.school_weight,
    (SELECT jsonb_agg(jsonb_build_object('applicationId',a.id,'score',a.merit_score,'school',a.school_percent,'entry',a.entry_test_percent,'categoryId',a.category_id,'submittedAt',a.submitted_at,'assessedAt',a.assessed_at) ORDER BY a.merit_score DESC,a.submitted_at,a.id)
      FROM university_applications a WHERE a.organization_id=i.organization_id AND a.intake_id=i.id AND a.status IN ('ASSESSED','OFFERED','ACCEPTED','MATRICULATED')),
    ${ctx.userId} FROM university_intakes i WHERE i.organization_id=${ctx.organizationId} AND i.id=${input.intakeId} AND EXISTS(SELECT 1 FROM university_applications a
      WHERE a.organization_id=i.organization_id AND a.intake_id=i.id AND a.status='ASSESSED') RETURNING id,version`,
    'Assess at least one applicant before publishing the merit list.'
  );
}
async function assessApplicant(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, admissions);
  const { db, organizationId: org } = ctx;
  const school = percentage(input.score, 'qualification result');
  const entrance = input.entryScore?.trim()
    ? percentage(input.entryScore, 'entry examination result')
    : null;
  const qualification = textValue(input.qualification, 'reviewed qualification', 1200);
  const ref = input.equivalenceReference?.trim() || null;
  await lockAcademicWrites(db, org);
  const [intake] = await db.$queryRaw<
    { school_weight: number }[]
  >`SELECT i.school_weight FROM university_intakes i JOIN university_applications a ON (a.organization_id,a.intake_id)=(i.organization_id,i.id) WHERE a.organization_id=${org} AND a.id=${input.applicationId}`;
  if (!intake) invalid('Select an application awaiting a decision.');
  const merit = weightedMerit(school, entrance, intake.school_weight);
  return first(
    await db.$queryRaw<
      Outcome[]
    >`UPDATE university_applications SET status='ASSESSED',decision_by=${ctx.userId},assessed_at=clock_timestamp(),school_percent=${school},entry_test_percent=${entrance},merit_score=${merit},qualification=${qualification},
    equivalence_reference=COALESCE(${ref},equivalence_reference) WHERE organization_id=${org} AND id=${input.applicationId}
    AND status IN ('SUBMITTED','ASSESSED') RETURNING id,status`,
    'Select an application awaiting a decision.'
  );
}
async function offerNext(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, admissions);
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const offer = first(
    await db.$queryRaw<
      (Outcome & { offered_list_id: string; offered_rank: number })[]
    >`WITH next_candidate AS (
    SELECT a.id,list.id AS list_id,ranked.rank::int AS rank FROM university_applications a JOIN university_intakes i ON (i.organization_id,i.id)=(a.organization_id,a.intake_id)
    JOIN LATERAL (SELECT l.id,l.candidates FROM university_merit_lists l WHERE l.organization_id=i.organization_id AND l.intake_id=i.id ORDER BY version DESC LIMIT 1) list ON true
    JOIN LATERAL jsonb_array_elements(list.candidates) WITH ORDINALITY ranked(entry,rank) ON ranked.entry->>'applicationId'=a.id AND (ranked.entry->>'score')::numeric=a.merit_score
      AND (ranked.entry->>'assessedAt')::timestamptz=a.assessed_at
    LEFT JOIN university_seat_categories q ON (q.organization_id,q.id)=(a.organization_id,a.category_id)
    WHERE a.organization_id=${org} AND a.intake_id=${input.intakeId} AND a.category_id IS NOT DISTINCT FROM ${input.categoryId || null}::text
    AND a.status='ASSESSED' AND i.status IN ('APPROVED','CLOSED')
    AND NOT EXISTS (SELECT 1 FROM university_admission_appeals pending WHERE pending.organization_id=a.organization_id AND pending.application_id=a.id AND pending.status='OPEN')
    AND (SELECT count(*) FROM university_applications b WHERE b.organization_id=a.organization_id AND b.intake_id=a.intake_id AND b.category_id IS NOT DISTINCT FROM a.category_id AND b.status IN ('OFFERED','ACCEPTED','MATRICULATED')) <
      COALESCE(q.capacity,i.capacity-(SELECT COALESCE(sum(capacity),0) FROM university_seat_categories k WHERE k.organization_id=i.organization_id AND k.intake_id=i.id))
    ORDER BY ranked.rank LIMIT 1)
    UPDATE university_applications a SET status='OFFERED',offered_list_id=n.list_id,offered_rank=n.rank FROM next_candidate n WHERE a.organization_id=${org} AND a.id=n.id RETURNING a.id,a.status,a.offered_list_id,a.offered_rank`,
    'Publish an up-to-date merit list and verify an intake place is available.'
  );
  await emitUniversityEvent(ctx, 'admission.offered', offer.id, {
    applicationId: offer.id,
    meritListId: offer.offered_list_id,
    rank: offer.offered_rank,
    categoryId: input.categoryId || null,
    intakeId: input.intakeId,
  });
  return offer;
}

async function matriculate(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const app = first(
    await db.$queryRaw<
      (Outcome & { person_id: string; intake_id: string })[]
    >`SELECT id,status,person_id,intake_id FROM university_applications WHERE organization_id=${org} AND id=${input.applicationId}`,
    'Application unavailable.'
  );
  if (app.status === 'MATRICULATED')
    return first(
      await db.$queryRaw<
        Outcome[]
      >`SELECT id,status FROM university_student_programs WHERE organization_id=${org} AND person_id=${app.person_id} AND intake_id=${app.intake_id}`,
      'Student record unavailable.'
    );
  if (app.status !== 'ACCEPTED')
    invalid('The applicant must accept the offer before matriculation.');
  const usage = first(
    await db.$queryRaw<
      { active: number; already_active: boolean }[]
    >`SELECT count(DISTINCT person_id)::int AS active,
    COALESCE(bool_or(person_id=${app.person_id}),false) AS already_active FROM university_student_programs WHERE organization_id=${org} AND status='ACTIVE'`,
    'Student usage unavailable.'
  );
  if (!usage.already_active) {
    const view = ctx.entitlements ?? (await resolveOrganizationEntitlements(org, db));
    const limit = resolveEntitlementLimit(view.limits, {
      label: 'Active students',
      explicitKey: 'university.activeStudents.max',
      bootstrappedKey: 'university-core.university.activeStudents.max',
    });
    if (limit.status !== 'configured' || usage.active >= limit.value)
      invalid('The active-student allowance is unavailable or full.');
  }
  const result = first(
    await db.$queryRaw<
      Outcome[]
    >`INSERT INTO university_student_programs(organization_id,person_id,intake_id) VALUES(${org},${app.person_id},${app.intake_id}) RETURNING id,status`,
    'Student record could not be created.'
  );
  await db.$executeRaw`UPDATE university_applications SET status='MATRICULATED' WHERE organization_id=${org} AND id=${app.id}`;
  const fees = first(
    await db.$queryRaw<
      { tuition: number; starts: string }[]
    >`SELECT tuition_paisa::float8 AS tuition,starts_on::text AS starts FROM university_intakes WHERE organization_id=${org} AND id=${app.intake_id}`,
    'Intake unavailable.'
  );
  if (fees.tuition > 0) {
    if (
      !hasModule(
        ctx.entitlements ?? (await resolveOrganizationEntitlements(org, db)),
        'university-finance'
      )
    )
      invalid(
        'Enable university finance before matriculating into an intake with assessed tuition.'
      );
    const { issueStudentCharge } = await import('./finance');
    await issueStudentCharge(ctx, {
      personId: app.person_id,
      reference: `MATR-${result.id}`,
      feeHead: 'TUITION',
      amountPaisa: fees.tuition,
      commencementDate: fees.starts,
      dueDate: fees.starts,
    });
  }
  await emitUniversityEvent(ctx, 'student.matriculated', result.id, {
    personId: app.person_id,
    intakeId: app.intake_id,
    studentProgramId: result.id,
  });
  return result;
}

export async function appealAdmissionDecision(
  ctx: PersonContext,
  personId: string,
  applicationId: string,
  reason: string
): Promise<Outcome> {
  await lockAcademicWrites(ctx.db, ctx.organizationId);
  return first(
    await ctx.db.$queryRaw<
      Outcome[]
    >`INSERT INTO university_admission_appeals(organization_id,application_id,reason)
    SELECT organization_id,id,${textValue(reason, 'appeal reason', 1200)} FROM university_applications WHERE organization_id=${ctx.organizationId} AND id=${applicationId} AND person_id=${personId} AND status IN ('ASSESSED','REJECTED')
    ON CONFLICT (organization_id,application_id) WHERE status='OPEN' DO UPDATE SET reason=university_admission_appeals.reason RETURNING id,status`,
    'Select an assessed or rejected application in your record.'
  );
}
async function resolveAdmissionAppeal(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  await lockAcademicWrites(ctx.db, ctx.organizationId);
  if (!['Uphold', 'Reopen'].includes(input.outcome)) invalid('Choose an appeal decision.');
  const state = input.outcome === 'Uphold' ? 'UPHELD' : 'REOPENED';
  const result = first(
    await ctx.db.$queryRaw<
      (Outcome & { application_id: string })[]
    >`UPDATE university_admission_appeals ap SET status=${state},decision=${textValue(input.reason, 'appeal decision', 1200)},decided_by=${ctx.userId}
    FROM university_applications a WHERE ap.organization_id=${ctx.organizationId} AND ap.id=${input.appealId} AND ap.status='OPEN' AND (a.organization_id,a.id)=(ap.organization_id,ap.application_id)
    AND a.decision_by IS DISTINCT FROM ${ctx.userId} RETURNING ap.id,ap.status,ap.application_id`,
    'A distinct registrar must decide the open admissions appeal.'
  );
  if (state === 'REOPENED')
    await ctx.db
      .$executeRaw`UPDATE university_applications SET status='SUBMITTED',merit_score=NULL,assessed_at=NULL,decision_by=NULL,decision_reason=NULL WHERE organization_id=${ctx.organizationId} AND id=${result.application_id}`;
  return result;
}
async function createSeatCategory(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  await lockAcademicWrites(ctx.db, ctx.organizationId);
  const places = whole(input.capacity, 'category places', 1, 100000);
  return first(
    await ctx.db.$queryRaw<
      RecordRow[]
    >`INSERT INTO university_seat_categories(organization_id,intake_id,label,capacity)
    SELECT organization_id,id,${textValue(input.label, 'category label')},${places} FROM university_intakes i WHERE organization_id=${ctx.organizationId} AND id=${input.intakeId} AND status='DRAFT'
    AND i.capacity>=${places}+(SELECT COALESCE(sum(capacity),0) FROM university_seat_categories q WHERE q.organization_id=i.organization_id AND q.intake_id=i.id) RETURNING id,label,capacity`,
    'Reserve available places before approving the intake.'
  );
}
async function createCampus(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  return first(
    await ctx.db.$queryRaw<
      RecordRow[]
    >`INSERT INTO university_campuses(organization_id,name,recognition_ref) VALUES(${ctx.organizationId},${textValue(input.name, 'campus name')},${textValue(input.recognition, 'campus recognition evidence')}) RETURNING id,name`,
    'Campus could not be created.'
  );
}
async function createProgram(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  const from = date(input.validFrom),
    to = date(input.validTo);
  if (to < from) invalid('The approval end date must follow the start date.');
  return first(
    await ctx.db.$queryRaw<
      RecordRow[]
    >`INSERT INTO university_programs(organization_id,campus_id,name,code,pqr_reference,accreditation_reference,valid_from,valid_to) VALUES(
    ${ctx.organizationId},${input.campusId},${textValue(input.name, 'program name')},${textValue(input.code, 'program code')},${textValue(input.pqr, 'PQR reference')},
    ${textValue(input.accreditation, 'accreditation evidence or recorded exemption')},${from}::date,${to}::date) RETURNING id,code,name`,
    'Program could not be created.'
  );
}
type GradeBand = [minimumMark: number, points: number];
const defaultGradeScale: GradeBand[] = [
  [85, 4],
  [80, 3.7],
  [75, 3.3],
  [70, 3],
  [65, 2.7],
  [60, 2.3],
  [55, 2],
  [50, 1],
  [0, 0],
];
function gradeBands(raw: string | undefined): GradeBand[] {
  if (!raw?.trim()) return defaultGradeScale;
  const bands = raw
    .split(',')
    .map((part) => {
      const [threshold, points, ...remainder] = part.trim().split('=');
      if (!threshold?.trim() || !points?.trim() || remainder.length)
        invalid('Use grade bands in minimum-mark=points format.');
      const mark = whole(threshold, 'grade band minimum mark', 0, 100),
        value = Number(points);
      if (!Number.isFinite(value) || value < 0 || value > 4)
        invalid('Use grade points between 0 and 4.');
      return [mark, value] as GradeBand;
    })
    .sort((a, b) => b[0] - a[0]);
  if (
    bands.length < 2 ||
    bands.length > 25 ||
    bands.at(-1)?.[0] !== 0 ||
    bands.some((band, i) => i > 0 && (band[0] === bands[i - 1][0] || band[1] > bands[i - 1][1]))
  )
    invalid('Specify distinct, ordered grade bands covering a mark of zero.');
  return bands;
}
export function gradePointAverages(rows: CourseResult[], scale: GradeBand[], passMark = 0) {
  const terms = new Map<string, { credits: number; weighted: number }>();
  const best = new Map<string, { credits: number; points: number }>();
  for (const row of rows) {
    if (row.mark === null || !row.term) continue;
    const mark = row.mark;
    const points = mark < passMark ? 0 : (scale.find(([minimum]) => mark >= minimum)?.[1] ?? 0);
    const term = terms.get(row.term) ?? { credits: 0, weighted: 0 };
    term.credits += row.credits;
    term.weighted += row.credits * points;
    terms.set(row.term, term);
    const prior = best.get(row.course_id);
    if (!prior || prior.points < points) best.set(row.course_id, { credits: row.credits, points });
  }
  const rounded = (weighted: number, credits: number) =>
    credits ? Math.round((weighted * 100) / credits) / 100 : null;
  const attempted = [...best.values()].reduce((a, item) => a + item.credits, 0);
  const weighted = [...best.values()].reduce((a, item) => a + item.credits * item.points, 0);
  return {
    cgpa: rounded(weighted, attempted),
    term_gpas: [...terms]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([term, item]) => ({
        term,
        gpa: rounded(item.weighted, item.credits),
        credits: item.credits,
      })),
    cumulativeCredits: attempted,
    repeatPolicy: 'Highest institutional grade points per course',
    transferPolicy: 'Transferred courses satisfy mapped credits and are excluded from GPA',
  };
}
async function createIntake(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  const scale = gradeBands(input.gradeScale),
    minimumGpa = Number(input.minimumGpa || '0');
  if (!Number.isFinite(minimumGpa) || minimumGpa < 0 || minimumGpa > 4)
    invalid('Minimum cumulative GPA must be between 0 and 4.');
  const from = date(input.opens),
    to = date(input.closes),
    start = date(input.starts);
  if (from > to || to > start)
    invalid('Application opening, closing, and commencement must be in chronological order.');
  return first(
    await ctx.db.$queryRaw<
      Outcome[]
    >`INSERT INTO university_intakes(organization_id,program_id,label,curriculum_version,required_credits,pass_mark,capacity,opens_on,closes_on,starts_on,research_required,tuition_paisa,merit_version,school_weight,grade_scale,minimum_cgpa)
    VALUES(${ctx.organizationId},${input.programId},${textValue(input.label, 'cohort label')},${textValue(input.version, 'curriculum version')},
    ${whole(input.credits, 'degree credits', 1, 2000)},${whole(input.passMark, 'pass mark', 1, 100)},${whole(input.capacity, 'capacity', 1, 100000)},${from}::date,${to}::date,${start}::date,${input.track === 'Research'},${whole(input.tuitionPaisa || '0', 'tuition in paisa', 0, 999999999999)},${textValue(input.meritVersion || '1', 'merit formula version')},${whole(input.schoolWeight || '100', 'qualification weight', 0, 100)},${JSON.stringify(scale)}::jsonb,${minimumGpa}) RETURNING id,status`,
    'Intake could not be created.'
  );
}
async function addCourse(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  await lockAcademicWrites(ctx.db, ctx.organizationId);
  return first(
    await ctx.db.$queryRaw<
      RecordRow[]
    >`INSERT INTO university_courses(organization_id,intake_id,code,name,credits,required)
    SELECT organization_id,id,${textValue(input.code, 'course code')},${textValue(input.name, 'course title')},${whole(input.credits, 'course credits', 1, 100)},${input.requirement === 'Required'}
    FROM university_intakes WHERE organization_id=${ctx.organizationId} AND id=${input.intakeId} AND status='DRAFT' RETURNING id,code,name`,
    'Courses can be added to a draft curriculum.'
  );
}
async function approveIntake(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  await lockAcademicWrites(ctx.db, ctx.organizationId);
  return first(
    await ctx.db.$queryRaw<
      Outcome[]
    >`UPDATE university_intakes i SET status='APPROVED',approved_by=${ctx.userId} FROM university_programs p
    WHERE i.organization_id=${ctx.organizationId} AND i.id=${input.intakeId} AND i.status='DRAFT' AND (p.organization_id,p.id)=(i.organization_id,i.program_id)
    AND i.starts_on BETWEEN p.valid_from AND p.valid_to AND (SELECT COALESCE(sum(credits),0) FROM university_courses c WHERE c.organization_id=i.organization_id AND c.intake_id=i.id)>=i.required_credits
    RETURNING i.id,i.status`,
    'Approval requires valid recognition on commencement and enough curriculum credits.'
  );
}
async function createSection(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  const { db, organizationId: org } = ctx;
  const day = whole(input.weekday, 'weekday', 1, 7),
    start = whole(input.startMinute, 'start minute', 0, 1439),
    end = whole(input.endMinute, 'end minute', 1, 1440);
  if (end <= start) invalid('Class end must follow its start.');
  const term = textValue(input.term, 'academic term'),
    room = textValue(input.room, 'room'),
    courseId = input.courseId;
  await lockAcademicWrites(db, org);
  return first(
    await db.$queryRaw<
      RecordRow[]
    >`INSERT INTO university_sections(organization_id,intake_id,course_id,instructor_id,term,label,room,weekday,start_minute,end_minute,capacity)
    SELECT c.organization_id,c.intake_id,c.id,u.id,${term},${textValue(input.label, 'section label')},${room},${day},${start},${end},${whole(input.capacity, 'capacity', 1, 10000)}
    FROM university_courses c JOIN university_intakes i ON (i.organization_id,i.id)=(c.organization_id,c.intake_id)
    JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id)
    JOIN users u ON u."organizationId"=c.organization_id AND u.id=${input.instructorId} AND u.status='ACTIVE'
    JOIN organization_roles r ON r."organizationId"=u."organizationId" AND r.id=u."organizationRoleId" AND r.key='university-instructor'
    WHERE c.organization_id=${org} AND c.id=${courseId} AND i.status IN ('APPROVED','CLOSED') AND NOT EXISTS (
      SELECT 1 FROM university_sections s JOIN university_intakes si ON (si.organization_id,si.id)=(s.organization_id,s.intake_id)
      JOIN university_programs sp ON (sp.organization_id,sp.id)=(si.organization_id,si.program_id)
      WHERE s.organization_id=c.organization_id AND s.term=${term} AND s.weekday=${day} AND s.start_minute<${end} AND s.end_minute>${start}
      AND (s.instructor_id=u.id OR (s.room=${room} AND sp.campus_id=p.campus_id))) RETURNING id,label,term`,
    'Check the approved course, active instructor assignment, room availability and timetable.'
  );
}

async function mayTakeSection(
  db: ScopedDb,
  org: string,
  personId: string,
  sectionId: string
): Promise<boolean> {
  const [eligible] = await db.$queryRaw<
    { program_id: string | null; course_id: string }[]
  >`SELECT university_conflict_free_program(${org},${personId},s) AS program_id,s.course_id FROM university_sections s WHERE s.organization_id=${org} AND s.id=${sectionId}`;
  return eligible?.program_id
    ? checkRegistrationEligibility(db, org, personId, sectionId, {
        programId: eligible.program_id,
        courseId: eligible.course_id,
      })
    : false;
}
type Seat = Outcome & { person_id: string; section_id: string; revision: number };
async function enrollmentEvent(ctx: PersonContext, row: Seat, kind: string) {
  await emitUniversityEvent(ctx, kind, `${row.id}:${row.revision}`, {
    personId: row.person_id,
    sectionId: row.section_id,
    enrollmentId: row.id,
    status: row.status,
  });
}
// The section lock protects seat counts. Every affected person is locked in ID order
// before testing timetable/degree eligibility, including people who might be promoted.
async function lockSectionAndPeople(
  db: ScopedDb,
  org: string,
  personId: string,
  sectionId: string,
  releasingSeat: boolean
) {
  return first(
    await db.$queryRaw<
      {
        existing_id: string | null;
        existing_status: string | null;
        student_program_id: string | null;
        course_id: string;
        has_queue: boolean;
      }[]
    >`SELECT * FROM university_registration_context(${org},${personId},${sectionId},${releasingSeat})`,
    'Section unavailable.'
  );
}
async function promoteWaitlist(ctx: PersonContext, sectionId: string) {
  const { db, organizationId: org } = ctx;
  const [capacity] = await db.$queryRaw<
    { free: number }[]
  >`SELECT (s.capacity-count(e.id))::int AS free FROM university_sections s LEFT JOIN university_enrollments e
    ON e.organization_id=s.organization_id AND e.section_id=s.id AND e.status='ENROLLED' WHERE s.organization_id=${org} AND s.id=${sectionId} GROUP BY s.capacity`;
  if (!capacity || capacity.free <= 0) return;
  let free = capacity.free;
  const queue = await db.$queryRaw<
    { id: string; person_id: string }[]
  >`SELECT id,person_id FROM university_enrollments WHERE organization_id=${org} AND section_id=${sectionId} AND status='WAITLISTED' ORDER BY queued_at,id`;
  for (const candidate of queue) {
    if (!free) break;
    if (!(await mayTakeSection(db, org, candidate.person_id, sectionId))) continue;
    const row = first(
      await db.$queryRaw<
        Seat[]
      >`UPDATE university_enrollments SET status='ENROLLED',revision=revision+1 WHERE organization_id=${org} AND id=${candidate.id} RETURNING id,status,person_id,section_id,revision`,
      'Waitlist entry unavailable.'
    );
    await enrollmentEvent(ctx, row, 'student.registered');
    free--;
  }
}
/** Holds and leave can affect several sections. The exclusive barrier orders this cross-section change. */
export async function refreshAcademicWaitlists(ctx: PersonContext, personId: string) {
  await lockAcademicWrites(ctx.db, ctx.organizationId);
  const waiting = await ctx.db.$queryRaw<
    { section_id: string }[]
  >`SELECT section_id FROM university_enrollments WHERE organization_id=${ctx.organizationId} AND person_id=${personId} AND status='WAITLISTED' ORDER BY section_id`;
  for (const { section_id } of waiting) {
    const state = await lockSectionAndPeople(
      ctx.db,
      ctx.organizationId,
      personId,
      section_id,
      false
    );
    if (state.has_queue) await promoteWaitlist(ctx, section_id);
  }
}
export async function registerStudent(
  ctx: PersonContext,
  personId: string,
  sectionId: string
): Promise<Outcome> {
  const { db, organizationId: org } = ctx;
  const result = first(
    await db.$queryRaw<
      {
        enrollment_id: string | null;
        enrollment_status: string | null;
        review_required: boolean;
        has_queue: boolean;
        program_id: string | null;
        target_course: string;
      }[]
    >`SELECT * FROM university_try_registration(${org},${personId},${sectionId})`,
    'Section unavailable.'
  );
  if (!result.review_required) {
    if (result.enrollment_status === 'ON_HOLD')
      invalid('Resolve the registration hold before adding this section.');
    if (result.enrollment_status === 'ON_LEAVE')
      invalid('Record a return from leave before registering for this section.');
    if (
      !result.enrollment_id ||
      !result.enrollment_status ||
      result.enrollment_status === 'INELIGIBLE'
    )
      invalid(
        'Registration requires an active program, satisfied prerequisites, resolved holds and a conflict-free timetable.'
      );
    return { id: result.enrollment_id, status: result.enrollment_status };
  }
  if (result.enrollment_status === 'WAITLISTED') {
    await promoteWaitlist(ctx, sectionId);
    return first(
      await db.$queryRaw<
        Outcome[]
      >`SELECT id,status FROM university_enrollments WHERE organization_id=${org} AND id=${result.enrollment_id}`,
      'Enrollment unavailable.'
    );
  }
  if (
    !result.program_id ||
    !(await checkRegistrationEligibility(db, org, personId, sectionId, {
      programId: result.program_id,
      courseId: result.target_course,
    }))
  )
    invalid(
      'Registration requires an active program, satisfied prerequisites, resolved holds and a conflict-free timetable.'
    );
  if (result.has_queue) await promoteWaitlist(ctx, sectionId);
  return first(
    await db.$queryRaw<
      Outcome[]
    >`SELECT enrollment_id AS id,enrollment_status AS status FROM university_store_registration(${org},${personId},${sectionId})`,
    'Section unavailable.'
  );
}
export async function withdrawStudent(
  ctx: PersonContext,
  personId: string,
  sectionId: string
): Promise<Outcome> {
  const { db, organizationId: org } = ctx;
  const state = await lockSectionAndPeople(db, org, personId, sectionId, true);
  if (!state.existing_id || !state.existing_status) invalid('Enrollment unavailable.');
  const current = { id: state.existing_id, status: state.existing_status };
  if (current.status === 'WITHDRAWN') return current;
  const row = first(
    await db.$queryRaw<
      Seat[]
    >`UPDATE university_enrollments e SET status='WITHDRAWN',revision=revision+1 WHERE organization_id=${org} AND id=${current.id}
    AND NOT EXISTS (SELECT 1 FROM university_grades g WHERE g.organization_id=e.organization_id AND g.enrollment_id=e.id) RETURNING id,status,person_id,section_id,revision`,
    'A section with an assessment already recorded requires an academic review.'
  );
  await enrollmentEvent(
    ctx,
    row,
    current.status === 'ENROLLED' ? 'student.withdrawn' : 'student.waitlist.cancelled'
  );
  if (state.has_queue) await promoteWaitlist(ctx, sectionId);
  return { id: row.id, status: row.status };
}
async function withdrawProgram(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  const { db, organizationId: org } = ctx;
  const reason = textValue(input.reason, 'withdrawal reason', 1200);
  await lockAcademicWrites(db, org);
  const program = first(
    await db.$queryRaw<
      (Outcome & { person_id: string; intake_id: string })[]
    >`SELECT id,status,person_id,intake_id FROM university_student_programs WHERE organization_id=${org} AND id=${input.studentProgramId}`,
    'Student program unavailable.'
  );
  if (program.status === 'WITHDRAWN') return { id: program.id, status: program.status };
  if (program.status !== 'ACTIVE') invalid('Only an active student program can be withdrawn.');
  const [draft] = await db.$queryRaw<
    { id: string }[]
  >`SELECT g.id FROM university_grades g JOIN university_enrollments e ON (e.organization_id,e.id)=(g.organization_id,g.enrollment_id)
    JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id)
    WHERE g.organization_id=${org} AND e.person_id=${program.person_id} AND s.intake_id=${program.intake_id} AND g.status='DRAFT' LIMIT 1`;
  if (draft) invalid('Resolve pending assessments before withdrawing the program.');
  const result = first(
    await db.$queryRaw<
      Outcome[]
    >`UPDATE university_student_programs SET status='WITHDRAWN',ended_at=now() WHERE organization_id=${org} AND id=${program.id} RETURNING id,status`,
    'Program unavailable.'
  );
  const sections = await db.$queryRaw<
    { id: string }[]
  >`SELECT s.id FROM university_sections s JOIN university_enrollments e ON e.organization_id=s.organization_id AND e.section_id=s.id
    WHERE s.organization_id=${org} AND s.intake_id=${program.intake_id} AND e.person_id=${program.person_id} AND e.status IN ('ENROLLED','WAITLISTED')
    AND NOT EXISTS(SELECT 1 FROM university_grades g WHERE g.organization_id=e.organization_id AND g.enrollment_id=e.id)`;
  for (const section of sections) await withdrawStudent(ctx, program.person_id, section.id);
  const { releaseUniversityServicesOnWithdrawal } = await import('./services');
  if (
    hasModule(
      ctx.entitlements ?? (await resolveOrganizationEntitlements(org, db)),
      'university-services'
    )
  )
    await releaseUniversityServicesOnWithdrawal(ctx, program.person_id);
  await emitUniversityEvent(ctx, 'student.program.withdrawn', program.id, {
    personId: program.person_id,
    studentProgramId: program.id,
    intakeId: program.intake_id,
    reason,
  });
  return result;
}

async function submitGrade(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, faculty);
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const mark = whole(input.mark, 'mark', 0, 100);
  const broad = ctx.admin || ctx.roleKey === 'university-admin' || examiners.includes(ctx.roleKey);
  return first(
    await db.$queryRaw<
      Outcome[]
    >`INSERT INTO university_grades(organization_id,enrollment_id,revision,mark,submitted_by)
    SELECT e.organization_id,e.id,1,${mark},${ctx.userId} FROM university_enrollments e JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id)
    WHERE e.organization_id=${org} AND e.id=${input.enrollmentId} AND e.status='ENROLLED' AND (${broad} OR s.instructor_id=${ctx.userId})
    ON CONFLICT (organization_id,enrollment_id,revision) DO UPDATE SET mark=EXCLUDED.mark,submitted_by=EXCLUDED.submitted_by WHERE university_grades.status='DRAFT'
    RETURNING id,status`,
    'Select an enrolled student from an assigned section with no published grade.'
  );
}
async function publishGrade(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, examiners);
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const grade = first(
    await db.$queryRaw<
      (Outcome & { enrollment_id: string; revision: number })[]
    >`UPDATE university_grades SET status='PUBLISHED',approved_by=${ctx.userId},published_at=now()
    WHERE organization_id=${org} AND id=${input.gradeId} AND status='DRAFT' AND submitted_by<>${ctx.userId} RETURNING id,status,enrollment_id,revision`,
    'A distinct authorized reviewer must publish a draft grade.'
  );
  if (grade.revision > 1)
    await db.$executeRaw`UPDATE university_grade_appeals a SET status='AMENDED' FROM university_grades g WHERE a.organization_id=${org}
    AND g.organization_id=a.organization_id AND g.id=a.grade_id AND g.enrollment_id=${grade.enrollment_id} AND g.revision=${grade.revision - 1} AND a.status='PENDING_AMENDMENT'`;
  const student = first(
    await db.$queryRaw<
      { person_id: string; section_id: string }[]
    >`SELECT person_id,section_id FROM university_enrollments WHERE organization_id=${org} AND id=${grade.enrollment_id}`,
    'Student unavailable.'
  );
  await emitUniversityEvent(ctx, 'grade.published', grade.id, {
    gradeId: grade.id,
    enrollmentId: grade.enrollment_id,
    personId: student.person_id,
    sectionId: student.section_id,
  });
  await refreshAcademicWaitlists(ctx, student.person_id);
  return { id: grade.id, status: grade.status };
}
export async function appealGrade(
  ctx: PersonContext,
  personId: string,
  enrollmentId: string,
  reason: string
): Promise<Outcome> {
  const { db, organizationId: org } = ctx;
  const complaint = textValue(reason, 'appeal reason', 1200);
  await lockAcademicWrites(db, org);
  return first(
    await db.$queryRaw<
      Outcome[]
    >`INSERT INTO university_grade_appeals(organization_id,grade_id,reason)
    SELECT g.organization_id,g.id,${complaint} FROM university_grades g JOIN university_enrollments e ON (e.organization_id,e.id)=(g.organization_id,g.enrollment_id)
    WHERE g.organization_id=${org} AND g.enrollment_id=${enrollmentId} AND e.person_id=${personId} AND g.status='PUBLISHED'
    ORDER BY g.revision DESC LIMIT 1 ON CONFLICT (organization_id,grade_id) DO UPDATE SET reason=university_grade_appeals.reason RETURNING id,status`,
    'A published grade in your record is required.'
  );
}
async function resolveAppeal(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, examiners);
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const decision = textValue(input.reason, 'decision reason', 1200);
  const amend = input.outcome === 'Amend';
  if (!amend && input.outcome !== 'Uphold') invalid('Select an appeal outcome.');
  const row = first(
    await db.$queryRaw<
      (Outcome & { grade_id: string })[]
    >`UPDATE university_grade_appeals a SET status=${amend ? 'PENDING_AMENDMENT' : 'UPHELD'},decision=${decision},decided_by=${ctx.userId}
    FROM university_grades g WHERE a.organization_id=${org} AND a.id=${input.appealId} AND a.status='OPEN' AND (g.organization_id,g.id)=(a.organization_id,a.grade_id)
    AND g.submitted_by<>${ctx.userId} RETURNING a.id,a.status,a.grade_id`,
    'An independent reviewer must decide the open appeal.'
  );
  if (amend) {
    const mark = whole(input.mark, 'amended mark', 0, 100);
    await db.$executeRaw`INSERT INTO university_grades(organization_id,enrollment_id,revision,mark,submitted_by) SELECT organization_id,enrollment_id,revision+1,${mark},${ctx.userId}
      FROM university_grades WHERE organization_id=${org} AND id=${row.grade_id}`;
  }
  return { id: row.id, status: row.status };
}

type CourseResult = {
  course_id: string;
  code: string;
  course: string;
  credits: number;
  required: boolean;
  term: string | null;
  mark: number | null;
  grade_revision: number | null;
};
export function degreeProgress(
  rows: CourseResult[],
  passMark: number,
  creditsNeeded: number,
  recognized: ReadonlySet<string> = new Set(),
  substitutedSources: ReadonlySet<string> = new Set()
) {
  const passed = new Map(
    rows
      .filter((row) => recognized.has(row.course_id) || (row.mark !== null && row.mark >= passMark))
      .map((row) => [row.course_id, row])
  );
  const missing = [
    ...new Set(
      rows.filter((row) => row.required && !passed.has(row.course_id)).map((row) => row.code)
    ),
  ];
  const earned = [...passed.values()]
    .filter((row) => !substitutedSources.has(row.course_id))
    .reduce((sum, row) => sum + row.credits, 0);
  return {
    earnedCredits: earned,
    requiredCredits: creditsNeeded,
    missingRequiredCourses: missing,
    requirementsMet: earned >= creditsNeeded && missing.length === 0,
  };
}
async function academicSnapshot(db: ScopedDb, org: string, id: string) {
  const cohort = first(
    await db.$queryRaw<
      {
        id: string;
        person_id: string;
        student: string;
        intake_id: string;
        program: string;
        campus: string;
        cohort: string;
        curriculum_version: string;
        required_credits: number;
        pass_mark: number;
        research_required: boolean;
        grade_scale: GradeBand[];
        minimum_cgpa: number;
        roll_number: string;
        as_of: Date;
        status: string;
      }[]
    >`
    SELECT sp.id,sp.person_id,pe.full_name AS student,i.id AS intake_id,p.name AS program,c.name AS campus,i.label AS cohort,i.curriculum_version,i.required_credits,i.pass_mark,i.research_required,i.grade_scale,i.minimum_cgpa::float8,sp.roll_number,transaction_timestamp() AS as_of,sp.status
    FROM university_student_programs sp JOIN university_people pe ON (pe.organization_id,pe.id)=(sp.organization_id,sp.person_id)
    JOIN university_intakes i ON (i.organization_id,i.id)=(sp.organization_id,sp.intake_id)
    JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id)
    JOIN university_campuses c ON (c.organization_id,c.id)=(p.organization_id,p.campus_id)
    WHERE sp.organization_id=${org} AND sp.id=${id}`,
    'Student program unavailable.'
  );
  const courses = await db.$queryRaw<
    CourseResult[]
  >`SELECT c.id AS course_id,c.code,c.name AS course,c.credits,c.required,result.term,result.mark,result.grade_revision
    FROM university_courses c LEFT JOIN LATERAL (
      SELECT s.term,latest.mark,latest.revision AS grade_revision FROM university_sections s
      JOIN university_enrollments e ON (e.organization_id,e.section_id)=(s.organization_id,s.id) AND e.person_id=${cohort.person_id}
      JOIN LATERAL (SELECT g.mark,g.revision FROM university_grades g WHERE g.organization_id=e.organization_id AND g.enrollment_id=e.id AND g.status='PUBLISHED' ORDER BY g.revision DESC LIMIT 1) latest ON true
      WHERE s.organization_id=c.organization_id AND s.course_id=c.id) result ON true
    WHERE c.organization_id=${org} AND c.intake_id=${cohort.intake_id} ORDER BY c.code,result.term,result.grade_revision`;
  const transfers = await readTransferCredits(db, org, id);
  const gpa = gradePointAverages(courses, cohort.grade_scale, cohort.pass_mark);
  const progress = degreeProgress(
    courses,
    cohort.pass_mark,
    cohort.required_credits,
    new Set(transfers.map((transfer) => transfer.course_id)),
    new Set(
      transfers.flatMap((transfer) =>
        transfer.substitute_course_id ? [transfer.substitute_course_id] : []
      )
    )
  );
  if (cohort.minimum_cgpa > 0 && (gpa.cgpa === null || gpa.cgpa < cohort.minimum_cgpa))
    progress.requirementsMet = false;
  return { cohort, courses, transfers, progress, ...gpa };
}
async function issueTranscript(ctx: UniversityContext, studentProgramId: string) {
  requireOffice(ctx, examiners);
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const snapshot = await academicSnapshot(db, org, studentProgramId);
  return first(
    await db.$queryRaw<
      { id: string }[]
    >`INSERT INTO university_transcripts(organization_id,student_program_id,snapshot,issued_by)
    VALUES(${org},${studentProgramId},${JSON.stringify(snapshot)}::jsonb,${ctx.userId}) RETURNING id`,
    'Transcript could not be issued.'
  );
}
async function confer(ctx: UniversityContext, input: Inputs) {
  requireOffice(ctx, registrar);
  const { db, organizationId: org } = ctx;
  await lockAcademicWrites(db, org);
  const credential = textValue(input.credential, 'credential number');
  const [existing] = await db.$queryRaw<
    { id: string; credential_number: string }[]
  >`SELECT id,credential_number FROM university_awards WHERE organization_id=${org} AND student_program_id=${input.studentProgramId}`;
  if (existing) {
    if (existing.credential_number !== credential)
      invalid('This student program has a different issued credential.');
    return existing;
  }
  const snapshot = await academicSnapshot(db, org, input.studentProgramId);
  if (snapshot.cohort.status !== 'ACTIVE' || !snapshot.progress.requirementsMet)
    invalid('The student must be active and meet all cohort credit and required-course rules.');
  const [pending] = await db.$queryRaw<
    { id: string }[]
  >`SELECT g.id FROM university_grades g JOIN university_enrollments e ON (e.organization_id,e.id)=(g.organization_id,g.enrollment_id)
    JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id) LEFT JOIN university_grade_appeals a ON (a.organization_id,a.grade_id)=(g.organization_id,g.id)
    WHERE g.organization_id=${org} AND e.person_id=${snapshot.cohort.person_id} AND s.intake_id=${snapshot.cohort.intake_id} AND (g.status='DRAFT' OR a.status IN ('OPEN','PENDING_AMENDMENT')) LIMIT 1`;
  if (pending) invalid('Resolve outstanding grades and appeals before degree conferral.');
  const entitled = ctx.entitlements ?? (await resolveOrganizationEntitlements(org, db));
  if (!(await checkConferralEligibility(db, org, input.studentProgramId)))
    invalid('Clear academic holds and resolve any interruption before conferral.');
  const researchEnabled = hasModule(entitled, 'university-research');
  if (snapshot.cohort.research_required && !researchEnabled)
    invalid('The research module is required to verify this degree.');
  const [research] = researchEnabled
    ? await db.$queryRaw<
        { status: string }[]
      >`SELECT status FROM university_research_cases WHERE organization_id=${org} AND student_program_id=${input.studentProgramId} FOR UPDATE`
    : [];
  if ((snapshot.cohort.research_required || research) && research?.status !== 'COMPLETE')
    invalid('Research milestones must be complete before degree conferral.');
  const { assertUniversityLibraryClearance, releaseUniversityServicesOnWithdrawal } =
    await import('./services');
  if (hasModule(entitled, 'university-services'))
    await assertUniversityLibraryClearance(ctx, snapshot.cohort.person_id);
  await db.$executeRaw`UPDATE university_student_programs SET status='GRADUATED',ended_at=now() WHERE organization_id=${org} AND id=${snapshot.cohort.id}`;
  const transcript = await issueTranscript(ctx, snapshot.cohort.id);
  const award = first(
    await db.$queryRaw<
      { id: string; credential_number: string }[]
    >`INSERT INTO university_awards(organization_id,student_program_id,transcript_id,credential_number,issued_by) VALUES(
    ${org},${snapshot.cohort.id},${transcript.id},${credential},${ctx.userId}) RETURNING id,credential_number`,
    'Credential could not be issued.'
  );

  if (hasModule(entitled, 'university-services'))
    await releaseUniversityServicesOnWithdrawal(ctx, snapshot.cohort.person_id, 'GRADUATED');
  await emitUniversityEvent(ctx, 'degree.awarded', award.id, {
    personId: snapshot.cohort.person_id,
    studentProgramId: snapshot.cohort.id,
    awardId: award.id,
    credentialNumber: credential,
  });
  return award;
}
export async function readStudentApplications(db: ScopedDb, org: string, personId: string) {
  return db.$queryRaw<
    (Outcome & {
      program: string;
      intake: string;
      merit_score: number | null;
      offered_rank: number | null;
      category: string | null;
      appeal_decision: string | null;
      appeal_status: string | null;
    })[]
  >`SELECT a.id,a.status,p.name AS program,i.label AS intake,a.merit_score::float8,a.offered_rank,(SELECT q.label FROM university_seat_categories q WHERE q.organization_id=a.organization_id AND q.id=a.category_id) AS category,
    last_appeal.status AS appeal_status,last_appeal.decision AS appeal_decision
    FROM university_applications a LEFT JOIN LATERAL (SELECT ap.status,ap.decision FROM university_admission_appeals ap WHERE ap.organization_id=a.organization_id AND ap.application_id=a.id ORDER BY ap.submitted_at DESC LIMIT 1) last_appeal ON true JOIN university_intakes i ON (i.organization_id,i.id)=(a.organization_id,a.intake_id)
    JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id) WHERE a.organization_id=${org} AND a.person_id=${personId} ORDER BY a.submitted_at DESC`;
}
export async function readStudentAcademics(db: ScopedDb, org: string, personId: string) {
  const applications = await readStudentApplications(db, org, personId);
  const programs = await db.$queryRaw<
    (Outcome & {
      program: string;
      intake: string;
      curriculum_version: string;
      roll_number: string;
    })[]
  >`SELECT sp.id,sp.roll_number,sp.status,p.name AS program,i.label AS intake,i.curriculum_version
    FROM university_student_programs sp JOIN university_intakes i ON (i.organization_id,i.id)=(sp.organization_id,sp.intake_id)
    JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id) WHERE sp.organization_id=${org} AND sp.person_id=${personId} ORDER BY sp.matriculated_at DESC`;
  const sections = await db.$queryRaw<
    Section[]
  >`SELECT s.id,c.name AS course,s.term,s.label,s.room,s.weekday,s.start_minute,s.end_minute FROM university_sections s
    JOIN university_courses c ON (c.organization_id,c.id)=(s.organization_id,s.course_id)
    JOIN university_student_programs sp ON sp.organization_id=s.organization_id AND sp.intake_id=s.intake_id AND sp.person_id=${personId} AND sp.status='ACTIVE'
    WHERE s.organization_id=${org} ORDER BY s.term,c.name,s.label`;
  const enrollments = await db.$queryRaw<
    (Outcome & {
      section_id: string;
      course: string;
      term: string;
      mark: number | null;
      appeal_status: string | null;
    })[]
  >`
    SELECT e.id,e.status,e.section_id,c.name AS course,s.term,latest.mark,a.status AS appeal_status FROM university_enrollments e
    JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id) JOIN university_courses c ON (c.organization_id,c.id)=(s.organization_id,s.course_id)
    LEFT JOIN LATERAL (SELECT g.id,g.mark FROM university_grades g WHERE g.organization_id=e.organization_id AND g.enrollment_id=e.id AND g.status='PUBLISHED' ORDER BY g.revision DESC LIMIT 1) latest ON true
    LEFT JOIN university_grade_appeals a ON a.organization_id=e.organization_id AND a.grade_id=latest.id
    WHERE e.organization_id=${org} AND e.person_id=${personId} ORDER BY s.term,c.name,e.id`;
  const awards = await db.$queryRaw<
    { id: string; credential_number: string; issued_at: Date }[]
  >`SELECT a.id,a.credential_number,a.issued_at FROM university_awards a JOIN university_student_programs sp
    ON (sp.organization_id,sp.id)=(a.organization_id,a.student_program_id) WHERE a.organization_id=${org} AND sp.person_id=${personId} ORDER BY a.issued_at DESC`;
  const transcripts = await db.$queryRaw<
    { id: string; snapshot: RecordRow; issued_at: Date }[]
  >`SELECT t.id,t.snapshot,t.issued_at FROM university_transcripts t JOIN university_student_programs sp
    ON (sp.organization_id,sp.id)=(t.organization_id,t.student_program_id) WHERE t.organization_id=${org} AND sp.person_id=${personId} ORDER BY t.issued_at DESC`;
  const studentPrograms = await Promise.all(
    programs.map(async (program) => {
      const audit = await academicSnapshot(db, org, program.id);
      return { ...program, cgpa: audit.cgpa, term_gpas: audit.term_gpas };
    })
  );
  return { applications, programs: studentPrograms, sections, enrollments, awards, transcripts };
}

async function readAdmissionsOffice(ctx: UniversityContext): Promise<RecordRow[]> {
  requireOffice(ctx, admissions);
  const { db, organizationId: org } = ctx;
  const campuses = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Campus' AS record,id,name,recognition_ref FROM university_campuses WHERE organization_id=${org} ORDER BY name,id LIMIT 50`;
  const programs = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Program' AS record,id,name,code,campus_id,pqr_reference,accreditation_reference,valid_from::text,valid_to::text FROM university_programs WHERE organization_id=${org} ORDER BY name,id LIMIT 50`;
  const intakes = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Intake' AS record,id,program_id,label,status,curriculum_version,capacity,required_credits,opens_on::text,closes_on::text,starts_on::text FROM university_intakes WHERE organization_id=${org} ORDER BY starts_on DESC,label,id LIMIT 50`;
  const courses = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Curriculum course' AS record,id,intake_id,code,name,credits,required FROM university_courses WHERE organization_id=${org} ORDER BY intake_id,code,id LIMIT 50`;
  const applicants = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Application' AS record,a.id,a.person_id,p.full_name,a.intake_id,a.category_id,a.status,a.offered_list_id,a.offered_rank,a.merit_score::float8,a.qualification,a.equivalence_reference,a.decision_reason
    FROM university_applications a JOIN university_people p ON (p.organization_id,p.id)=(a.organization_id,a.person_id) WHERE a.organization_id=${org}
    ORDER BY a.submitted_at DESC,a.id LIMIT 50`;
  const lists = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Published merit list' AS record,id,intake_id,version,formula_version,school_weight,jsonb_array_length(candidates) AS candidate_count,published_at FROM university_merit_lists WHERE organization_id=${org} ORDER BY published_at DESC,id LIMIT 50`;
  const appeals = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Admissions appeal' AS record,id,application_id,reason,status,decision FROM university_admission_appeals WHERE organization_id=${org} ORDER BY submitted_at DESC,id LIMIT 50`;
  const categories = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Seat category' AS record,id,intake_id,label,capacity FROM university_seat_categories WHERE organization_id=${org} ORDER BY intake_id,label,id LIMIT 50`;
  return [
    ...campuses,
    ...programs,
    ...intakes,
    ...courses,
    ...categories,
    ...applicants,
    ...lists,
    ...appeals,
  ];
}
async function readAcademicsOffice(ctx: UniversityContext): Promise<RecordRow[]> {
  requireOffice(ctx, faculty);
  const { db, organizationId: org } = ctx;
  const broad = ctx.admin || ctx.roleKey === 'university-admin' || examiners.includes(ctx.roleKey);
  const staff = broad
    ? await db.$queryRaw<
        RecordRow[]
      >`SELECT 'Instructor' AS record,u.id,u.name FROM users u JOIN organization_roles r ON r."organizationId"=u."organizationId" AND r.id=u."organizationRoleId"
    WHERE u."organizationId"=${org} AND u.status='ACTIVE' AND r.key='university-instructor' ORDER BY u.name,u.id LIMIT 50`
    : [];
  const programs = broad
    ? await db.$queryRaw<
        RecordRow[]
      >`SELECT 'Student program' AS record,sp.id,sp.roll_number,sp.person_id,p.full_name,sp.intake_id,sp.status FROM university_student_programs sp
    JOIN university_people p ON (p.organization_id,p.id)=(sp.organization_id,sp.person_id) WHERE sp.organization_id=${org} ORDER BY sp.matriculated_at DESC,sp.id LIMIT 50`
    : [];
  const sections = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Section' AS record,s.id,s.label,c.code AS course,s.term,s.room,s.weekday,s.start_minute,s.end_minute,s.capacity,s.instructor_id FROM university_sections s
    JOIN university_courses c ON (c.organization_id,c.id)=(s.organization_id,s.course_id) WHERE s.organization_id=${org} AND (${broad} OR s.instructor_id=${ctx.userId}) ORDER BY s.term DESC,c.code,s.label,s.id LIMIT 50`;
  const roster = await db.$queryRaw<
    RecordRow[]
  >`SELECT 'Enrollment' AS record,e.id,e.section_id,c.code AS course,e.person_id,p.full_name,e.status,g.id AS grade_id,g.mark,g.status AS grade_status,a.id AS appeal_id,a.status AS appeal_status,
    CASE WHEN ${broad} THEN a.reason END AS appeal_reason FROM university_enrollments e JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id)
    JOIN university_courses c ON (c.organization_id,c.id)=(s.organization_id,s.course_id) JOIN university_people p ON (p.organization_id,p.id)=(e.organization_id,e.person_id)
    LEFT JOIN LATERAL (SELECT id,mark,status FROM university_grades WHERE organization_id=e.organization_id AND enrollment_id=e.id ORDER BY revision DESC LIMIT 1) g ON true
    LEFT JOIN university_grade_appeals a ON a.organization_id=e.organization_id AND a.grade_id=g.id
    WHERE e.organization_id=${org} AND (${broad} OR s.instructor_id=${ctx.userId}) ORDER BY e.queued_at DESC,e.id LIMIT 50`;
  return [...staff, ...programs, ...sections, ...roster];
}

function field(
  name: string,
  label: string,
  type: UniversityField['type'] = 'text',
  required = true
): UniversityField {
  return { name, label, type, required };
}
function choice(name: string, label: string, options: string[]): UniversityField {
  return { name, label, type: 'select', required: true, options };
}
const intake = field('intakeId', 'Intake ID'),
  application = field('applicationId', 'Application ID'),
  studentProgram = field('studentProgramId', 'Student program ID');
const enrollment = field('enrollmentId', 'Enrollment ID'),
  section = field('sectionId', 'Section ID'),
  person = field('personId', 'Academic person ID');

export const admissionsOffice: UniversityOffice = {
  title: 'Admissions and curriculum',
  description:
    'Approve campus programs and cohort rules, review merit, offer places and matriculate accepted applicants.',
  moduleKey: 'university-admissions',
  roles: ['university-admin', ...admissions],
  read: readAdmissionsOffice,
  actions: [
    {
      key: 'create-campus',
      label: 'Register campus recognition',
      roles: registrar,
      fields: [field('name', 'Campus name'), field('recognition', 'Recognition reference')],
      run: createCampus,
    },
    {
      key: 'create-program',
      label: 'Register campus program',
      roles: registrar,
      fields: [
        field('campusId', 'Campus ID'),
        field('name', 'Program name'),
        field('code', 'Program code'),
        field('pqr', 'Pakistan Qualification Register reference'),
        field('accreditation', 'Accreditation or exemption reference'),
        field('validFrom', 'Recognition valid from', 'date'),
        field('validTo', 'Recognition valid through', 'date'),
      ],
      run: createProgram,
    },
    {
      key: 'create-intake',
      label: 'Draft an intake and curriculum',
      roles: registrar,
      fields: [
        field('programId', 'Program ID'),
        field('label', 'Cohort label'),
        field('version', 'Curriculum version'),
        field('meritVersion', 'Merit formula version', 'text', false),
        field(
          'schoolWeight',
          'Qualification weight percent (entry exam supplies remainder)',
          'number',
          false
        ),
        field('credits', 'Minimum degree credits', 'number'),
        field('passMark', 'Passing mark out of 100', 'number'),
        field(
          'gradeScale',
          'Minimum mark = GPA points, comma separated (default 85=4,80=3.7,75=3.3,70=3,65=2.7,60=2.3,55=2,50=1,0=0)',
          'textarea',
          false
        ),
        field('minimumGpa', 'Minimum cumulative GPA for graduation (0 to 4)', 'number', false),
        field('capacity', 'Intake places', 'number'),
        choice('track', 'Degree track', ['Taught', 'Research']),
        field('tuitionPaisa', 'Tuition assessed at matriculation in PKR paisa', 'number', false),
        field('opens', 'Applications open', 'date'),
        field('closes', 'Applications close', 'date'),
        field('starts', 'Classes commence', 'date'),
      ],
      run: createIntake,
    },
    {
      key: 'add-course',
      label: 'Add course to draft curriculum',
      roles: registrar,
      fields: [
        intake,
        field('code', 'Course code'),
        field('name', 'Course title'),
        field('credits', 'Credit hours', 'number'),
        choice('requirement', 'Degree requirement', ['Required', 'Elective']),
      ],
      run: addCourse,
    },
    {
      key: 'approve-intake',
      label: 'Approve intake and lock curriculum',
      roles: registrar,
      fields: [intake],
      run: approveIntake,
    },
    {
      key: 'close-intake',
      label: 'Close intake to new applications',
      roles: registrar,
      fields: [intake],
      run: async (ctx, input) => {
        requireOffice(ctx, registrar);
        await lockAcademicWrites(ctx.db, ctx.organizationId);
        return first(
          await ctx.db.$queryRaw<
            Outcome[]
          >`UPDATE university_intakes SET status='CLOSED' WHERE organization_id=${ctx.organizationId} AND id=${input.intakeId} AND status='APPROVED' RETURNING id,status`,
          'Select an approved intake.'
        );
      },
    },
    {
      key: 'assess',
      label: 'Assess applicant merit and equivalence',
      fields: [
        application,
        field('score', 'Normalized school qualification percentage', 'number'),
        field('entryScore', 'Normalized entry examination percentage', 'number', false),
        field('qualification', 'Reviewed qualification', 'textarea'),
        field('equivalenceReference', 'IBCC or HEC equivalence reference', 'text', false),
      ],
      run: assessApplicant,
    },
    {
      key: 'publish-merit',
      label: 'Publish versioned merit list',
      fields: [intake],
      run: publishMeritList,
    },
    {
      key: 'view-merit-list',
      label: 'Look up published merit ranks',
      fields: [
        field('listId', 'Published merit list ID'),
        field('firstRank', 'First rank to display (50 entries)', 'number', false),
      ],
      run: async (ctx, input) => {
        requireOffice(ctx, admissions);
        const firstRank = whole(input.firstRank || '1', 'first rank', 1, 1000000);
        return ctx.db.$queryRaw<
          RecordRow[]
        >`SELECT ranked.rank::int AS rank,ranked.candidate FROM university_merit_lists l
        CROSS JOIN LATERAL jsonb_array_elements(l.candidates) WITH ORDINALITY ranked(candidate,rank)
        WHERE l.organization_id=${ctx.organizationId} AND l.id=${input.listId} AND ranked.rank BETWEEN ${firstRank} AND ${firstRank + 49} ORDER BY ranked.rank`;
      },
    },
    {
      key: 'reserve-category',
      label: 'Reserve seats for an intake category',
      roles: registrar,
      fields: [intake, field('label', 'Category'), field('capacity', 'Reserved places', 'number')],
      run: createSeatCategory,
    },
    {
      key: 'resolve-admission-appeal',
      label: 'Decide an admissions appeal',
      roles: registrar,
      fields: [
        field('appealId', 'Appeal ID'),
        choice('outcome', 'Decision', ['Uphold', 'Reopen']),
        field('reason', 'Decision basis', 'textarea'),
      ],
      run: resolveAdmissionAppeal,
    },
    {
      key: 'offer',
      label: 'Offer next place in merit order',
      fields: [
        intake,
        field('categoryId', 'Reserved category ID (blank for open merit)', 'text', false),
      ],
      run: offerNext,
    },
    {
      key: 'reject',
      label: 'Record adverse admissions decision',
      fields: [application, field('reason', 'Decision reason', 'textarea')],
      run: async (ctx, input) => {
        requireOffice(ctx, admissions);
        await lockAcademicWrites(ctx.db, ctx.organizationId);
        return first(
          await ctx.db.$queryRaw<
            Outcome[]
          >`UPDATE university_applications SET status='REJECTED',decision_by=${ctx.userId},decision_reason=${textValue(input.reason, 'decision reason', 1200)} WHERE organization_id=${ctx.organizationId} AND id=${input.applicationId} AND status IN ('SUBMITTED','ASSESSED') RETURNING id,status`,
          'Select an application pending decision.'
        );
      },
    },
    {
      key: 'decline',
      label: 'Record applicant declining an offer',
      fields: [application, field('reason', 'Applicant response or evidence', 'textarea')],
      run: async (ctx, input) => {
        requireOffice(ctx, admissions);
        await lockAcademicWrites(ctx.db, ctx.organizationId);
        return first(
          await ctx.db.$queryRaw<
            Outcome[]
          >`UPDATE university_applications SET status='DECLINED',decision_reason=${textValue(input.reason, 'decline evidence', 1200)} WHERE organization_id=${ctx.organizationId} AND id=${input.applicationId} AND status IN ('OFFERED','ACCEPTED') RETURNING id,status`,
          'Select an offered or accepted application.'
        );
      },
    },
    {
      key: 'matriculate',
      institutionWide: true,
      label: 'Matriculate accepted applicant',
      roles: registrar,
      fields: [application],
      run: matriculate,
    },
  ],
};

export const academicsOffice: UniversityOffice = {
  title: 'Academic records and examinations',
  description: 'Schedule sections, manage rosters, certify grades and issue academic credentials.',
  moduleKey: 'university-academics',
  roles: ['university-admin', ...faculty],
  read: readAcademicsOffice,
  actions: [
    {
      key: 'create-section',
      institutionWide: true,
      label: 'Schedule a teaching section',
      roles: registrar,
      fields: [
        field('courseId', 'Curriculum course ID'),
        field('instructorId', 'Instructor staff ID'),
        field('term', 'Academic term'),
        field('label', 'Section label'),
        field('room', 'Room'),
        field('weekday', 'Weekday (Monday = 1)', 'number'),
        field('startMinute', 'Start minute after midnight', 'number'),
        field('endMinute', 'End minute after midnight', 'number'),
        field('capacity', 'Section places', 'number'),
      ],
      run: createSection,
    },
    {
      key: 'register',
      institutionWide: true,
      label: 'Register student in section',
      roles: registrar,
      fields: [person, section],
      run: (ctx, i) => {
        requireOffice(ctx, registrar);
        return registerStudent(ctx, i.personId, i.sectionId);
      },
    },
    {
      key: 'withdraw-section',
      institutionWide: true,
      label: 'Withdraw from section',
      roles: registrar,
      fields: [person, section],
      run: (ctx, i) => {
        requireOffice(ctx, registrar);
        return withdrawStudent(ctx, i.personId, i.sectionId);
      },
    },
    {
      key: 'withdraw-program',
      institutionWide: true,
      label: 'Withdraw from program',
      roles: registrar,
      fields: [studentProgram, field('reason', 'Withdrawal reason', 'textarea')],
      run: withdrawProgram,
    },
    {
      key: 'submit-grade',
      label: 'Submit grade for moderation',
      roles: faculty,
      fields: [enrollment, field('mark', 'Mark out of 100', 'number')],
      run: submitGrade,
    },
    {
      key: 'publish-grade',
      label: 'Approve and publish grade',
      roles: examiners,
      fields: [field('gradeId', 'Draft grade ID')],
      run: publishGrade,
    },
    {
      key: 'resolve-appeal',
      label: 'Decide a grade appeal',
      roles: examiners,
      fields: [
        field('appealId', 'Appeal ID'),
        choice('outcome', 'Decision', ['Uphold', 'Amend']),
        field('mark', 'Proposed amended mark', 'number', false),
        field('reason', 'Decision reason', 'textarea'),
      ],
      run: resolveAppeal,
    },
    {
      key: 'degree-audit',
      label: 'Run cohort degree audit',
      roles: examiners,
      fields: [studentProgram],
      run: (ctx, i) => {
        requireOffice(ctx, examiners);
        return academicSnapshot(ctx.db, ctx.organizationId, i.studentProgramId);
      },
    },
    {
      key: 'issue-transcript',
      label: 'Issue official transcript',
      roles: examiners,
      fields: [studentProgram],
      run: (ctx, i) => issueTranscript(ctx, i.studentProgramId),
    },
    {
      key: 'confer',
      institutionWide: true,
      label: 'Confer degree',
      roles: registrar,
      fields: [studentProgram, field('credential', 'Credential number')],
      run: confer,
    },
  ],
};
