import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { getPortalHome, PortalError } from '@/lib/university/portal';
import { PrintDocument } from '../../../apply/portal-forms';
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { id } = await params,
    ur = (await searchParams).lang === 'ur',
    t = (en: string, u: string) => (ur ? u : en);
  const home = await getPortalHome('student').catch((e) => {
    if (e instanceof PortalError) notFound();
    throw e;
  });
  const row = home.academics?.transcripts.find((c) => c.id === id);
  if (!row) notFound();
  const s = row.snapshot,
    cohort = (s.cohort ?? {}) as Record<string, unknown>,
    courses = (Array.isArray(s.courses) ? s.courses : []) as Record<string, unknown>[];
  const terms = Array.isArray(s.term_gpas)
    ? (s.term_gpas as { term: string; gpa: number | null; credits: number }[])
    : [];
  const progress = (s.progress ?? {}) as { earnedCredits?: number; requiredCredits?: number };
  const transfers = Array.isArray(s.transfers) ? (s.transfers as Record<string, unknown>[]) : [];
  return (
    <main
      id="main-content"
      lang={ur ? 'ur' : 'en'}
      dir={ur ? 'rtl' : 'ltr'}
      className="mx-auto grid max-w-4xl gap-5 p-5 md:p-9"
    >
      <Link className="underline print:hidden" href={'/student?lang=' + (ur ? 'ur' : 'en')}>
        {t('Student portal', 'طلبہ پورٹل')}
      </Link>
      <PageHeader
        eyebrow={home.institution}
        heading={t('Issued transcript', 'جاری کردہ ٹرانسکرپٹ')}
        description={String(cohort.student ?? '')}
      />
      <SectionCard title={String(cohort.program ?? '')}>
        <p>
          {String(cohort.campus ?? '')} · {String(cohort.cohort ?? '')} ·{' '}
          {String(cohort.curriculum_version ?? '')}
        </p>
        <p>
          {new Date(row.issued_at).toLocaleDateString(ur ? 'ur-PK' : 'en-PK', {
            timeZone: 'Asia/Karachi',
          })}{' '}
          · {row.id}
        </p>
        {Boolean(cohort.roll_number) && (
          <p>
            {t('Roll number', 'رول نمبر')} · <bdi>{String(cohort.roll_number)}</bdi>
          </p>
        )}
        {typeof s.cgpa === 'number' && (
          <p>
            {t('Cumulative GPA', 'مجموعی جی پی اے')} · {s.cgpa}
          </p>
        )}
        {typeof progress.earnedCredits === 'number' && (
          <p>
            {t('Earned credits', 'حاصل شدہ کریڈٹس')} · {progress.earnedCredits} /{' '}
            {progress.requiredCredits}
          </p>
        )}
        {terms.map((term) => (
          <p key={term.term}>
            {term.term} · GPA {term.gpa ?? '—'} · {term.credits} {t('credits', 'کریڈٹس')}
          </p>
        ))}
        {transfers.length > 0 && (
          <p>
            {t('Recognized credits', 'منظور شدہ کریڈٹس')} ·{' '}
            {transfers
              .map((row) =>
                String(row.code ?? row.course_code ?? row.source_reference ?? row.course_id)
              )
              .join(', ')}
          </p>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-start">
            <thead>
              <tr>
                {[
                  t('Course', 'کورس'),
                  t('Term', 'سمسٹر'),
                  t('Credits', 'کریڈٹس'),
                  t('Mark', 'نمبر'),
                ].map((v) => (
                  <th scope="col" className="text-start" key={v}>
                    {v}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {courses.map((c, i) => (
                <tr className="border-b border-border-subtle" key={i}>
                  <td>
                    {String(c.code)} · {String(c.course)}
                  </td>
                  <td>{String(c.term ?? '—')}</td>
                  <td>{String(c.credits ?? '—')}</td>
                  <td>{String(c.mark ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <PrintDocument language={ur ? 'ur' : 'en'} />
    </main>
  );
}
