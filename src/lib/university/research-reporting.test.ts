// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { UniversityOffice } from './office-types';
import { censusCsv, orderCensusRows, parseCensusSupplement, reportingOffice } from './reporting';
import { parseGrantBudget, researchOffice, readLearnerResearch } from './research';
import {
  academicSupportOffice,
  checkRegistrationEligibility,
  checkConferralEligibility,
  readLearnerSupport,
  readTransferCredits,
} from './academic-support';

const engine = new PGlite();
const migration = (dir: string) => readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8');

function scoped(tx: Transaction): ScopedDb {
  const sql = (parts: TemplateStringsArray) =>
    parts.reduce((out, part, i) => out + (i === 0 ? '' : '$' + i) + part, '');
  return {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await tx.query(sql(parts), values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await tx.query(sql(parts), values)).affectedRows,
  } as unknown as ScopedDb;
}
async function act(
  office: UniversityOffice,
  key: string,
  input: Record<string, string>,
  roleKey: string,
  userId: string,
  org = 'uni'
) {
  const action = office.actions.find((item) => item.key === key);
  if (!action?.roles?.includes(roleKey)) throw new Error('Role unavailable.');
  return engine.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    return (await action.run(
      { organizationId: org, userId, roleKey, admin: false, db: scoped(tx) },
      input
    )) as Record<string, unknown>;
  });
}

beforeAll(async () => {
  await engine.exec(`
    CREATE TABLE organizations (id text primary key);
    CREATE TABLE users ("organizationId" text not null,id text not null,name text not null,status text not null,primary key("organizationId",id));
    CREATE TABLE university_people (organization_id text not null,id text not null,primary key(organization_id,id));
    INSERT INTO organizations VALUES ('uni'),('other');
    INSERT INTO users VALUES ('uni','research','Research','ACTIVE'),('uni','exam','Examinations','ACTIVE'),
      ('uni','registrar','Registrar','ACTIVE'),('uni','analyst','Analyst','ACTIVE'),('other','analyst','Other analyst','ACTIVE');
    INSERT INTO university_people VALUES ('uni','learner'),('other','learner');
  `);
  await engine.exec(migration('20261125090050_university_events'));
  await engine.exec(migration('20261125090200_university_academics'));
  await engine.exec(migration('20261125090500_university_services'));
  await engine.exec(migration('20261125090600_university_research_reporting'));
  await engine.exec(migration('20261125090610_university_grant_procurement_fk'));
  await engine.exec(migration('20261125090650_university_academic_support'));
  await engine.exec(`
    INSERT INTO university_campuses (organization_id,id,name,recognition_ref) VALUES ('uni','campus','Lahore','HEC-1');
    INSERT INTO university_programs (organization_id,id,campus_id,name,code,pqr_reference,accreditation_reference,valid_from,valid_to)
      VALUES ('uni','degree','campus','Graduate studies','MS','PQR-1','AC-1','2023-01-01','2028-01-01');
    INSERT INTO university_intakes (organization_id,id,program_id,label,curriculum_version,required_credits,pass_mark,capacity,opens_on,closes_on,starts_on,research_required)
      VALUES ('uni','intake','degree','Fall','GEP2023',32,50,20,'2024-01-01','2024-03-01','2024-03-15',true);
    INSERT INTO university_applications (organization_id,person_id,intake_id) VALUES ('uni','learner','intake');
    INSERT INTO university_student_programs (organization_id,id,person_id,intake_id,matriculated_at) VALUES ('uni','enrol','learner','intake','2024-03-15T10:00:00Z');
    INSERT INTO university_transcripts (organization_id,id,student_program_id,snapshot,issued_by) VALUES ('uni','transcript','enrol','{}','registrar');
    INSERT INTO university_awards (organization_id,student_program_id,transcript_id,credential_number,issued_by,issued_at)
      VALUES ('uni','enrol','transcript','DEG-1','registrar','2024-12-15');
    ALTER TABLE users ADD COLUMN email text, ADD COLUMN "organizationRoleId" text;
    ALTER TABLE university_people ADD COLUMN full_name text;
    CREATE TABLE organization_roles ("organizationId" text, id text, key text, "isSystem" boolean);
    INSERT INTO organization_roles VALUES ('uni','advisor-role','university-advisor',true);
    INSERT INTO users("organizationId",id,name,status,"organizationRoleId") VALUES ('uni','advisor','Assigned advisor','ACTIVE','advisor-role'),
      ('uni','access','Accessibility officer','ACTIVE',NULL),('uni','instructor','Teacher','ACTIVE',NULL),('uni','otherTeacher','Other','ACTIVE',NULL);
    INSERT INTO university_courses (organization_id,id,intake_id,code,name,credits,required) VALUES
      ('uni','basic','intake','1','Intro',3,true),('uni','advanced','intake','2','Advanced',3,true),('uni','otherCourse','intake','3','Elective',3,false);
    INSERT INTO university_sections (organization_id,id,intake_id,course_id,instructor_id,term,label,room,weekday,start_minute,end_minute,capacity) VALUES
      ('uni','section','intake','advanced','instructor','Fall','A','Room A',1,600,630,20),('uni','section2','intake','otherCourse','otherTeacher','Fall','B','Room B',2,600,630,20);
    INSERT INTO university_enrollments (organization_id,id,person_id,section_id,status) VALUES ('uni','e1','learner','section','ENROLLED');
    CREATE ROLE university_reporter NOSUPERUSER NOBYPASSRLS;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO university_reporter;
    SET ROLE university_reporter;
  `);
}, 120000);
afterAll(async () => {
  await engine.close();
});

describe('Research, sponsor and reporting controls', () => {
  it('records proposal, ethics, thesis and examination revisions without skipping required stages', async () => {
    const researcher = 'university-research-officer',
      examiner = 'university-examinations-officer';
    const { id } = await act(
      researchOffice,
      'open-case',
      { studentProgramId: 'enrol', title: 'Thesis', supervisorId: 'research' },
      researcher,
      'research'
    );
    const decide = (decision: string, evidence: string, exam = false) =>
      act(
        researchOffice,
        'record-decision',
        { caseId: String(id), decision, evidence },
        exam ? examiner : researcher,
        exam ? 'exam' : 'research'
      );
    await expect(decide('DEFENSE_PASSED', '1', true)).rejects.toThrow('unavailable');
    await decide('PROPOSAL_ACCEPTED', 'proposal minutes');
    await decide('ETHICS_APPROVED', 'committee approval');
    await decide('THESIS_SUBMITTED', 'version 1');
    await expect(decide('CORRECTIONS_REQUIRED', 'examiners report')).rejects.toThrow(
      'responsible office'
    );
    const corrected = await decide('CORRECTIONS_REQUIRED', 'examiners report', true);
    expect(await decide('CORRECTIONS_REQUIRED', 'examiners report', true)).toEqual(corrected);
    await decide('THESIS_RESUBMITTED', 'version 2');
    await decide('DEFENSE_SCHEDULED', 'committee invitation', true);
    await decide('DEFENSE_PASSED', 'signed viva result', true);
  });
  it('stores precise PKR and sponsor terms with traceable deliverable receipts', async () => {
    const role = 'university-research-officer';
    const { id } = await act(
      researchOffice,
      'register-grant',
      {
        code: 'G-1',
        sponsor: 'Council',
        title: 'Award',
        startsOn: '2024-01-01',
        endsOn: '2025-01-01',
        restrictions: 'Travel only',
        budgetPkr: '100000.05',
        categories: 'travel, Travel',
      },
      role,
      'research'
    );
    const item = await act(
      researchOffice,
      'schedule-deliverable',
      { grantId: String(id), title: 'Final report', dueOn: '2025-01-31' },
      role,
      'research'
    );
    await act(
      researchOffice,
      'accept-deliverable',
      { id: String(item.id), receipt: 'Acknowledged by sponsor' },
      role,
      'research'
    );
    await act(
      researchOffice,
      'close-grant',
      { grantId: String(id), reference: 'Sponsor closeout' },
      role,
      'research'
    );
    await expect(
      act(
        researchOffice,
        'schedule-deliverable',
        { grantId: String(id), title: 'extra', dueOn: '2025-02-12' },
        role,
        'research'
      )
    ).rejects.toThrow('active sponsor award');
    expect(parseGrantBudget('100000.05')).toBe('10000005');
    expect(() => parseGrantBudget('1.001')).toThrow();
    const rows = await engine.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_organization_id','uni',true)");
      return tx.query<{ allowed_categories: string[] }>(
        'SELECT allowed_categories FROM university_research_grants'
      );
    });
    expect(rows.rows[0].allowed_categories).toEqual(['TRAVEL']);
  });
  it('requires an affirmative university decision before recording the external HEC reference', async () => {
    const role = 'university-examinations-officer';
    const verify = (request: string, outcome: string) =>
      act(
        researchOffice,
        'verify-award',
        { credential: 'DEG-1', request, outcome, evidence: 'Registrar record' },
        role,
        'exam'
      );
    const rejected = await verify('REQ-1', 'DISCREPANCY');
    const attest = (id: unknown) =>
      act(
        researchOffice,
        'record-hec',
        { verificationId: String(id), hecReference: 'HEC-1', issuedOn: '2025-01-01' },
        role,
        'exam'
      );
    await expect(attest(rejected.id)).rejects.toThrow();
    const approved = await verify('REQ-2', 'VERIFIED');
    expect(await attest(approved.id)).toHaveProperty('id');
    await expect(attest(approved.id)).rejects.toThrow();
    const learner = await academicRead((db) => readLearnerResearch(db, 'uni', 'learner'));
    expect(learner.projects).toHaveLength(1);
    expect(learner.verifications).toEqual(
      expect.arrayContaining([expect.objectContaining({ hec_reference: 'HEC-1' })])
    );
    expect(JSON.stringify(learner)).not.toContain('Registrar record');
    expect(await academicRead((db) => readLearnerResearch(db, 'uni', 'different-person'))).toEqual({
      projects: [],
      milestones: [],
      verifications: [],
    });
  });
  it('freezes reproducible census revisions, requires independent approval, records external acknowledgment and applies RLS', async () => {
    const input = {
      periodStart: '2024-01-01',
      censusDate: '2024-12-31',
      expectedRevision: '0',
      note: 'Registrar register as of census',
      template: 'HEDR request 2024',
      supplement: JSON.stringify([
        {
          scope: 'AFFILIATED_COLLEGE',
          unit: 'Affiliated college A',
          metric: 'teaching_staff',
          count: 14,
          source: 'Approved HR return',
        },
      ]),
    };
    const registrar = 'university-registrar',
      analyst = 'university-analyst';
    const frozen = await act(reportingOffice, 'freeze-census', input, analyst, 'analyst');
    const id = String(frozen.id);
    await expect(
      act(reportingOffice, 'approve-census', { id }, registrar, 'analyst')
    ).rejects.toThrow();
    await expect(
      act(reportingOffice, 'export-census', { id }, analyst, 'analyst')
    ).rejects.toThrow();
    await act(reportingOffice, 'approve-census', { id }, registrar, 'registrar');
    const output = await act(reportingOffice, 'export-census', { id }, analyst, 'analyst');
    expect(output.content).toContain('"INSTITUTION","All","active_students",1,"Registrar"');
    expect(output.content).toContain('"teaching_staff",14,');
    expect(output.sha256).toEqual(frozen.sha256);
    await expect(
      act(reportingOffice, 'export-census', { id }, analyst, 'analyst', 'other')
    ).rejects.toThrow();
    await act(
      reportingOffice,
      'acknowledge-census',
      { id, externalReference: 'HEDR receipt-1' },
      registrar,
      'registrar'
    );
    await expect(act(reportingOffice, 'freeze-census', input, analyst, 'analyst')).rejects.toThrow(
      'Refresh'
    );
    const revision = await act(
      reportingOffice,
      'freeze-census',
      { ...input, expectedRevision: '1', note: 'Approved census revision', supplement: '' },
      analyst,
      'analyst'
    );
    expect(revision.sha256).not.toBe(frozen.sha256);
    expect(
      (await act(reportingOffice, 'export-census', { id }, analyst, 'analyst')).content
    ).toEqual(output.content);
  });
  it('validates supplemental counts and neutralizes spreadsheet formulas in exports', () => {
    const row = {
      scope: 'AFFILIATED_COLLEGE',
      unit: 'College',
      metric: 'graduates',
      count: 2,
      source: '=HYPERLINK()',
    } as const;
    expect(() => parseCensusSupplement(JSON.stringify([{ ...row, count: -1 }]))).toThrow();
    expect(() => orderCensusRows([row, row])).toThrow();
    expect(censusCsv([row])).toContain("'=HYPERLINK()");
  });
});

async function academicRead<T>(fn: (db: ScopedDb) => Promise<T>) {
  return engine.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_organization_id','uni',true)");
    return fn(scoped(tx));
  });
}

describe('Academic support decisions', () => {
  const reg = 'university-registrar',
    teach = 'university-instructor',
    access = 'university-accessibility-officer';
  const staff = (key: string, input: Record<string, string>, role = reg, user = 'registrar') =>
    act(academicSupportOffice, key, input, role, user);
  const eligible = () =>
    academicRead((db) => checkRegistrationEligibility(db, 'uni', 'learner', 'section'));
  it('enforces holds, leave intervals, prerequisites and recognized transfer credit through registrar eligibility checks', async () => {
    expect(await eligible()).toBe(true);
    const { id } = await staff('place-hold', {
      program: 'enrol',
      scope: 'BOTH',
      message: 'Contact the registrar',
    });
    expect(await eligible()).toBe(false);
    expect(await academicRead((db) => checkConferralEligibility(db, 'uni', 'enrol'))).toBe(false);
    await staff('release-hold', { hold: String(id), reference: 'Released by registrar' });
    const leave = await staff('approve-leave', {
      program: 'enrol',
      starts: '2024-06-01',
      expected: '2024-10-01',
      reference: 'Leave minute',
    });
    expect(await eligible()).toBe(false);
    await staff('return-to-study', {
      leave: String(leave.id),
      returned: '2024-09-15',
      reference: 'Restored original curriculum',
    });
    expect(await eligible()).toBe(true);
    await staff('add-prerequisite', { course: 'advanced', prerequisite: 'basic' });
    await expect(
      staff('add-prerequisite', { course: 'basic', prerequisite: 'advanced' })
    ).rejects.toThrow('acyclic');
    expect(await eligible()).toBe(false);
    await staff('recognize-credit', {
      program: 'enrol',
      course: 'basic',
      kind: 'TRANSFER',
      source: 'Transfer institution transcript, Intro 1',
      evidence: 'Academic board decision',
    });
    expect(await eligible()).toBe(true);
    expect(await academicRead((db) => readTransferCredits(db, 'uni', 'enrol'))).toEqual([
      {
        course_id: 'basic',
        mark: null,
        source: 'Transfer institution transcript, Intro 1',
        substitute_course_id: null,
      },
    ]);
  }, 30000);
  it('assigns advisors and restricts clinical evidence while applying exam adjustments and attendance to the correct student', async () => {
    await staff('assign-advisor', { program: 'enrol', advisor: 'advisor' });
    const details = { assessment: 'Midterm', day: '2025-04-02', start: '09:00', end: '10:00' };
    const exam = await staff('schedule-exam', { ...details, section: 'section', room: 'Room A' });
    await expect(
      staff('schedule-exam', { ...details, section: 'section2', room: 'room a' })
    ).rejects.toThrow('conflicts');
    const record = await staff(
      'record-accommodation',
      { program: 'enrol', evidence: 'PRIVATE EVIDENCE' },
      access,
      'access'
    );
    await staff(
      'exam-adjustment',
      {
        caseId: String(record.id),
        exam: String(exam.id),
        minutes: '30',
        instruction: 'Allow additional working time',
      },
      access,
      'access'
    );
    await expect(
      staff('schedule-exam', {
        ...details,
        section: 'section2',
        room: 'Room A',
        start: '10:00',
        end: '10:30',
      })
    ).rejects.toThrow('conflicts');
    await expect(
      staff(
        'attendance',
        { exam: String(exam.id), person: 'learner', status: 'PRESENT' },
        teach,
        'otherTeacher'
      )
    ).rejects.toThrow();
    await staff(
      'attendance',
      { exam: String(exam.id), person: 'learner', status: 'PRESENT' },
      teach,
      'instructor'
    );
    const learner = await academicRead((db) => readLearnerSupport(db, 'uni', 'learner'));
    expect(learner.advisors[0]).toMatchObject({ advisor: 'Assigned advisor' });
    expect(learner.exams[0]).toMatchObject({ additional_minutes: 30, attendance: 'PRESENT' });
    expect(JSON.stringify(learner)).not.toContain('PRIVATE EVIDENCE');
    const staffRows = async (roleKey: string, userId: string) =>
      academicRead((db) =>
        academicSupportOffice.read({ db, organizationId: 'uni', admin: false, roleKey, userId })
      );
    expect(JSON.stringify(await staffRows(teach, 'instructor'))).toContain(
      'Allow additional working time'
    );
    expect(JSON.stringify(await staffRows(teach, 'instructor'))).not.toContain('PRIVATE EVIDENCE');
    expect(JSON.stringify(await staffRows(teach, 'otherTeacher'))).not.toContain(
      'Allow additional working time'
    );
    expect(JSON.stringify(await staffRows(access, 'access'))).toContain('PRIVATE EVIDENCE');
    const generalAdmin = {
      organizationId: 'uni',
      userId: 'registrar',
      roleKey: 'university-admin',
      admin: true,
    };
    expect(
      JSON.stringify(
        await academicRead((db) => academicSupportOffice.read({ ...generalAdmin, db }))
      )
    ).not.toContain('PRIVATE EVIDENCE');
    const caseAction = academicSupportOffice.actions.find(
      (action) => action.key === 'record-accommodation'
    )!;
    await expect(
      academicRead((db) =>
        caseAction.run({ ...generalAdmin, db }, { program: 'enrol', evidence: 'new evidence' })
      )
    ).rejects.toThrow('designated accessibility');
  });
});

it('re-evaluates an internal course substitution after an approved grade amendment', async () => {
  await engine.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_organization_id','uni',true)");
    await tx.query(
      "INSERT INTO university_enrollments (organization_id,id,person_id,section_id,status) VALUES ('uni','elective-result','learner','section2','ENROLLED')"
    );
    await tx.query(
      "INSERT INTO university_grades (organization_id,enrollment_id,revision,mark,status,submitted_by,approved_by,published_at) VALUES ('uni','elective-result',1,76,'PUBLISHED','otherTeacher','registrar',now())"
    );
  });
  await act(
    academicSupportOffice,
    'recognize-credit',
    {
      program: 'enrol',
      course: 'advanced',
      kind: 'SUBSTITUTION',
      substitute: 'otherCourse',
      source: 'Approved elective substitution',
      evidence: 'Curriculum committee minutes',
    },
    'university-registrar',
    'registrar'
  );
  const credits = () => academicRead((db) => readTransferCredits(db, 'uni', 'enrol'));
  expect(await credits()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        course_id: 'advanced',
        mark: 76,
        substitute_course_id: 'otherCourse',
      }),
    ])
  );
  await engine.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_organization_id','uni',true)");
    await tx.query(
      "INSERT INTO university_grades(organization_id,enrollment_id,revision,mark,status,submitted_by,approved_by,published_at) VALUES ('uni','elective-result',2,42,'PUBLISHED','otherTeacher','registrar',now())"
    );
  });
  expect((await credits()).some((row) => row.course_id === 'advanced')).toBe(false);
});
