import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  withUniversityStaff,
  canAccessOffice,
  UniversityAccessError,
} from '@/lib/university/access';
import { admissionsOffice } from '@/lib/university/academics';
import { ReviewForm } from './review-form';
export default async function Page({ params }: { params: Promise<{ person: string }> }) {
  const { person } = await params;
  const info = await withUniversityStaff(async (ctx) => {
    if (!canAccessOffice(ctx, admissionsOffice)) throw new UniversityAccessError();
    const [row] = await ctx.db.$queryRaw<
      { full_name: string; identity_kind: string | null; status: string | null }[]
    >`SELECT p.full_name,p.identity_kind,(SELECT kind FROM university_identity_reviews r WHERE r.organization_id=p.organization_id AND r.person_id=p.id AND r.revision=p.identity_revision AND r.kind IN ('VERIFIED','CORRECTION') ORDER BY occurred_at DESC,r.id DESC LIMIT 1) AS status FROM university_people p WHERE organization_id=${ctx.organizationId} AND p.id=${person}`;
    return row ? { row, admin: ctx.admin } : null;
  }).catch((e) => {
    if (e instanceof UniversityAccessError) notFound();
    throw e;
  });
  if (!info) notFound();
  return (
    <main className="space-y-5">
      <PageHeader
        eyebrow="Admissions"
        heading="Identity evidence"
        description={info.row.full_name}
      />
      <SectionCard title={info.row.identity_kind ?? 'No document supplied'}>
        <p>{info.row.status ?? 'Awaiting review'}</p>
        <Link
          className="underline"
          href={'/university/admissions/documents?person=' + encodeURIComponent(person)}
        >
          Supporting documents
        </Link>
      </SectionCard>
      <SectionCard title="Review decision">
        <ReviewForm person={person} admin={info.admin} />
      </SectionCard>
    </main>
  );
}
