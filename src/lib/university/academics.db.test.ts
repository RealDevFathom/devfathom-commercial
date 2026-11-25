// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { UniversityContext, UniversityOffice } from './office-types';
import {
  admissionsOffice,
  academicsOffice,
  submitApplication,
  acceptStudentOffer,
  appealAdmissionDecision,
  registerStudent,
  withdrawStudent,
  appealGrade,
  readStudentAcademics,
} from './academics';

vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: async () => ({ limits: { 'university.activeStudents.max': 3 } }),
  hasModule: () => false,
}));
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const schema = 'academic_test_' + randomUUID().replaceAll('-', '');
const org = 'university';
let pool: Pool;
let setup: Pool;
function database(client: PoolClient): ScopedDb {
  const sql = (parts: TemplateStringsArray) =>
    parts.reduce((query, part, index) => query + (index ? '$' + index : '') + part, '');
  return {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await client.query(sql(parts), values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await client.query(sql(parts), values)).rowCount,
  } as unknown as ScopedDb;
}
async function transaction<T>(
  run: (ctx: UniversityContext) => Promise<T>,
  role = 'university-registrar',
  userId = 'registrar'
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO ' + schema);
    await client.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    const result = await run({
      db: database(client),
      organizationId: org,
      roleKey: role,
      userId,
      admin: false,
    });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
function action(
  office: UniversityOffice,
  key: string,
  inputs: Record<string, string>,
  role?: string,
  actor?: string
) {
  const operation = office.actions.find((item) => item.key === key)!;
  return transaction(
    async (ctx) => (await operation.run(ctx, inputs)) as { id: string; status: string },
    role,
    actor
  );
}
suite('academic lifecycle on PostgreSQL', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 8 });
    // The production-like runtime can exercise tenant RLS without privileges to create test roles.
    setup = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL ?? url, max: 1 });
    const {
      rows: [runtime],
    } = await pool.query<{ role: string }>('SELECT quote_ident(current_user) AS role');
    const client = await setup.connect();
    try {
      await client.query('CREATE SCHEMA ' + schema);
      await client.query('SET search_path TO ' + schema);
      await client.query(`CREATE TABLE organizations(id text PRIMARY KEY,timezone text);
        CREATE TABLE organization_roles(id text,"organizationId" text,key text);
        CREATE TABLE users(id text PRIMARY KEY,"organizationId" text,"organizationRoleId" text,status text,name text,UNIQUE("organizationId",id));
        CREATE TABLE university_people(organization_id text,id text,full_name text,PRIMARY KEY(organization_id,id));
        INSERT INTO organizations VALUES('university','Asia/Karachi'),('different','UTC');
        INSERT INTO organization_roles VALUES('instructor','university','university-instructor');
        INSERT INTO users VALUES('registrar','university',NULL,'ACTIVE','Registrar'),('teacher','university','instructor','ACTIVE','Teacher'),('other-teacher','university','instructor','ACTIVE','Other'),('examiner','university',NULL,'ACTIVE','Examiner');
        INSERT INTO university_people VALUES('university','a','A'),('university','b','B'),('university','c','C');`);
      for (const migration of [
        '20261125090050_university_events',
        '20261125090200_university_academics',
        '20261125090650_university_academic_support',
      ]) {
        await client.query(
          await readFile('prisma/migrations/' + migration + '/migration.sql', 'utf8')
        );
      }
      await client.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + runtime.role);
      await client.query(
        'GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + runtime.role
      );
      await client.query('CREATE ROLE ' + schema + '_reader NOLOGIN NOSUPERUSER NOBYPASSRLS');
      await client.query('GRANT ' + schema + '_reader TO CURRENT_USER');
      await client.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + schema + '_reader');
      await client.query(
        'GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + schema + '_reader'
      );
      await client.query(
        "INSERT INTO university_campuses(organization_id,name,recognition_ref) VALUES('different','Private foreign campus','D')"
      );
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await pool?.end();
    if (setup) {
      await setup.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await setup.query('DROP ROLE IF EXISTS ' + schema + '_reader');
      await setup.end();
    }
  });
  it('enforces academic tenant policies under a non-bypass database role', async () => {
    const client = await setup.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO ' + schema);
      await client.query('SET LOCAL ROLE ' + schema + '_reader');
      await client.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
      const other = await client.query(
        "SELECT id FROM university_campuses WHERE organization_id='different'"
      );
      expect(other.rows).toEqual([]);
      await client.query("SELECT set_config('app.current_organization_id','different',true)");
      expect((await client.query('SELECT name FROM university_campuses')).rows).toEqual([
        { name: 'Private foreign campus' },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('ranks applicants, reserves the final seat, promotes a waiting student and preserves transcripts across an appeal', async () => {
    const campus = await action(admissionsOffice, 'create-campus', {
      name: 'Main',
      recognition: 'Campus register',
    });
    const program = await action(admissionsOffice, 'create-program', {
      campusId: campus.id,
      name: 'Computing',
      code: 'CS',
      pqr: 'PQR-1',
      accreditation: 'Accredited',
      validFrom: day(-100),
      validTo: day(1000),
    });
    const intake = await action(admissionsOffice, 'create-intake', {
      programId: program.id,
      label: 'Autumn',
      version: '2026',
      credits: '3',
      passMark: '50',
      capacity: '3',
      schoolWeight: '60',
      meritVersion: 'M1',
      opens: day(-10),
      closes: day(5),
      starts: day(20),
    });
    const course = await action(admissionsOffice, 'add-course', {
      intakeId: intake.id,
      code: 'C101',
      name: 'Foundations',
      credits: '3',
      requirement: 'Required',
    });
    const advanced = await action(admissionsOffice, 'add-course', {
      intakeId: intake.id,
      code: 'C201',
      name: 'Advanced topics',
      credits: '1',
      requirement: 'Elective',
    });
    await transaction(async (ctx) => {
      await ctx.db
        .$executeRaw`INSERT INTO university_course_prerequisites(organization_id,course_id,prerequisite_course_id) VALUES(${org},${advanced.id},${course.id})`;
    });
    const category = await action(admissionsOffice, 'reserve-category', {
      intakeId: intake.id,
      label: 'Reserved test category',
      capacity: '1',
    });
    await action(admissionsOffice, 'approve-intake', { intakeId: intake.id });
    const applications = await Promise.all(
      ['a', 'b', 'c'].map((person) =>
        transaction((ctx) =>
          submitApplication(
            ctx,
            person,
            intake.id,
            undefined,
            undefined,
            person === 'c' ? category.id : undefined
          )
        )
      )
    );
    for (const [index, app] of applications.entries())
      await action(admissionsOffice, 'assess', {
        applicationId: app.id,
        score: String(70 + index),
        entryScore: '80',
        qualification: 'HSSC',
      });
    await expect(action(admissionsOffice, 'offer', { intakeId: intake.id })).rejects.toThrow(
      'merit list'
    );
    const decision = await transaction((ctx) =>
      appealAdmissionDecision(ctx, 'b', applications[1].id, 'Review school result')
    );
    await expect(
      action(admissionsOffice, 'resolve-admission-appeal', {
        appealId: decision.id,
        outcome: 'Uphold',
        reason: 'Original review',
      })
    ).rejects.toThrow('distinct registrar');
    await action(
      admissionsOffice,
      'resolve-admission-appeal',
      { appealId: decision.id, outcome: 'Uphold', reason: 'Evidence confirmed' },
      'university-registrar',
      'examiner'
    );
    await action(admissionsOffice, 'publish-merit', { intakeId: intake.id });
    for (const [index, person] of ['c', 'b', 'a'].entries()) {
      const offer = await action(admissionsOffice, 'offer', {
        intakeId: intake.id,
        categoryId: person === 'c' ? category.id : '',
      });
      expect(offer.id).toBe(applications[2 - index].id);
      await transaction((ctx) => acceptStudentOffer(ctx, person, offer.id));
      await action(admissionsOffice, 'matriculate', { applicationId: offer.id });
    }
    const section = await action(academicsOffice, 'create-section', {
      courseId: course.id,
      instructorId: 'teacher',
      term: '2026/S1',
      room: 'R1',
      label: 'A',
      weekday: '1',
      startMinute: '500',
      endMinute: '550',
      capacity: '1',
    });
    const studentA = await transaction((ctx) => readStudentAcademics(ctx.db, org, 'a'));
    const [hold] = await transaction(
      (ctx) => ctx.db.$queryRaw<
        { id: string }[]
      >`INSERT INTO university_academic_holds(organization_id,student_program_id,scope,message,placed_by)
      VALUES(${org},${studentA.programs[0].id},'REGISTRATION','Policy check','registrar') RETURNING id`
    );
    await expect(transaction((ctx) => registerStudent(ctx, 'a', section.id))).rejects.toThrow(
      'registration hold'
    );
    await transaction(async (ctx) => {
      await ctx.db
        .$executeRaw`UPDATE university_academic_holds SET released_at=now(),released_by='registrar',release_reference='Cleared' WHERE organization_id=${org} AND id=${hold.id}`;
    });
    const seats = await Promise.all(
      ['a', 'b'].map((person) => transaction((ctx) => registerStudent(ctx, person, section.id)))
    );
    expect(seats.map((x) => x.status).sort()).toEqual(['ENROLLED', 'WAITLISTED']);
    const active = seats[0].status === 'ENROLLED' ? 'a' : 'b',
      waiting = active === 'a' ? 'b' : 'a';
    await transaction((ctx) => withdrawStudent(ctx, active, section.id));
    const student = await transaction((ctx) => readStudentAcademics(ctx.db, org, waiting));
    const enrollment = student.enrollments[0];
    expect(enrollment.status).toBe('ENROLLED');
    await expect(
      action(
        academicsOffice,
        'submit-grade',
        { enrollmentId: enrollment.id, mark: '66' },
        'university-instructor',
        'other-teacher'
      )
    ).rejects.toThrow('assigned section');
    const grade = await action(
      academicsOffice,
      'submit-grade',
      { enrollmentId: enrollment.id, mark: '66' },
      'university-instructor',
      'teacher'
    );
    await expect(
      action(
        academicsOffice,
        'publish-grade',
        { gradeId: grade.id },
        'university-examinations-officer',
        'teacher'
      )
    ).rejects.toThrow('distinct authorized reviewer');
    await action(
      academicsOffice,
      'publish-grade',
      { gradeId: grade.id },
      'university-examinations-officer',
      'examiner'
    );
    const advancedSection = await action(academicsOffice, 'create-section', {
      courseId: advanced.id,
      instructorId: 'other-teacher',
      term: '2026/S2',
      room: 'R2',
      label: 'B',
      weekday: '2',
      startMinute: '500',
      endMinute: '550',
      capacity: '2',
    });
    await expect(
      transaction((ctx) => registerStudent(ctx, 'c', advancedSection.id))
    ).rejects.toThrow('active program');
    expect(
      (await transaction((ctx) => registerStudent(ctx, waiting, advancedSection.id))).status
    ).toBe('ENROLLED');
    await transaction((ctx) => withdrawStudent(ctx, waiting, advancedSection.id));
    const old = await action(academicsOffice, 'issue-transcript', {
      studentProgramId: student.programs[0].id,
    });
    await expect(
      transaction((ctx) => appealGrade(ctx, active, enrollment.id, 'Not my record'))
    ).rejects.toThrow('your record');
    const appeal = await transaction((ctx) =>
      appealGrade(ctx, waiting, enrollment.id, 'Incorrect total')
    );
    await action(
      academicsOffice,
      'resolve-appeal',
      { appealId: appeal.id, outcome: 'Amend', reason: 'Correction approved', mark: '75' },
      'university-examinations-officer',
      'examiner'
    );
    const amended = await transaction(
      (ctx) =>
        ctx.db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM university_grades WHERE organization_id=${org} AND enrollment_id=${enrollment.id} AND revision=2`
    );
    await action(academicsOffice, 'publish-grade', { gradeId: amended[0].id });
    await action(academicsOffice, 'confer', {
      studentProgramId: student.programs[0].id,
      credential: 'CERT-1',
    });
    const records = await transaction((ctx) => readStudentAcademics(ctx.db, org, waiting));
    expect(records.enrollments[0].mark).toBe(75);
    expect(records.programs[0].roll_number).toMatch(/^U-\d+$/);
    expect(records.programs[0].cgpa).toBe(3.3);
    expect(records.awards[0].credential_number).toBe('CERT-1');
    expect(records.transcripts.find((t) => t.id === old.id)?.snapshot).toMatchObject({
      courses: [{ mark: 66 }, { mark: null }],
      cgpa: 2.7,
    });
    const reentry = await transaction((ctx) => registerStudent(ctx, active, section.id));
    expect(reentry).toEqual({
      id: seats.find((enrollment) => enrollment.status === 'ENROLLED')!.id,
      status: 'WAITLISTED',
    });
    expect(await transaction((ctx) => registerStudent(ctx, active, section.id))).toEqual(reentry);
    const concurrent = await Promise.all(
      ['teacher', 'other-teacher'].map((instructorId, n) =>
        action(academicsOffice, 'create-section', {
          courseId: course.id,
          instructorId,
          term: '2027/S2',
          room: 'R' + n,
          label: 'Extra' + n,
          weekday: '2',
          startMinute: '600',
          endMinute: '660',
          capacity: '2',
        })
      )
    );
    const conflicting = await Promise.allSettled(
      concurrent.map((target) => transaction((ctx) => registerStudent(ctx, 'c', target.id)))
    );
    expect(conflicting.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(conflicting.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const foreign = await transaction((ctx) => readStudentAcademics(ctx.db, 'different', waiting));
    expect(foreign.enrollments).toEqual([]);
  }, 16000);
});
