// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canPerformOfficeAction, type StaffContext } from './access';
import type { UniversityOffice } from './office-types';
import { eventModule } from './events';

const pg = new PGlite();
beforeAll(async () => {
  await pg.exec(`
    CREATE TYPE "OrganizationVertical" AS ENUM ('AGENCY');
    CREATE TABLE organizations(id text PRIMARY KEY, timezone text DEFAULT 'Asia/Karachi');
    CREATE TABLE users("organizationId" text, id text, status text, PRIMARY KEY("organizationId",id));
    CREATE TABLE api_tokens("organizationId" text,id text PRIMARY KEY,scopes text[]);
  `);
  for (const migration of readdirSync('prisma/migrations')
    .filter((s) => s.includes('_university_'))
    .sort()) {
    await pg.exec(readFileSync('prisma/migrations/' + migration + '/migration.sql', 'utf8'));
  }
  await pg.exec(`
    INSERT INTO organizations(id) VALUES ('university-a'),('university-b');
    INSERT INTO users VALUES ('university-a','officer','ACTIVE'),('university-b','officer','ACTIVE');
    INSERT INTO university_campuses(organization_id,id,name,recognition_ref) VALUES
      ('university-a','main','Main','QA-main'),('university-a','north','North','QA-north'),('university-b','main','Other','QA-other');
    INSERT INTO university_units(organization_id,campus_id,id,name,level,parent_id) VALUES
      ('university-a','main','engineering','Engineering','FACULTY',null),
      ('university-a','main','electronics','Electronics','DEPARTMENT','engineering'),
      ('university-a','main','arts','Arts','FACULTY',null);
    INSERT INTO university_programs(organization_id,id,campus_id,name,code,pqr_reference,accreditation_reference,valid_from,valid_to,unit_id) VALUES
      ('university-a','engineering-bs','main','Engineering','BE','QR-1','Council','2025-01-01','2029-01-01','electronics'),
      ('university-a','arts-bs','main','Arts','BA','QR-2','Council','2025-01-01','2029-01-01','arts'),
      ('university-a','north-bs','north','Business','BB','QR-3','Council','2025-01-01','2029-01-01',null),
      ('university-b','another-bs','main','Business','BB','QR-3','Council','2025-01-01','2029-01-01',null);
    INSERT INTO university_staff_scopes(organization_id,user_id,level,campus_id,unit_id) VALUES
      ('university-a','officer','UNIT','main','engineering'),('university-a','officer','CAMPUS','north',null);
    CREATE ROLE university_scope_fixture;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO university_scope_fixture;
    SET ROLE university_scope_fixture;
    SELECT set_config('app.current_organization_id','university-a',false),
           set_config('app.current_user_id','officer',false),set_config('app.university_staff_scope','bounded',false);
  `);
}, 120000);
afterAll(async () => {
  await pg.close();
});
describe('university staff coverage', () => {
  it('limits registrar access by institution, campus and faculty, including descendants', async () => {
    await pg.query("SELECT set_config('app.university_office','university-academics',false)");
    expect((await pg.query('SELECT id FROM university_programs ORDER BY id')).rows).toEqual([
      { id: 'engineering-bs' },
      { id: 'north-bs' },
    ]);
    expect(
      (await pg.query("UPDATE university_programs SET name='Updated' WHERE id='arts-bs'"))
        .affectedRows
    ).toBe(0);
  });
  it('a faculty assignment does not convey campus-wide access to service records', async () => {
    await pg.query("SELECT set_config('app.university_office','university-services',false)");
    expect((await pg.query('SELECT id FROM university_campuses ORDER BY id')).rows).toEqual([
      { id: 'north' },
    ]);
    expect((await pg.query('SELECT id FROM university_programs ORDER BY id')).rows).toEqual([
      { id: 'north-bs' },
    ]);
  });
  it('recognizes domain entitlements for individual connector topics', () => {
    expect(eventModule('bank.settlement')).toBe('university-finance');
    expect(eventModule('grade.draft')).toBe('university-academics');
    expect(eventModule('unsupported.topic')).toBeUndefined();
  });
  it('requires the designated person for sensitive reviews and institution coverage for global counts', () => {
    const office: UniversityOffice = {
      title: 'Examinations',
      description: '',
      moduleKey: 'university-academics',
      roles: ['university-registrar'],
      actions: [],
      read: async () => [],
    };
    const restrictiveAction = {
      key: 'review',
      label: 'Review',
      fields: [],
      strictRoles: true,
      roles: ['university-accessibility-officer'],
      run: async () => {},
    };
    const ctx = {
      coverage: 'INSTITUTION',
      admin: true,
      roleKey: 'university-admin',
      rules: [{ capability: 'university:academics', effect: 'ALLOW' }],
      entitlements: { enabledModules: ['university-academics'], vertical: 'UNIVERSITY' },
    } as unknown as StaffContext;
    expect(canPerformOfficeAction(ctx, office, restrictiveAction)).toBe(false);
    expect(
      canPerformOfficeAction(
        { ...ctx, coverage: 'CAMPUS', admin: false, roleKey: 'university-registrar' },
        office,
        {
          ...restrictiveAction,
          key: 'matriculate',
          institutionWide: true,
          strictRoles: false,
          roles: office.roles,
        }
      )
    ).toBe(false);
  });
});
