// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { defaultDepartmentRowsForVertical, roleTemplatesForVertical } from '@/lib/vertical-catalog';
import type { UniversityOffice } from './office-types';
import { assertDisposableRlsDatabase } from '../../../tests/disposable-rls-database';

const url = process.env.TEST_DATABASE_URL;
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const rolledBack = new Error('Successful pilot fixture rollback');

/** Set TEST_DATABASE_URL to a migrated disposable database using its non-owner application role.
 * The real integrated commercial package must have been published by the normal catalog sync.
 * One outer transaction discards all tenant and provider fixtures, even on failure. */
describe.skipIf(!url)('University pilot from application to degree on PostgreSQL', () => {
  it('reconciles a learner, two financial postings, LMS delivery, grades and the issued award', async () => {
    assertDisposableRlsDatabase(url!);
    process.env.DATABASE_URL = url;
    const [
      { withPlatformDb, withOrganizationDefaults },
      { resolveOrganizationEntitlements },
      academic,
      finance,
      integrations,
      access,
      inbound,
    ] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('@/lib/entitlements'),
      import('./academics'),
      import('./finance'),
      import('./events'),
      import('./access'),
      import('./inbound'),
    ]);
    // Restore the failed statement before the tenant helper restores its GUCs;
    // otherwise PostgreSQL's aborted-transaction error masks the failing business operation.
    async function inTenant<T>(tx: ScopedDb, tenant: string, work: (db: ScopedDb) => Promise<T>) {
      await tx.$executeRawUnsafe('SAVEPOINT pilot_tenant');
      return withOrganizationDefaults(tx, tenant, async (db) => {
        try {
          return await work(db);
        } catch (error) {
          await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT pilot_tenant');
          throw error;
        }
      });
    }
    const prefix = 'unipilot-' + randomUUID();
    const org = prefix + '-a',
      other = prefix + '-b',
      person = prefix + '-learner';
    const actors = {
      admin: prefix + '-admin',
      registrar: prefix + '-registrar',
      faculty: prefix + '-faculty',
      examiner: prefix + '-examiner',
      bursar: prefix + '-bursar',
      approver: prefix + '-approver',
    };
    const bindings = [
      [actors.admin, 'university-admin'],
      [actors.registrar, 'university-registrar'],
      [actors.faculty, 'university-instructor'],
      [actors.examiner, 'university-examinations-officer'],
      [actors.bursar, 'university-bursar'],
      [actors.approver, 'university-finance-approver'],
    ] as const;
    try {
      await withPlatformDb(
        async (tx) => {
          const [runtime] = await tx.$queryRaw<
            { bypass: boolean }[]
          >`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname=current_user`;
          expect(runtime.bypass).toBe(false);
          const suite = await tx.platformPackage.findFirstOrThrow({
            where: { key: 'university-integrated', active: true },
          });
          for (const id of [org, other])
            await tx.organization.create({
              data: {
                id,
                slug: id,
                legalName: id,
                displayName: 'Pilot University',
                vertical: 'UNIVERSITY',
                status: 'ACTIVE',
                deploymentMode: 'SHARED',
                currency: 'PKR',
                timezone: 'Asia/Karachi',
                packageId: suite.id,
                seatLimit: 250,
              },
            });
          await inTenant(tx, org, async (db) => {
            await db.organizationDepartment.createMany({
              data: defaultDepartmentRowsForVertical('UNIVERSITY').map((row) => ({
                ...row,
                organizationId: org,
              })),
            });
            for (const [id, key] of bindings) {
              const definition = roleTemplatesForVertical('UNIVERSITY').find(
                (role) => role.key === key
              )!;
              const role = await db.organizationRole.create({
                data: {
                  organizationId: org,
                  key,
                  name: definition.name,
                  isSystem: true,
                  permissions: {
                    create: definition.capabilities.map((capability) => ({
                      organizationId: org,
                      capability,
                      effect: 'ALLOW',
                    })),
                  },
                },
              });
              await db.user.create({
                data: {
                  id,
                  organizationId: org,
                  organizationRoleId: role.id,
                  name: key,
                  email: id + '@example.edu.pk',
                  role: id === actors.admin ? 'ADMIN' : 'EMPLOYEE',
                  department: 'REGISTRY',
                  title: key,
                  status: 'ACTIVE',
                },
              });
              await db.$executeRaw`INSERT INTO university_staff_scopes(organization_id,user_id,level) VALUES(${org},${id},'INSTITUTION')`;
            }
            await db.$executeRaw`INSERT INTO university_people(organization_id,id,email,full_name) VALUES(${org},${person},${person + '@example.edu.pk'},'Pilot Learner')`;
            const entitlements = await resolveOrganizationEntitlements(org, db);
            expect(entitlements.enabledModules).toEqual(
              expect.arrayContaining([
                'university-finance',
                'university-admissions',
                'university-academics',
                'university-services',
              ])
            );
            async function office(
              office: UniversityOffice,
              key: string,
              input: Record<string, string>,
              userId = actors.registrar
            ) {
              await db.$queryRaw`SELECT set_config('app.current_user_id',${userId},true)`;
              const staff = await access.universityStaffContext(db, org, userId, entitlements);
              const action = office.actions.find((a) => a.key === key)!;
              if (!access.canPerformOfficeAction(staff, office, action))
                throw new Error('Staff office refuses this action');
              await access.bindOfficeScope(staff, office);
              return (await action.run(staff, input)) as Record<string, string>;
            }
            async function connector(kind: string, actor: string) {
              const token = await db.apiToken.create({
                data: {
                  organizationId: org,
                  userId: actor,
                  tokenHash: randomUUID(),
                  prefix: 'pilot-' + randomUUID().slice(0, 6),
                  name: 'Pilot ' + kind,
                  scopes: ['university:integrations:read', 'university:integrations:write'],
                },
              });
              await office(
                integrations.integrationOffice,
                'assign-connector',
                { kind, tokenId: token.id },
                actors.admin
              );
              return {
                organizationId: org,
                userId: actor,
                userRole: 'EMPLOYEE' as const,
                scopes: token.scopes,
                tokenId: token.id,
                db,
                entitlements,
              };
            }
            async function asLearner<T>(
              operation: (ctx: {
                db: ScopedDb;
                organizationId: string;
                userId: string;
              }) => Promise<T>
            ) {
              await db.$queryRaw`SELECT set_config('app.current_user_id','',true),set_config('app.university_staff_scope','',true),set_config('app.university_office','',true)`;
              return operation({ db, organizationId: org, userId: person });
            }
            const campus = await office(academic.admissionsOffice, 'create-campus', {
              name: 'Pilot campus',
              recognition: 'HEC pilot',
            });
            const program = await office(academic.admissionsOffice, 'create-program', {
              campusId: campus.id,
              name: 'Computing',
              code: 'CS',
              pqr: 'PQR fixture',
              accreditation: 'Accreditation fixture',
              validFrom: day(-100),
              validTo: day(900),
            });
            const intake = await office(academic.admissionsOffice, 'create-intake', {
              programId: program.id,
              label: 'Pilot intake',
              version: 'CUR-1',
              credits: '3',
              passMark: '50',
              capacity: '10',
              schoolWeight: '60',
              meritVersion: 'MERIT-1',
              tuitionPaisa: '1234500',
              opens: day(-7),
              closes: day(1),
              starts: day(2),
            });
            const course = await office(academic.admissionsOffice, 'add-course', {
              intakeId: intake.id,
              code: 'CS101',
              name: 'Foundations',
              credits: '3',
              requirement: 'Required',
            });
            await office(academic.admissionsOffice, 'approve-intake', { intakeId: intake.id });
            const application = await asLearner((ctx) =>
              academic.submitApplication(ctx, person, intake.id, 'HSSC')
            );
            await office(academic.admissionsOffice, 'assess', {
              applicationId: application.id,
              score: '80',
              entryScore: '90',
              qualification: 'HSSC',
            });
            await office(academic.admissionsOffice, 'publish-merit', { intakeId: intake.id });
            const offer = await office(academic.admissionsOffice, 'offer', { intakeId: intake.id });
            expect(offer.id).toBe(application.id);
            const [rank] = await db.$queryRaw<
              { version: number; formula: string; score: number; rank: number }[]
            >`SELECT m.version,m.formula_version AS formula,a.merit_score::float8 AS score,a.offered_rank AS rank
          FROM university_applications a JOIN university_merit_lists m ON (a.organization_id,a.offered_list_id)=(m.organization_id,m.id) WHERE a.organization_id=${org} AND a.id=${offer.id}`;
            expect(rank).toEqual({ version: 1, formula: 'MERIT-1', score: 84, rank: 1 });
            await asLearner((ctx) => academic.acceptStudentOffer(ctx, person, offer.id));
            const record = await office(academic.admissionsOffice, 'matriculate', {
              applicationId: offer.id,
            });
            const challan = 'MATR-' + record.id;
            const collection = await connector('bank.collection', actors.bursar);
            const settle = await connector('bank.settlement', actors.bursar);
            const gl = await connector('finance.gl-acknowledgment', actors.approver);
            const payment = {
              provider: 'Pilot Bank',
              transactionId: 'Bank-001',
              amountPaisa: 1234500,
            };
            const parsed = inbound.universityCommandSchema.parse({
              version: 1,
              kind: 'bank.collection',
              externalId: 'line-1',
              payload: { ...payment, reference: challan, valueDate: day(0) },
            });
            expect((await inbound.runUniversityCommand(collection, parsed)).replayed).toBe(false);
            expect((await inbound.runUniversityCommand(collection, parsed)).replayed).toBe(true);
            await inbound.runUniversityCommand(
              settle,
              inbound.universityCommandSchema.parse({
                version: 1,
                kind: 'bank.settlement',
                externalId: 'settlement-1',
                payload: { ...payment, date: day(0), settlement: 'Settlement-1' },
              })
            );
            const postings = await db.$queryRaw<
              { entry_key: string; kind: string; amount: number }[]
            >`SELECT entry_key,kind,amount_paisa::int AS amount FROM university_finance_entries WHERE organization_id=${org} AND reference=${challan} ORDER BY kind`;
            expect(postings.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
              { kind: 'CHARGE', amount: 1234500 },
              { kind: 'PAYMENT', amount: 1234500 },
            ]);
            for (const posting of postings)
              await inbound.runUniversityCommand(
                gl,
                inbound.universityCommandSchema.parse({
                  version: 1,
                  kind: 'finance.gl-acknowledgment',
                  externalId: 'ack-' + posting.kind,
                  payload: {
                    entry: posting.entry_key,
                    journal: 'J-' + posting.kind,
                    amountPaisa: posting.amount,
                  },
                })
              );
            expect((await finance.readStudentFinance(db, org, person))[0].balancePaisa).toBe(0);
            const section = await office(academic.academicsOffice, 'create-section', {
              courseId: course.id,
              instructorId: actors.faculty,
              term: 'Pilot term',
              label: 'A',
              room: 'Hall A',
              weekday: '2',
              startMinute: '600',
              endMinute: '660',
              capacity: '5',
            });
            const enrollment = await asLearner((ctx) =>
              academic.registerStudent(ctx, person, section.id)
            );
            const lms = await connector('student.registered', actors.registrar);
            const { permitsUniversityDelivery } = await import('./delivery-access');
            expect(await permitsUniversityDelivery(lms, 'student.registered')).toBe(true);
            const [roster] = await db.$queryRaw<
              {
                id: string;
                payload: { enrollmentId: string; personId: string; sectionId: string };
              }[]
            >`SELECT e.id,e.payload FROM university_events e JOIN university_connector_topics t USING(organization_id,kind)
          WHERE e.organization_id=${org} AND e.kind='student.registered' AND t.token_id=${lms.tokenId} AND e.status='PENDING'`;
            expect(roster.payload).toMatchObject({
              enrollmentId: enrollment.id,
              personId: person,
              sectionId: section.id,
            });
            await integrations.recordEventReceipt(
              lms,
              roster.id,
              'FAILED',
              'LMS fixture unavailable'
            );
            const failed = await db.$queryRaw<
              { status: string }[]
            >`SELECT status FROM university_events WHERE organization_id=${org} AND id=${roster.id}`;
            expect(failed[0].status).toBe('FAILED');
            await office(
              integrations.integrationOffice,
              'replay',
              { eventId: roster.id },
              actors.admin
            );
            await integrations.recordEventReceipt(lms, roster.id, 'ACKNOWLEDGED', 'LMS roster v1');
            const gradeConnector = await connector('grade.draft', actors.faculty);
            const grade = await inbound.runUniversityCommand(
              gradeConnector,
              inbound.universityCommandSchema.parse({
                kind: 'grade.draft',
                version: 1,
                externalId: 'grade-1',
                payload: { enrollmentId: enrollment.id, mark: 82 },
              })
            );
            const draft = grade.result as { id: string; status: string };
            expect(draft.status).toBe('DRAFT');
            await expect(
              office(
                academic.academicsOffice,
                'publish-grade',
                { gradeId: draft.id },
                actors.faculty
              )
            ).rejects.toThrow('Staff office refuses');
            await office(
              academic.academicsOffice,
              'publish-grade',
              { gradeId: draft.id },
              actors.examiner
            );
            const transcript = await office(academic.academicsOffice, 'issue-transcript', {
              studentProgramId: record.id,
            });
            const award = await office(academic.academicsOffice, 'confer', {
              studentProgramId: record.id,
              credential: 'PILOT-001',
            });
            const verified = await asLearner(() => academic.readStudentAcademics(db, org, person));
            expect(verified.transcripts.some((t) => t.id === transcript.id)).toBe(true);
            expect(verified.awards).toEqual([
              expect.objectContaining({ id: award.id, credential_number: 'PILOT-001' }),
            ]);
            expect(verified.programs[0].status).toBe('GRADUATED');
            const [reconciliation] = await db.$queryRaw<
              { bank: string; gl: number; lms: string; distinct_approval: boolean }[]
            >`SELECT
          (SELECT status FROM university_bank_receipts WHERE organization_id=${org} AND transaction_id='Bank-001') AS bank,
          (SELECT count(*)::int FROM university_finance_gl_acknowledgments WHERE organization_id=${org}) AS gl,
          (SELECT status FROM university_events WHERE organization_id=${org} AND id=${roster.id}) AS lms,
          (SELECT submitted_by=${actors.faculty} AND approved_by=${actors.examiner} FROM university_grades WHERE organization_id=${org} AND id=${draft.id}) AS distinct_approval`;
            expect(reconciliation).toEqual({
              bank: 'SETTLED',
              gl: 2,
              lms: 'ACKNOWLEDGED',
              distinct_approval: true,
            });
          });
          await inTenant(tx, other, async (db) => {
            expect((await academic.readStudentAcademics(db, org, person)).awards).toEqual([]);
            expect(
              await db.$queryRaw`SELECT entry_key FROM university_finance_entries WHERE organization_id=${org}`
            ).toEqual([]);
          });
          throw rolledBack;
        },
        { timeout: 75000 }
      );
      throw new Error('Pilot fixture committed unexpectedly.');
    } catch (error) {
      if (error !== rolledBack) throw error;
    }
  }, 90000);
});
