import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { emitUniversityEvent } from './events';
import {
  officeRoleAllowed,
  type UniversityAction,
  type UniversityContext,
  type UniversityOffice,
} from './office-types';

type Row = Record<string, unknown>;
type Form = Record<string, string>;
const registrar = ['university-registrar'];
const examiners = ['university-registrar', 'university-examinations-officer'];
const instructors = [...examiners, 'university-instructor'];
const advisors = ['university-advisor'];
const accessibility = ['university-accessibility-officer'];
const roles = [...new Set([...instructors, ...advisors, ...accessibility])];
const text = z.string().trim().min(1).max(240);
const passage = z.string().trim().min(1).max(1000);
const date = z.iso.date();
const field = (
  name: string,
  label: string,
  type: 'text' | 'textarea' | 'date' | 'number' = 'text',
  required = true
) => ({ name, label, type, required });
const select = (name: string, label: string, options: string[]) => ({
  name,
  label,
  options,
  type: 'select' as const,
  required: true,
});
function first<T>(rows: T[], message: string) {
  if (!rows.length) throw new Error(message);
  return rows[0];
}
async function lock(ctx: UniversityContext) {
  await ctx.db
    .$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('university-academics:' || ${ctx.organizationId},0))`;
}

export async function readTransferCredits(db: ScopedDb, org: string, studentProgramId: string) {
  return db.$queryRaw<
    {
      course_id: string;
      mark: number | null;
      source: string;
      substitute_course_id: string | null;
    }[]
  >`
    SELECT course_id,mark,source_reference AS source,substitute_course_id FROM university_recognized_courses
    WHERE organization_id=${org} AND student_program_id=${studentProgramId} ORDER BY course_id`;
}
export async function checkConferralEligibility(
  db: ScopedDb,
  org: string,
  studentProgramId: string
) {
  const [record] = await db.$queryRaw<{ ok: boolean }[]>`SELECT NOT EXISTS(
    SELECT 1 FROM university_academic_holds WHERE organization_id=${org} AND student_program_id=${studentProgramId}
      AND released_at IS NULL AND scope IN ('CONFERRAL','BOTH')) AND NOT EXISTS (
    SELECT 1 FROM university_study_interruptions WHERE organization_id=${org} AND student_program_id=${studentProgramId}
      AND starts_on <= (now() AT TIME ZONE 'Asia/Karachi')::date AND (returned_on IS NULL OR returned_on>(now() AT TIME ZONE 'Asia/Karachi')::date)) AS ok`;
  return record.ok;
}

export async function checkRegistrationEligibility(
  db: ScopedDb,
  org: string,
  personId: string,
  sectionId: string,
  knownProgram?: { programId: string; courseId: string }
) {
  // The registration service may already have resolved these two IDs under the person's locked, active enrollment.
  const program =
    knownProgram ??
    (
      await db.$queryRaw<{ programId: string; courseId: string }[]>`
    SELECT prog.id AS "programId",s.course_id AS "courseId" FROM university_sections s
    JOIN university_student_programs prog ON (prog.organization_id,prog.intake_id)=(s.organization_id,s.intake_id)
    WHERE s.organization_id=${org} AND s.id=${sectionId} AND prog.person_id=${personId} AND prog.status='ACTIVE'`
    )[0];
  if (!program) return false;

  // Do not plan grade-history joins or exam rosters for a section that uses neither policy.
  const [rules] = await db.$queryRaw<
    { held: boolean; on_leave: boolean; prerequisites: boolean; exams: boolean }[]
  >`
    SELECT * FROM university_registration_rule_flags(${org},${program.programId},${program.courseId},${sectionId})`;
  if (rules.held || rules.on_leave) return false;
  if (rules.prerequisites) {
    const [missing] = await db.$queryRaw<{ missing: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM university_course_prerequisites r WHERE r.organization_id=${org} AND r.course_id=${program.courseId}
        AND NOT EXISTS(SELECT 1 FROM university_passed_courses p WHERE (p.organization_id,p.person_id,p.course_id)=(${org},${personId},r.prerequisite_course_id))
        AND NOT EXISTS(SELECT 1 FROM university_recognized_courses t WHERE (t.organization_id,t.student_program_id,t.course_id)=(${org},${program.programId},r.prerequisite_course_id))) AS missing`;
    if (missing.missing) return false;
  }
  if (!rules.exams) return true;
  const [other] = await db.$queryRaw<{ overlaps: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM university_exam_sittings incoming JOIN university_enrollments enrolled
        ON enrolled.organization_id=incoming.organization_id AND enrolled.person_id=${personId} AND enrolled.status='ENROLLED'
        AND enrolled.section_id<>incoming.section_id
      JOIN university_exam_sittings scheduled ON (scheduled.organization_id,scheduled.section_id)=(enrolled.organization_id,enrolled.section_id)
      LEFT JOIN university_exam_adjustments own ON (own.organization_id,own.exam_id,own.person_id)=(incoming.organization_id,incoming.id,${personId})
      LEFT JOIN university_exam_adjustments adj ON (adj.organization_id,adj.exam_id,adj.person_id)=(scheduled.organization_id,scheduled.id,${personId})
      WHERE incoming.organization_id=${org} AND incoming.section_id=${sectionId}
        AND incoming.starts_at < scheduled.ends_at+coalesce(adj.additional_minutes,0)*interval '1 minute'
        AND scheduled.starts_at < incoming.ends_at + coalesce(own.additional_minutes,0)*interval '1 minute') AS overlaps`;
  return !other.overlaps;
}

async function assignAdvisor(ctx: UniversityContext, input: Form) {
  const data = z.object({ program: text, advisor: text }).parse(input);
  await lock(ctx);
  const [available] = await ctx.db.$queryRaw<
    { id: string }[]
  >`SELECT u.id FROM users u JOIN organization_roles r
    ON (r."organizationId",r.id)=(u."organizationId",u."organizationRoleId") WHERE u."organizationId"=${ctx.organizationId} AND u.id=${data.advisor}
    AND u.status='ACTIVE' AND r.key='university-advisor' AND r."isSystem"=true`;
  if (!available) throw new Error('Select an active university advisor.');
  const [prior] = await ctx.db.$queryRaw<
    { id: string; advisor_id: string }[]
  >`SELECT id,advisor_id FROM university_advising_assignments
    WHERE organization_id=${ctx.organizationId} AND student_program_id=${data.program} AND released_at IS NULL`;
  if (prior?.advisor_id === data.advisor) return { id: prior.id };
  if (prior)
    await ctx.db
      .$executeRaw`UPDATE university_advising_assignments SET released_at=now() WHERE organization_id=${ctx.organizationId} AND id=${prior.id}`;
  return first(
    await ctx.db.$queryRaw<
      Row[]
    >`INSERT INTO university_advising_assignments(organization_id,student_program_id,advisor_id,assigned_by)
    SELECT organization_id,id,${data.advisor},${ctx.userId} FROM university_student_programs WHERE organization_id=${ctx.organizationId} AND id=${data.program}
    AND status='ACTIVE' RETURNING id`,
    'An active program enrollment is required.'
  );
}
async function placeHold(ctx: UniversityContext, input: Form) {
  const data = z
    .object({
      program: text,
      scope: z.enum(['REGISTRATION', 'CONFERRAL', 'BOTH']),
      message: passage,
    })
    .parse(input);
  await lock(ctx);
  return first(
    await ctx.db.$queryRaw<
      Row[]
    >`INSERT INTO university_academic_holds(organization_id,student_program_id,scope,message,placed_by)
    SELECT organization_id,id,${data.scope},${data.message},${ctx.userId} FROM university_student_programs
    WHERE organization_id=${ctx.organizationId} AND id=${data.program} AND status='ACTIVE' RETURNING id`,
    'Select an active program enrollment.'
  );
}
async function refreshProgramWaitlists(ctx: UniversityContext, programId: string) {
  const [student] = await ctx.db.$queryRaw<
    { person_id: string }[]
  >`SELECT person_id FROM university_student_programs
    WHERE organization_id=${ctx.organizationId} AND id=${programId}`;
  if (student) {
    const { refreshAcademicWaitlists } = await import('./academics');
    await refreshAcademicWaitlists(ctx, student.person_id);
  }
}
async function releaseHold(ctx: UniversityContext, input: Form) {
  const data = z.object({ hold: text, reference: text }).parse(input);
  await lock(ctx);
  const result = first(
    await ctx.db.$queryRaw<
      { id: string; student_program_id: string; scope: string }[]
    >`UPDATE university_academic_holds SET released_at=now(),released_by=${ctx.userId},release_reference=${data.reference}
    WHERE organization_id=${ctx.organizationId} AND id=${data.hold} AND released_at IS NULL RETURNING id,student_program_id,scope`,
    'Select a current hold.'
  );
  if (result.scope !== 'CONFERRAL') await refreshProgramWaitlists(ctx, result.student_program_id);
  return { id: result.id };
}
async function startLeave(ctx: UniversityContext, input: Form) {
  const data = z
    .object({ program: text, starts: date, expected: date, reference: text })
    .parse(input);
  if (data.starts >= data.expected)
    throw new Error('The expected return must follow the start date.');
  await lock(ctx);
  const leave = first(
    await ctx.db.$queryRaw<{ id: string }[]>`INSERT INTO university_study_interruptions
    (organization_id,student_program_id,starts_on,expected_return,leave_reference,approved_by)
    SELECT p.organization_id,p.id,${data.starts}::date,${data.expected}::date,${data.reference},${ctx.userId}
    FROM university_student_programs p WHERE p.organization_id=${ctx.organizationId} AND p.id=${data.program} AND p.status='ACTIVE'
      AND ${data.starts}::date >= (p.matriculated_at AT TIME ZONE 'Asia/Karachi')::date
      AND NOT EXISTS(SELECT 1 FROM university_study_interruptions l WHERE (l.organization_id,l.student_program_id)=(p.organization_id,p.id)
        AND (l.returned_on IS NULL OR l.returned_on>${data.starts}::date))
    ON CONFLICT DO NOTHING RETURNING id`,
    'Check enrollment dates and any open study interruption.'
  );
  await emitUniversityEvent(ctx, 'student.leave.approved', leave.id, {
    studentProgramId: data.program,
    effectiveDate: data.starts,
  });
  return leave;
}
async function returnFromLeave(ctx: UniversityContext, input: Form) {
  const data = z.object({ leave: text, returned: date, reference: text }).parse(input);
  await lock(ctx);
  const row = first(
    await ctx.db.$queryRaw<
      { id: string; student_program_id: string }[]
    >`UPDATE university_study_interruptions SET returned_on=${data.returned}::date,
    return_reference=${data.reference},returned_by=${ctx.userId} WHERE organization_id=${ctx.organizationId} AND id=${data.leave}
    AND returned_on IS NULL AND ${data.returned}::date>=starts_on AND ${data.returned}::date<=(now() AT TIME ZONE 'Asia/Karachi')::date RETURNING id,student_program_id`,
    'Choose a past or current return date for an open leave.'
  );
  await emitUniversityEvent(ctx, 'student.leave.returned', row.id, {
    studentProgramId: row.student_program_id,
    effectiveDate: data.returned,
  });
  await refreshProgramWaitlists(ctx, row.student_program_id);
  return row;
}
async function recognizeCredit(ctx: UniversityContext, input: Form) {
  const data = z
    .object({
      program: text,
      course: text,
      kind: z.enum(['TRANSFER', 'SUBSTITUTION']),
      source: text,
      substitute: z.string().optional(),
      mark: z.string().optional(),
      evidence: text,
    })
    .parse(input);
  const substitute = data.substitute?.trim() || null;
  const mark = data.mark?.trim() ? z.coerce.number().int().min(0).max(100).parse(data.mark) : null;
  if ((data.kind === 'SUBSTITUTION') !== Boolean(substitute))
    throw new Error('Specify a source course ID for an internal substitution.');
  await lock(ctx);
  const recognition = first(
    await ctx.db.$queryRaw<
      Row[]
    >`INSERT INTO university_credit_recognitions(organization_id,student_program_id,course_id,kind,source_reference,
    substitute_course_id,mark,evidence_reference,approved_by)
    SELECT sp.organization_id,sp.id,c.id,${data.kind},${data.source},${substitute},${mark}::int,${data.evidence},${ctx.userId}
    FROM university_student_programs sp JOIN university_courses c ON c.organization_id=sp.organization_id AND c.intake_id=sp.intake_id
    JOIN university_intakes i ON (i.organization_id,i.id)=(c.organization_id,c.intake_id)
    WHERE sp.organization_id=${ctx.organizationId} AND sp.id=${data.program} AND sp.status='ACTIVE' AND c.id=${data.course}
      AND (${mark}::int IS NULL OR ${mark}::int >= i.pass_mark)
      AND (${substitute}::text IS NULL OR EXISTS(SELECT 1 FROM university_passed_courses p JOIN university_courses sc
        ON (sc.organization_id,sc.id)=(p.organization_id,p.course_id) WHERE (p.organization_id,p.person_id,p.course_id)=(sp.organization_id,sp.person_id,${substitute})
          AND (sc.intake_id<>sp.intake_id OR sc.required=false) AND sc.credits>=c.credits))
    ON CONFLICT DO NOTHING RETURNING id`,
    'A recognition needs a new target course and qualifying evidence. A same-curriculum substitution must use a passed elective with sufficient credits.'
  );
  await refreshProgramWaitlists(ctx, data.program);
  return recognition;
}
async function addPrerequisite(ctx: UniversityContext, input: Form) {
  const data = z.object({ course: text, prerequisite: text }).parse(input);
  await lock(ctx);
  return first(
    await ctx.db.$queryRaw<Row[]>`WITH RECURSIVE dependencies(id) AS (
    SELECT ${data.prerequisite}::text UNION SELECT p.prerequisite_course_id FROM university_course_prerequisites p
    JOIN dependencies d ON p.course_id=d.id WHERE p.organization_id=${ctx.organizationId})
    INSERT INTO university_course_prerequisites (organization_id,course_id,prerequisite_course_id)
    SELECT c.organization_id,c.id,p.id FROM university_courses c JOIN university_courses p ON p.organization_id=c.organization_id AND p.intake_id=c.intake_id
    WHERE c.organization_id=${ctx.organizationId} AND c.id=${data.course} AND p.id=${data.prerequisite}
    AND NOT EXISTS(SELECT 1 FROM dependencies WHERE id=${data.course}) ON CONFLICT DO NOTHING RETURNING id`,
    'Both courses must share their curriculum and the prerequisite must create a new, acyclic requirement.'
  );
}
async function scheduleExam(ctx: UniversityContext, input: Form) {
  const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  const data = z
    .object({ section: text, assessment: text, room: text, day: date, start: clock, end: clock })
    .parse(input);
  if (data.end <= data.start) throw new Error('The sitting must end after it starts.');
  await lock(ctx);
  const row = await ctx.db.$queryRaw<Row[]>`
    WITH proposed AS(SELECT (${data.day}::date+${data.start}::time) AT TIME ZONE 'Asia/Karachi' AS starts,
      (${data.day}::date+${data.end}::time) AT TIME ZONE 'Asia/Karachi' AS ends)
    INSERT INTO university_exam_sittings (organization_id,section_id,campus_id,assessment,room,starts_at,ends_at,scheduled_by)
    SELECT s.organization_id,s.id,p.campus_id,${data.assessment},${data.room},t.starts,t.ends,${ctx.userId}
    FROM university_sections s JOIN university_intakes i ON (i.organization_id,i.id)=(s.organization_id,s.intake_id)
    JOIN university_programs p ON (p.organization_id,p.id)=(i.organization_id,i.program_id) CROSS JOIN proposed t
    WHERE s.organization_id=${ctx.organizationId} AND s.id=${data.section}
      AND NOT EXISTS(SELECT 1 FROM university_exam_sittings other JOIN university_sections os ON (os.organization_id,os.id)=(other.organization_id,other.section_id)
        LEFT JOIN LATERAL (SELECT max(a.additional_minutes) AS extra FROM university_exam_adjustments a WHERE (a.organization_id,a.exam_id)=(other.organization_id,other.id)) longest ON true
        WHERE other.organization_id=s.organization_id AND other.starts_at<t.ends AND t.starts<other.ends_at+coalesce(longest.extra,0)*interval '1 minute'
        AND ((other.campus_id=p.campus_id AND lower(other.room)=lower(${data.room})) OR os.instructor_id=s.instructor_id
          OR EXISTS (SELECT 1 FROM university_enrollments a JOIN university_enrollments b ON b.organization_id=a.organization_id AND b.person_id=a.person_id
            LEFT JOIN university_exam_adjustments adj ON (adj.organization_id,adj.exam_id,adj.person_id)=(a.organization_id,other.id,a.person_id)
            WHERE a.organization_id=s.organization_id AND a.section_id=s.id AND b.section_id=os.id AND a.status='ENROLLED' AND b.status='ENROLLED'
              AND t.starts<other.ends_at+coalesce(adj.additional_minutes,0)*interval '1 minute')))
    ON CONFLICT DO NOTHING RETURNING id`;
  return first(
    row,
    'This exam conflicts with a room, instructor, learner timetable or existing assessment.'
  );
}
async function attendance(ctx: UniversityContext, input: Form) {
  const data = z
    .object({ exam: text, person: text, status: z.enum(['PRESENT', 'ABSENT', 'EXCUSED']) })
    .parse(input);
  const rows = await ctx.db.$queryRaw<
    Row[]
  >`INSERT INTO university_assessment_attendance(organization_id,exam_id,person_id,status,marked_by)
    SELECT ex.organization_id,ex.id,e.person_id,${data.status},${ctx.userId} FROM university_exam_sittings ex
    JOIN university_sections s ON (s.organization_id,s.id)=(ex.organization_id,ex.section_id)
    JOIN university_enrollments e ON (e.organization_id,e.section_id)=(s.organization_id,s.id)
    WHERE ex.organization_id=${ctx.organizationId} AND ex.id=${data.exam} AND e.person_id=${data.person} AND e.status='ENROLLED'
      AND (${officeRoleAllowed(ctx, examiners)} OR s.instructor_id=${ctx.userId}) AND ex.starts_at<=now()
    ON CONFLICT(organization_id,exam_id,person_id) DO UPDATE SET status=EXCLUDED.status,marked_at=now(),marked_by=EXCLUDED.marked_by RETURNING id`;
  return first(
    rows,
    'Select a current or completed sitting in your scope and an enrolled learner.'
  );
}
function requireAccessibilityOfficer(ctx: UniversityContext) {
  if (!accessibility.includes(ctx.roleKey))
    throw new Error('This action requires a designated accessibility officer.');
}
async function registerAccommodation(ctx: UniversityContext, input: Form) {
  requireAccessibilityOfficer(ctx);
  const data = z.object({ program: text, evidence: text }).parse(input);
  return first(
    await ctx.db.$queryRaw<
      Row[]
    >`INSERT INTO university_accommodation_cases(organization_id,student_program_id,evidence_reference,reviewed_by)
    SELECT organization_id,id,${data.evidence},${ctx.userId} FROM university_student_programs WHERE organization_id=${ctx.organizationId}
    AND id=${data.program} AND status='ACTIVE' RETURNING id`,
    'An active student program is required.'
  );
}
async function issueAdjustment(ctx: UniversityContext, input: Form) {
  requireAccessibilityOfficer(ctx);
  const data = z
    .object({
      caseId: text,
      exam: text,
      instruction: passage,
      minutes: z.coerce.number().int().min(0).max(240),
    })
    .parse(input);
  await lock(ctx);
  return first(
    await ctx.db.$queryRaw<
      Row[]
    >`INSERT INTO university_exam_adjustments(organization_id,case_id,exam_id,person_id,instruction,additional_minutes,approved_by)
    SELECT ac.organization_id,ac.id,ex.id,sp.person_id,${data.instruction},${data.minutes},${ctx.userId}
    FROM university_accommodation_cases ac JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(ac.organization_id,ac.student_program_id)
    JOIN university_enrollments en ON en.organization_id=sp.organization_id AND en.person_id=sp.person_id AND en.status='ENROLLED'
    JOIN university_sections s ON (s.organization_id,s.id)=(en.organization_id,en.section_id) AND s.intake_id=sp.intake_id
    JOIN university_exam_sittings ex ON (ex.organization_id,ex.section_id)=(s.organization_id,s.id)
    WHERE ac.organization_id=${ctx.organizationId} AND ac.id=${data.caseId} AND ex.id=${data.exam}
    AND NOT EXISTS(SELECT 1 FROM university_exam_sittings other JOIN university_sections os ON (os.organization_id,os.id)=(other.organization_id,other.section_id)
      WHERE other.organization_id=ex.organization_id AND other.id<>ex.id AND other.starts_at>=ex.ends_at
        AND other.starts_at<ex.ends_at+${data.minutes}*interval '1 minute'
        AND ((other.campus_id=ex.campus_id AND lower(other.room)=lower(ex.room)) OR os.instructor_id=s.instructor_id
          OR EXISTS(SELECT 1 FROM university_enrollments en2 WHERE (en2.organization_id,en2.section_id,en2.person_id)=(other.organization_id,other.section_id,sp.person_id) AND en2.status='ENROLLED')))
    ON CONFLICT DO NOTHING RETURNING id`,
    'Select an enrolled learner, an unassigned adjustment and a conflict-free extended sitting.'
  );
}

export async function readLearnerSupport(db: ScopedDb, org: string, personId: string) {
  const advisors = await db.$queryRaw<
    Row[]
  >`SELECT a.student_program_id,u.name AS advisor,u.email FROM university_advising_assignments a
    JOIN users u ON (u."organizationId",u.id)=(a.organization_id,a.advisor_id)
    JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(a.organization_id,a.student_program_id)
    WHERE a.organization_id=${org} AND sp.person_id=${personId} AND a.released_at IS NULL ORDER BY a.assigned_at DESC`;
  const holds = await db.$queryRaw<
    Row[]
  >`SELECT h.id,h.student_program_id,h.scope,h.message FROM university_academic_holds h
    JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(h.organization_id,h.student_program_id)
    WHERE h.organization_id=${org} AND sp.person_id=${personId} AND h.released_at IS NULL ORDER BY h.placed_at DESC`;
  const leaves = await db.$queryRaw<
    Row[]
  >`SELECT l.id,l.student_program_id,l.starts_on::text,l.expected_return::text,l.returned_on::text FROM university_study_interruptions l
    JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(l.organization_id,l.student_program_id)
    WHERE l.organization_id=${org} AND sp.person_id=${personId} ORDER BY l.starts_on DESC`;
  const exams = await db.$queryRaw<
    Row[]
  >`SELECT ex.id,ex.assessment,ex.room,ex.starts_at,ex.ends_at,c.name AS course,
    a.instruction,a.additional_minutes,ex.ends_at+coalesce(a.additional_minutes,0)*interval '1 minute' AS permitted_until,att.status AS attendance
    FROM university_enrollments e JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id)
    JOIN university_courses c ON (c.organization_id,c.id)=(s.organization_id,s.course_id)
    JOIN university_exam_sittings ex ON (ex.organization_id,ex.section_id)=(e.organization_id,e.section_id)
    LEFT JOIN university_exam_adjustments a ON (a.organization_id,a.exam_id,a.person_id)=(ex.organization_id,ex.id,e.person_id)
    LEFT JOIN university_assessment_attendance att ON (att.organization_id,att.exam_id,att.person_id)=(ex.organization_id,ex.id,e.person_id)
    WHERE e.organization_id=${org} AND e.person_id=${personId} AND e.status='ENROLLED' ORDER BY ex.starts_at DESC LIMIT 100`;
  const credits = await db.$queryRaw<
    Row[]
  >`SELECT c.code,c.name,r.kind,r.mark,r.source_reference FROM university_recognized_courses r
    JOIN university_courses c ON (c.organization_id,c.id)=(r.organization_id,r.course_id) WHERE r.organization_id=${org} AND r.person_id=${personId} ORDER BY c.code`;
  return { advisors, holds, leaves, exams, credits };
}

async function readStaff(ctx: UniversityContext) {
  const rows: Row[] = [];
  if (officeRoleAllowed(ctx, [...registrar, ...advisors])) {
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Advising' AS record,a.id,a.student_program_id,sp.person_id,p.full_name,u.name AS advisor
      FROM university_advising_assignments a JOIN university_student_programs sp ON (sp.organization_id,sp.id)=(a.organization_id,a.student_program_id)
      JOIN university_people p ON (p.organization_id,p.id)=(sp.organization_id,sp.person_id)
      JOIN users u ON (u."organizationId",u.id)=(a.organization_id,a.advisor_id)
      WHERE a.organization_id=${ctx.organizationId} AND a.released_at IS NULL AND (${officeRoleAllowed(ctx, registrar)} OR a.advisor_id=${ctx.userId})
      ORDER BY p.full_name LIMIT 100`)
    );
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Hold' AS record,h.id,h.student_program_id,h.scope,h.message,h.released_at FROM university_academic_holds h
      WHERE h.organization_id=${ctx.organizationId} AND (${officeRoleAllowed(ctx, registrar)} OR EXISTS (
        SELECT 1 FROM university_advising_assignments a WHERE (a.organization_id,a.student_program_id)=(h.organization_id,h.student_program_id)
        AND a.advisor_id=${ctx.userId} AND a.released_at IS NULL)) ORDER BY h.placed_at DESC LIMIT 100`)
    );
  }
  if (officeRoleAllowed(ctx, registrar)) {
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Interruption' AS record,id,student_program_id,starts_on::text,expected_return::text,returned_on::text
      FROM university_study_interruptions WHERE organization_id=${ctx.organizationId} ORDER BY starts_on DESC LIMIT 100`)
    );
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Recognized credit' AS record,id,student_program_id,course_id,kind,source_reference,mark
      FROM university_credit_recognitions WHERE organization_id=${ctx.organizationId} ORDER BY created_at DESC LIMIT 100`)
    );
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Prerequisite' AS record,id,course_id,prerequisite_course_id
      FROM university_course_prerequisites WHERE organization_id=${ctx.organizationId} ORDER BY course_id LIMIT 100`)
    );
  }
  if (officeRoleAllowed(ctx, [...instructors, ...accessibility])) {
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Exam' AS record,ex.id,ex.section_id,ex.assessment,ex.room,ex.starts_at,ex.ends_at
      FROM university_exam_sittings ex JOIN university_sections s ON (s.organization_id,s.id)=(ex.organization_id,ex.section_id)
      WHERE ex.organization_id=${ctx.organizationId} AND (${officeRoleAllowed(ctx, [...examiners, ...accessibility])} OR s.instructor_id=${ctx.userId})
      ORDER BY ex.starts_at DESC LIMIT 100`)
    );
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Exam adjustment' AS record,a.exam_id,a.person_id,a.instruction,a.additional_minutes
      FROM university_exam_adjustments a JOIN university_exam_sittings ex ON (ex.organization_id,ex.id)=(a.organization_id,a.exam_id)
      JOIN university_sections s ON (s.organization_id,s.id)=(ex.organization_id,ex.section_id)
      WHERE a.organization_id=${ctx.organizationId} AND (${officeRoleAllowed(ctx, [...examiners, ...accessibility])} OR s.instructor_id=${ctx.userId})
      ORDER BY ex.starts_at DESC LIMIT 100`)
    );
  }
  if (accessibility.includes(ctx.roleKey)) {
    rows.push(
      ...(await ctx.db.$queryRaw<
        Row[]
      >`SELECT 'Restricted accommodation' AS record,id,student_program_id,evidence_reference
      FROM university_accommodation_cases WHERE organization_id=${ctx.organizationId} ORDER BY reviewed_at DESC LIMIT 100`)
    );
  }
  return rows;
}
const programField = field('program', 'Student program enrollment ID');
const actions: UniversityAction[] = [
  {
    key: 'assign-advisor',
    label: 'Assign advisor',
    roles: registrar,
    run: assignAdvisor,
    fields: [programField, field('advisor', 'Advisor staff ID')],
  },
  {
    key: 'place-hold',
    label: 'Place academic hold',
    roles: registrar,
    run: placeHold,
    fields: [
      programField,
      select('scope', 'Blocked operation', ['REGISTRATION', 'CONFERRAL', 'BOTH']),
      field('message', 'Student-facing resolution instructions', 'textarea'),
    ],
  },
  {
    key: 'release-hold',
    label: 'Release academic hold',
    roles: registrar,
    run: releaseHold,
    fields: [field('hold', 'Hold ID'), field('reference', 'Release authorization reference')],
  },
  {
    key: 'approve-leave',
    label: 'Approve study interruption',
    roles: registrar,
    run: startLeave,
    fields: [
      programField,
      field('starts', 'Leave begins', 'date'),
      field('expected', 'Expected return', 'date'),
      field('reference', 'Approval reference'),
    ],
  },
  {
    key: 'return-to-study',
    label: 'Record re-entry',
    roles: registrar,
    run: returnFromLeave,
    fields: [
      field('leave', 'Interruption ID'),
      field('returned', 'Actual return date', 'date'),
      field('reference', 'Re-entry authorization'),
    ],
  },
  {
    key: 'recognize-credit',
    label: 'Recognize transfer or substituted credit',
    roles: registrar,
    run: recognizeCredit,
    fields: [
      programField,
      field('course', 'Target curriculum course ID'),
      select('kind', 'Credit decision', ['TRANSFER', 'SUBSTITUTION']),
      field('source', 'Source transcript and course reference'),
      field('substitute', 'Passed source course ID for substitution', 'text', false),
      field('mark', 'Optional recognized mark', 'number', false),
      field('evidence', 'Approval record reference'),
    ],
  },
  {
    key: 'add-prerequisite',
    label: 'Set prerequisite',
    roles: registrar,
    run: addPrerequisite,
    fields: [field('course', 'Course ID'), field('prerequisite', 'Prerequisite course ID')],
  },
  {
    key: 'schedule-exam',
    institutionWide: true,
    label: 'Schedule assessment',
    roles: examiners,
    run: scheduleExam,
    fields: [
      field('section', 'Section ID'),
      field('assessment', 'Assessment label'),
      field('day', 'Exam date in Pakistan', 'date'),
      field('start', 'Start time in Pakistan (HH:MM)'),
      field('end', 'End time in Pakistan (HH:MM)'),
      field('room', 'Room'),
    ],
  },
  {
    key: 'attendance',
    label: 'Record assessment attendance',
    roles: instructors,
    run: attendance,
    fields: [
      field('exam', 'Exam ID'),
      field('person', 'University person ID'),
      select('status', 'Attendance', ['PRESENT', 'ABSENT', 'EXCUSED']),
    ],
  },
  {
    key: 'record-accommodation',
    strictRoles: true,
    label: 'Register restricted accommodation case',
    roles: accessibility,
    run: registerAccommodation,
    fields: [programField, field('evidence', 'Restricted evidence reference')],
  },
  {
    key: 'exam-adjustment',
    institutionWide: true,
    strictRoles: true,
    label: 'Release exam instructions',
    roles: accessibility,
    run: issueAdjustment,
    fields: [
      field('caseId', 'Accommodation case ID'),
      field('exam', 'Exam ID'),
      field('minutes', 'Approved additional minutes', 'number'),
      field('instruction', 'Operational directions for learner and instructor', 'textarea'),
    ],
  },
];
export const academicSupportOffice: UniversityOffice = {
  title: 'Academic support',
  description: 'Manage advising, credit decisions, academic holds and exam arrangements.',
  moduleKey: 'university-academics',
  roles,
  actions,
  read: readStaff,
};
