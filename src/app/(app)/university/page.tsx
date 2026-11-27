import Link from 'next/link';
import { headers } from 'next/headers';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { hasModule } from '@/lib/entitlements';
import { isSharedHost, tenantHostUrl } from '@/lib/tenancy/host-routing';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  canAccessOffice,
  UniversityAccessError,
  withUniversityStaff,
} from '@/lib/university/access';
import { universityOffices } from '@/lib/university/offices';

export default async function UniversityPage() {
  const { offices, admissions } = await withUniversityStaff(async (ctx) => ({
    admissions: hasModule(ctx.entitlements, 'university-admissions'),
    offices: [...universityOffices]
      .filter(([, office]) => canAccessOffice(ctx, office))
      .map(([key, office]) => ({ key, title: office.title, description: office.description })),
  })).catch((error) => {
    if (error instanceof UniversityAccessError) notFound();
    throw error;
  });
  const incoming = await headers();
  const host = incoming.get('x-devfathom-host') ?? incoming.get('host');
  const actor = await resolveTenantActor();
  const portalPath = (path: string) =>
    isSharedHost(host)
      ? tenantHostUrl(actor?.organization.slug ?? '', path, incoming.get('host'))
      : path;
  const studentPath = portalPath('/student');
  const applyPath = admissions ? portalPath('/apply') : null;
  return (
    <>
      <PageHeader
        eyebrow="University"
        heading="University offices"
        description="Open an office to manage its records and decisions."
        actions={
          <>
            {applyPath && (
              <Link href={applyPath} className="underline underline-offset-4">
                Applicant portal
              </Link>
            )}
            {studentPath && (
              <Link href={studentPath} className="underline underline-offset-4">
                Student portal
              </Link>
            )}
          </>
        }
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {offices.map((office) => (
          <SectionCard
            key={office.key}
            title={
              <Link className="underline underline-offset-4" href={`/university/${office.key}`}>
                {office.title}
              </Link>
            }
          >
            <p className="text-sm text-text-muted">{office.description}</p>
          </SectionCard>
        ))}
        {!offices.length && <p>Your administrator can assign access to a university office.</p>}
      </div>
    </>
  );
}
