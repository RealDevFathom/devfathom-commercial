import type { UniversityContext } from './office-types';

/** Search within the same grants and RLS transaction as the office registry. */
export async function lookupUniversityRecords(
  ctx: UniversityContext,
  office: string,
  query: string
) {
  const needle = query.trim().slice(0, 120).toLowerCase();
  if (needle.length < 2) return [];
  if (office === 'admissions')
    return ctx.db.$queryRaw<Record<string, unknown>[]>`
    SELECT a.id AS application_id, a.person_id, p.full_name, i.label AS intake, a.status
      FROM university_applications a JOIN university_people p ON(p.organization_id,p.id)=(a.organization_id,a.person_id)
      JOIN university_intakes i ON(i.organization_id,i.id)=(a.organization_id,a.intake_id)
     WHERE a.organization_id=${ctx.organizationId} AND (starts_with(lower(p.full_name),${needle}) OR starts_with(lower(p.email),${needle}) OR p.id=${needle} OR a.id=${needle})
     ORDER BY p.full_name,a.id LIMIT 50`;
  if (office === 'academics')
    return ctx.db.$queryRaw<Record<string, unknown>[]>`
    SELECT e.id AS enrollment_id, p.id AS person_id, p.full_name, s.id AS section_id, s.label AS section, e.status
      FROM university_enrollments e JOIN university_people p ON(p.organization_id,p.id)=(e.organization_id,e.person_id)
      JOIN university_sections s ON(s.organization_id,s.id)=(e.organization_id,e.section_id)
     WHERE e.organization_id=${ctx.organizationId} AND (${ctx.roleKey !== 'university-instructor'} OR s.instructor_id=${ctx.userId})
       AND (starts_with(lower(p.full_name),${needle}) OR starts_with(lower(s.label),${needle}) OR p.id=${needle} OR e.id=${needle} OR s.id=${needle})
     ORDER BY p.full_name,s.label,e.id LIMIT 50`;
  if (office === 'finance')
    return ctx.db.$queryRaw<Record<string, unknown>[]>`
    SELECT c.reference, c.person_id, p.full_name, c.fee_head, c.amount_paisa, c.due_date
      FROM university_challans c JOIN university_people p ON(p.organization_id,p.id)=(c.organization_id,c.person_id)
     WHERE c.organization_id=${ctx.organizationId} AND (starts_with(lower(p.full_name),${needle}) OR starts_with(lower(c.reference),${needle}) OR p.id=${needle})
     ORDER BY p.full_name,c.reference LIMIT 50`;
  return [];
}
