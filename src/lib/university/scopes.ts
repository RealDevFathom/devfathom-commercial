import type { UniversityOffice } from './office-types';

const field = (name: string, label: string, required = true) => ({ name, label, required });

export const scopesOffice: UniversityOffice = {
  title: 'Faculties and staff access',
  description:
    'Organize academic departments and assign the campuses or units each staff member may administer.',
  moduleKey: 'university-core',
  roles: ['university-admin'],
  read: async (ctx) => {
    const units = await ctx.db.$queryRaw<
      Record<string, unknown>[]
    >`SELECT u.id,u.name,u.level,c.name AS campus,u.parent_id FROM university_units u JOIN university_campuses c ON (c.organization_id,c.id)=(u.organization_id,u.campus_id) WHERE u.organization_id=${ctx.organizationId} ORDER BY c.name,u.name`;
    const grants = await ctx.db.$queryRaw<
      Record<string, unknown>[]
    >`SELECT s.id,s.user_id,w.name AS staff,s.level,c.name AS campus,u.name AS unit FROM university_staff_scopes s JOIN users w ON (w."organizationId",w.id)=(s.organization_id,s.user_id) LEFT JOIN university_campuses c ON (c.organization_id,c.id)=(s.organization_id,s.campus_id) LEFT JOIN university_units u ON (u.organization_id,u.id)=(s.organization_id,s.unit_id) WHERE s.organization_id=${ctx.organizationId} ORDER BY w.name,s.level LIMIT 500`;
    return [...units, ...grants];
  },
  actions: [
    {
      key: 'create-unit',
      label: 'Create a faculty or department',
      fields: [
        field('campusId', 'Campus ID'),
        field('name', 'Name'),
        field('facultyId', 'Parent faculty ID for a department', false),
      ],
      run: async (ctx, input) => {
        const parent = input.facultyId || null;
        const rows = await ctx.db
          .$queryRaw`INSERT INTO university_units(organization_id,campus_id,name,level,parent_id)
          SELECT ${ctx.organizationId}, c.id, ${input.name}, ${parent ? 'DEPARTMENT' : 'FACULTY'}, ${parent}
          FROM university_campuses c WHERE c.organization_id=${ctx.organizationId} AND c.id=${input.campusId}
          AND (${parent}::text IS NULL OR EXISTS(SELECT FROM university_units u WHERE u.organization_id=c.organization_id AND u.campus_id=c.id AND u.id=${parent} AND u.level='FACULTY'))
          RETURNING id,name,level`;
        if (!(rows as unknown[]).length) throw new Error('Check the campus and parent faculty.');
        return rows;
      },
    },
    {
      key: 'assign-program',
      label: 'Assign program to a department',
      fields: [field('programId', 'Program ID'), field('unitId', 'Department ID')],
      run: async (ctx, input) => {
        const count = await ctx.db
          .$executeRaw`UPDATE university_programs p SET unit_id=u.id FROM university_units u WHERE p.organization_id=${ctx.organizationId} AND p.id=${input.programId} AND u.organization_id=p.organization_id AND u.campus_id=p.campus_id AND u.id=${input.unitId} AND u.level='DEPARTMENT'`;
        if (count !== 1) throw new Error('Choose a department on the program’s campus.');
        return { programId: input.programId, unitId: input.unitId };
      },
    },
    {
      key: 'grant-scope',
      label: 'Assign staff coverage',
      fields: [
        field('userId', 'Staff user ID'),
        {
          name: 'level',
          label: 'Coverage',
          options: ['INSTITUTION', 'CAMPUS', 'UNIT'],
          required: true,
        },
        field('campusId', 'Campus ID for campus or unit coverage', false),
        field('unitId', 'Faculty or department ID for unit coverage', false),
      ],
      run: async (ctx, input) => {
        const campus = input.campusId || null,
          unit = input.unitId || null;
        if (
          (input.level === 'INSTITUTION' && (campus || unit)) ||
          (input.level === 'CAMPUS' && (!campus || unit)) ||
          (input.level === 'UNIT' && (!campus || !unit))
        )
          throw new Error('Choose the campus and unit that match the coverage.');
        return ctx.db
          .$queryRaw`INSERT INTO university_staff_scopes (organization_id,user_id,level,campus_id,unit_id)
         VALUES (${ctx.organizationId},${input.userId},${input.level},${campus},${unit})
         ON CONFLICT (organization_id,user_id,level,campus_id,unit_id) DO UPDATE SET level=excluded.level RETURNING id,level`;
      },
    },
    {
      key: 'revoke-scope',
      label: 'Remove staff coverage',
      fields: [field('scopeId', 'Coverage ID')],
      run: async (ctx, input) => {
        if (
          (await ctx.db
            .$executeRaw`DELETE FROM university_staff_scopes WHERE organization_id=${ctx.organizationId} AND id=${input.scopeId}`) !==
          1
        )
          throw new Error('Coverage was not found.');
        return { removed: input.scopeId };
      },
    },
  ],
};
