// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UniversityContext } from './office-types';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  servicesOffice,
  releaseUniversityServicesOnWithdrawal,
  assertUniversityLibraryClearance,
} from './services';

import { communityOffice, readLearnerCommunity, runLearnerCommunityAction } from './community';

const pg = new PGlite();
function sql(parts: TemplateStringsArray) {
  return parts.reduce((out, part, i) => out + (i ? '$' + i : '') + part, '');
}
function context(tx: Transaction, userId = 'clerk', organizationId = 'uni'): UniversityContext {
  const db = {
    $queryRaw: async (parts: TemplateStringsArray, ...params: unknown[]) =>
      (await tx.query(sql(parts), params)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...params: unknown[]) =>
      (await tx.query(sql(parts), params)).affectedRows,
  } as unknown as ScopedDb;
  return { db, userId, organizationId, roleKey: 'university-services-officer', admin: false };
}
async function tenant<T>(operation: (tx: Transaction) => Promise<T>, org = 'uni') {
  return pg.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    return operation(tx);
  });
}
async function act(key: string, input: Record<string, string>, userId = 'clerk') {
  const action = servicesOffice.actions.find((a) => a.key === key)!;
  return tenant(
    async (tx) => (await action.run(context(tx, userId), input)) as Record<string, string>
  );
}
beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE organizations(id text primary key);
    CREATE TABLE users("organizationId" text,id text,status text,PRIMARY KEY("organizationId",id));
    CREATE TABLE university_people(organization_id text,id text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_campuses(organization_id text,id text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_programs(organization_id text,id text,campus_id text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_intakes(organization_id text,id text,program_id text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_sections(organization_id text,id text,label text,intake_id text,instructor_id text,term text,start_minute integer,end_minute integer,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_student_programs(organization_id text,id text,person_id text,status text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_awards(organization_id text,id text,student_program_id text,credential_number text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_award_verifications(organization_id text,id text,award_id text,outcome text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_advising_assignments(organization_id text,student_program_id text,advisor_id text,released_at timestamptz);
    CREATE TABLE university_research_grants(organization_id text,id text,starts_on date,ends_on date,
      budget_minor bigint,currency text,allowed_categories text[],status text,PRIMARY KEY(organization_id,id));
    INSERT INTO organizations VALUES('uni'),('other');
    INSERT INTO university_campuses VALUES('uni','c'),('other','elsewhere');
    INSERT INTO university_people VALUES('uni','a'),('uni','b'),('uni','c'),('uni','d'),('other','z');
    INSERT INTO users VALUES('uni','clerk','ACTIVE'),('uni','officer','ACTIVE'),('uni','teacher','ACTIVE');
    INSERT INTO university_student_programs VALUES('uni','p1','a','ACTIVE'),('uni','p2','b','ACTIVE'),('uni','p3','c','ACTIVE'),('uni','p4','d','ACTIVE');
    INSERT INTO university_awards VALUES('uni','aw1','p1','UNI-27'),('uni','aw2','p2','UNI-28');
    INSERT INTO university_award_verifications VALUES('uni','verify1','aw1','VERIFIED'),('uni','verify2','aw2','VERIFIED');
    INSERT INTO university_advising_assignments VALUES('uni','p1','teacher',null);
    INSERT INTO university_programs VALUES('uni','degree','c');
    INSERT INTO university_intakes VALUES('uni','intake','degree');
    INSERT INTO university_sections VALUES('uni','s1','Maths','intake','teacher','2027-S1',660,720),('uni','s2','Lab','intake','teacher','2027-S1',720,840);
    INSERT INTO university_research_grants VALUES('uni','award','2020-01-01','2099-12-31',10000,'PKR','{BOOKS}','ACTIVE');`);
  for (const m of [
    '20261125090050_university_events',
    '20261125090300_university_finance',
    '20261125090500_university_services',
    '20261125090610_university_grant_procurement_fk',
    '20261125090710_university_community',
  ]) {
    await pg.exec(readFileSync('prisma/migrations/' + m + '/migration.sql', 'utf8'));
  }
  await pg.exec(
    'CREATE ROLE service_test; GRANT USAGE ON SCHEMA public TO service_test; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_test; SET ROLE service_test'
  );
}, 120_000);
afterAll(async () => {
  await pg.close();
});
describe('Campus and workforce operations', () => {
  it('calculates peak occupancy across disjoint bookings, bills once and releases on withdrawal', async () => {
    const resource = await act('create-resource', {
      campusId: 'c',
      kind: 'HOSTEL',
      code: 'NORTH',
      label: 'North hostel',
      capacity: '2',
      feePaisa: '35000',
    });
    const allocate = (personId: string, startsOn: string, endsOn: string) =>
      act('allocate', { personId, resourceId: resource.id, startsOn, endsOn });
    await allocate('a', '2090-01-01', '2090-01-10');
    await allocate('b', '2090-01-11', '2090-01-20');
    const spanning = await allocate('c', '2090-01-01', '2090-01-20');
    await expect(allocate('d', '2090-01-10', '2090-01-11')).rejects.toThrow('full');
    await expect(allocate('a', '2090-01-09', '2090-01-12')).rejects.toThrow('already');
    expect(spanning.chargeReference).toContain('SERVICE-');
    expect(
      await tenant(async (tx) => (await tx.query('SELECT * FROM university_challans')).rows)
    ).toHaveLength(3);
    expect(
      await tenant(async (tx) => releaseUniversityServicesOnWithdrawal(context(tx), 'c'))
    ).toBe(0);
    await tenant(async (tx) => {
      await tx.query(
        "UPDATE university_student_programs SET status='WITHDRAWN' WHERE person_id='c'"
      );
      expect(await releaseUniversityServicesOnWithdrawal(context(tx), 'c')).toBe(1);
      expect(await releaseUniversityServicesOnWithdrawal(context(tx), 'c')).toBe(0);
    });
    await allocate('d', '2090-01-10', '2090-01-11');
    await expect(allocate('c', '2090-02-01', '2090-02-03')).rejects.toThrow('active student');
    expect(
      await tenant(
        async (tx) => (await tx.query('SELECT id FROM university_service_resources')).rows,
        'other'
      )
    ).toHaveLength(0);
  });
  it('prevents simultaneous loans of one barcode and clears the graduating borrower after return', async () => {
    await act('library-loan', {
      personId: 'a',
      barcode: 'BK-1',
      title: 'Botany',
      dueOn: '2090-05-01',
    });
    await expect(
      act('library-loan', { personId: 'b', barcode: 'BK-1', title: 'Botany', dueOn: '2090-05-01' })
    ).rejects.toThrow('available');
    await expect(
      tenant((tx) => assertUniversityLibraryClearance(context(tx), 'a'))
    ).rejects.toThrow('return of 1');
    await act('library-return', { barcode: 'BK-1' });
    expect((await tenant((tx) => assertUniversityLibraryClearance(context(tx), 'a'))).cleared).toBe(
      true
    );
  });
  it('requires assignment and records the resolution of a facilities case', async () => {
    const issue = await act('open-case', {
      campusId: 'c',
      location: 'Lab',
      description: 'Water leak',
      priority: 'URGENT',
    });
    await expect(act('resolve-case', { caseId: issue.id, resolution: 'Repaired' })).rejects.toThrow(
      'assigned'
    );
    await act('assign-case', { caseId: issue.id, staffUserId: 'officer' });
    await act('resolve-case', { caseId: issue.id, resolution: 'Repaired' });
    await expect(act('assign-case', { caseId: issue.id, staffUserId: 'clerk' })).rejects.toThrow(
      'open case'
    );
  });
  it('limits teaching by appointment and term and prorates gross salary for partial months', async () => {
    const app = await act('appointment', {
      staffUserId: 'teacher',
      campusId: 'c',
      reference: 'C-27',
      position: 'Lecturer',
      startsOn: '2027-04-16',
      endsOn: '2027-04-30',
      monthlyPaisa: '3000000',
      weeklyMinutes: '120',
    });
    await act('teaching-load', {
      appointmentId: app.id,
      sectionId: 's1',
      teachingDate: '2027-04-17',
    });
    await expect(
      act('teaching-load', { appointmentId: app.id, sectionId: 's2', teachingDate: '2027-04-17' })
    ).rejects.toThrow('weekly teaching load');
    const payroll = await act('payroll-export', { month: '2027-04' });
    expect(payroll.csv).toContain('"3000000","1500000","PKR"');
    expect(
      (await tenant((tx) => servicesOffice.read({ ...context(tx), admin: true }))).some(
        (r) => r.kind === 'Teaching load'
      )
    ).toBe(true);
  });
  it('enforces independent approval, grant restrictions and remaining commitments', async () => {
    const purchase = (reference: string, category = 'BOOKS') =>
      act('requisition', {
        reference,
        campusId: 'c',
        grantId: 'award',
        category,
        supplier: 'Press',
        description: 'Reference texts',
        amountPaisa: '7000',
        neededOn: '2025-01-01',
      });
    await expect(purchase('BAD', 'TRAVEL')).rejects.toThrow('permit');
    const a = await purchase('PO1'),
      b = await purchase('PO2');
    const decide = (id: string, userId = 'officer') =>
      act('purchase-decision', { requestId: id, decision: 'APPROVED', reason: 'Reviewed' }, userId);
    await expect(decide(a.id, 'clerk')).rejects.toThrow('different officer');
    await decide(a.id);
    await expect(decide(b.id)).rejects.toThrow('remaining award budget');
    await act('receive-purchase', {
      requestId: a.id,
      receiptReference: 'GRN-1',
      receivedOn: '2025-01-04',
    });
    await expect(decide(b.id)).rejects.toThrow('remaining award budget');
    await expect(act('cancel-purchase', { requestId: a.id, reason: 'Change' })).rejects.toThrow(
      'cancelled'
    );
  });
});

function learner(tx: Transaction, person: string): UniversityContext {
  return { ...context(tx, person), roleKey: 'university-learner' };
}
function communityAction(
  key: string,
  input: Record<string, string>,
  roleKey = 'university-services-officer',
  userId = 'clerk'
) {
  const action = communityOffice.actions.find((a) => a.key === key)!;
  return tenant(
    async (tx) =>
      (await action.run({ ...context(tx, userId), roleKey }, input)) as Record<string, string>
  );
}
function learnerAction(person: string, key: string, input: Record<string, string>) {
  return tenant(
    async (tx) =>
      (await runLearnerCommunityAction(learner(tx, person), person, key, input)) as Record<
        string,
        string
      >
  );
}
describe('Learner community operations', () => {
  it('promotes eligible housing applicants in order on release and preserves tenant and subject ownership', async () => {
    const resource = await act('create-resource', {
      campusId: 'c',
      kind: 'HOSTEL',
      code: 'SOUTH',
      label: 'South wing',
      capacity: '1',
      feePaisa: '1200',
    });
    const dates = { resourceId: resource.id, startsOn: '2099-01-01', endsOn: '2099-02-01' };
    const original = await act('allocate', { ...dates, personId: 'a' });
    const first = await learnerAction('b', 'housing-waitlist', dates);
    const next = await learnerAction('d', 'housing-waitlist', dates);
    expect(first.status).toBe('WAITING');
    expect(next.status).toBe('WAITING');
    await expect(learnerAction('a', 'leave-waitlist', { waitlistId: first.id })).rejects.toThrow(
      'your pending housing'
    );
    await act('release', { allocationId: original.allocationId, reason: 'Early release' });
    const promoted = await tenant((tx) => readLearnerCommunity(learner(tx, 'b'), 'b'));
    expect(promoted.housing).toContainEqual(
      expect.objectContaining({ id: first.id, status: 'ALLOCATED' })
    );
    expect(
      (await tenant((tx) => readLearnerCommunity(learner(tx, 'd'), 'd'))).housing
    ).toContainEqual(expect.objectContaining({ id: next.id, status: 'WAITING' }));
    await expect(tenant((tx) => readLearnerCommunity(learner(tx, 'a'), 'b'))).rejects.toThrow(
      'authenticated learner'
    );
  });
  it('issues meal plans and rejects exhausted redemptions while accepting a retry', async () => {
    const plan = await communityAction('create-dining', {
      campusId: 'c',
      name: 'Lunch',
      meals: '1',
      feePaisa: '1400',
    });
    const mem = await communityAction('assign-dining', {
      personId: 'd',
      planId: plan.id,
      startsOn: '2020-01-01',
      endsOn: '2099-01-01',
    });
    const meal = { membershipId: mem.id, reference: 'meal-1' };
    await communityAction('redeem-meal', meal);
    await communityAction('redeem-meal', meal);
    await expect(communityAction('redeem-meal', { ...meal, reference: 'meal-2' })).rejects.toThrow(
      'unavailable'
    );
  });
  it('limits case narratives to the learner, assigned advisor or designated registrar', async () => {
    const advice = await learnerAction('a', 'open-advising', {
      message: 'A private advising note',
    });
    const grievance = await learnerAction('a', 'open-grievance', {
      message: 'A private grievance',
    });
    const read = (roleKey: string, userId: string, admin = false) =>
      tenant((tx) => communityOffice.read({ ...context(tx, userId), roleKey, admin }));
    expect(await read('university-services-officer', 'clerk')).not.toContainEqual(
      expect.objectContaining({ id: advice.id })
    );
    expect(await read('university-admin', 'officer', true)).not.toContainEqual(
      expect.objectContaining({ id: grievance.id })
    );
    expect(await read('university-advisor', 'teacher')).toContainEqual(
      expect.objectContaining({ id: advice.id })
    );
    expect(await read('university-advisor', 'officer')).not.toContainEqual(
      expect.objectContaining({ id: advice.id })
    );
    expect(await read('university-registrar', 'officer')).toContainEqual(
      expect.objectContaining({ id: grievance.id })
    );
    await expect(
      communityAction(
        'resolve-case',
        { caseId: advice.id, resolution: 'Review' },
        'university-advisor',
        'officer'
      )
    ).rejects.toThrow('accessible open');
    await communityAction(
      'resolve-case',
      { caseId: advice.id, resolution: 'Discussion scheduled' },
      'university-advisor',
      'teacher'
    );
    expect(
      (await tenant((tx) => readLearnerCommunity(learner(tx, 'a'), 'a'))).cases
    ).toContainEqual(
      expect.objectContaining({ id: advice.id, resolution: 'Discussion scheduled' })
    );
    expect((await tenant((tx) => readLearnerCommunity(learner(tx, 'b'), 'b'))).cases).toHaveLength(
      0
    );
  });
  it('requires alumni opt-in and binds verification to the requested graduate award', async () => {
    const job = await communityAction('career-opportunity', {
      title: 'Librarian',
      employer: 'Library',
      description: 'Catalog specialist',
      closesOn: '2099-01-01',
    });
    await expect(
      learnerAction('a', 'apply-opportunity', { opportunityId: job.id })
    ).rejects.toThrow('Opt in');
    await learnerAction('a', 'alumni-consent', { consent: 'OPT_IN' });
    await learnerAction('a', 'apply-opportunity', { opportunityId: job.id });
    await learnerAction('a', 'alumni-consent', { consent: 'OPT_OUT' });
    await expect(learnerAction('d', 'alumni-consent', { consent: 'OPT_IN' })).rejects.toThrow(
      'graduates'
    );
    await expect(
      learnerAction('a', 'request-verification', {
        awardId: 'aw2',
        recipient: 'employer@example.org',
      })
    ).rejects.toThrow('own academic');
    const request = await learnerAction('a', 'request-verification', {
      awardId: 'aw1',
      recipient: 'employer@example.org',
    });
    const decision = {
      requestId: request.id,
      decision: 'VERIFIED',
      note: 'Degree confirmed',
      verificationId: 'verify2',
    };
    await expect(
      communityAction('decide-verification', decision, 'university-registrar', 'officer')
    ).rejects.toThrow('same award');
    await communityAction(
      'decide-verification',
      { ...decision, verificationId: 'verify1' },
      'university-registrar',
      'officer'
    );
    const record = await tenant((tx) => readLearnerCommunity(learner(tx, 'a'), 'a'));
    expect(record.opportunities).toHaveLength(0);
    expect(record.verifications).toContainEqual(
      expect.objectContaining({ id: request.id, status: 'VERIFIED' })
    );
  });
});
