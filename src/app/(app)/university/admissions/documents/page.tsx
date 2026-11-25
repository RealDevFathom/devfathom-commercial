import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  withUniversityStaff,
  canAccessOffice,
  UniversityAccessError,
} from '@/lib/university/access';
import { admissionsOffice } from '@/lib/university/academics';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ person?: string }>;
}) {
  const { person } = await searchParams;
  const documents = await withUniversityStaff(async (ctx) => {
    if (!canAccessOffice(ctx, admissionsOffice)) throw new UniversityAccessError();
    return ctx.db.$queryRaw<
      { id: string; person_id: string; full_name: string; label: string; filename: string }[]
    >`SELECT d.id,p.id AS person_id,p.full_name,d.label,d.filename FROM university_documents d JOIN university_people p ON (p.organization_id,p.id)=(d.organization_id,d.person_id) WHERE d.organization_id=${ctx.organizationId} AND d.complete AND (${person ?? null}::text IS NULL OR p.id=${person ?? null}) ORDER BY d.created_at DESC LIMIT 250`;
  }).catch((e) => {
    if (e instanceof UniversityAccessError) notFound();
    throw e;
  });
  return (
    <main className="space-y-4">
      <PageHeader eyebrow="Admissions" heading="Application documents" />
      <SectionCard title="Review applicant identity">
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label>
            Applicant person ID
            <Input name="person" defaultValue={person} className="min-h-11" maxLength={128} />
          </label>
          <Button type="submit" className="min-h-11">
            Find applicant
          </Button>
        </form>
        {person && (
          <Link
            className="underline"
            href={'/university/admissions/documents/identity/' + encodeURIComponent(person)}
          >
            Inspect applicant evidence
          </Link>
        )}
      </SectionCard>
      <SectionCard title="Submitted documents">
        {!documents.length && <p>No documents are available.</p>}
        <ul className="space-y-3">
          {documents.map((d) => (
            <li key={d.id}>
              <span>
                <Link
                  className="underline"
                  href={
                    '/university/admissions/documents/identity/' + encodeURIComponent(d.person_id)
                  }
                >
                  {d.full_name}
                </Link>{' '}
                · {d.label} ·{' '}
              </span>
              <a
                download
                className="underline"
                href={
                  '/university/admissions/documents/' +
                  encodeURIComponent(d.id) +
                  '?person=' +
                  encodeURIComponent(d.person_id)
                }
              >
                {d.filename}
              </a>
            </li>
          ))}
        </ul>
      </SectionCard>
    </main>
  );
}
