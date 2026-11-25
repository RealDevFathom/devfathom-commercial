import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { listFeeDelegations } from '@/lib/university/delegation';
import { PortalError } from '@/lib/university/portal';
import { withDelegationSession } from './access';
import { ConsentForm, RevokeForm } from './forms';

export const dynamic = 'force-dynamic';
export default async function DelegationPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const urdu = (await searchParams).lang === 'ur',
    query = urdu ? '?lang=ur' : '',
    t = (a: string, b: string) => (urdu ? b : a);
  const data = await withDelegationSession(listFeeDelegations).catch((error) => {
    if (error instanceof PortalError && error.status === 401) redirect('/student' + query);
    if (error instanceof PortalError && error.status === 404) notFound();
    throw error;
  });
  return (
    <main dir={urdu ? 'rtl' : 'ltr'} className="mx-auto grid max-w-5xl gap-6 p-4 sm:p-8">
      <PageHeader
        eyebrow={<Link href={'/student' + query}>{t('Student portal', 'طلبہ پورٹل')}</Link>}
        heading={t('Guardian and sponsor access', 'سرپرست اور مالی معاون کی رسائی')}
        description={t(
          'Manage consent and financial information shared with your signed-in account.',
          'اپنے اکاؤنٹ کی رضامندی اور شیئر کردہ مالی معلومات کا انتظام کریں۔'
        )}
      />
      {data.canConsent && (
        <SectionCard title={t('Authorize a recipient', 'وصول کنندہ کو اجازت دیں')}>
          <ConsentForm urdu={urdu} challans={data.challans.map((c) => c.reference)} />
        </SectionCard>
      )}
      {(data.canConsent || data.outgoing.length > 0) && (
        <SectionCard title={t('Access you granted', 'آپ کی دی گئی اجازت')}>
          {!data.outgoing.length ? (
            <p>{t('You have not granted access.', 'آپ نے ابھی رسائی نہیں دی۔')}</p>
          ) : (
            <ul className="grid gap-3">
              {data.outgoing.map((g) => (
                <li
                  key={g.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle py-2"
                >
                  <div>
                    <strong>{g.recipient_email}</strong>
                    <p>
                      {g.challan_reference ?? t('Financial summary', 'مالی خلاصہ')} · {g.ends_on} ·{' '}
                      {g.status === 'ACTIVE'
                        ? t('Active', 'فعال')
                        : g.status === 'EXPIRED'
                          ? t('Expired', 'میعاد ختم')
                          : t('Revoked', 'منسوخ')}
                    </p>
                  </div>
                  {g.status === 'ACTIVE' && <RevokeForm id={g.id} urdu={urdu} />}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      <SectionCard
        title={t('Financial access shared with you', 'آپ کے ساتھ شیئر کردہ مالی معلومات')}
      >
        {!data.incoming.length ? (
          <p>
            {t(
              'No active access has been shared with this email.',
              'اس ای میل کے ساتھ کوئی فعال رسائی شیئر نہیں کی گئی۔'
            )}
          </p>
        ) : (
          <ul className="grid gap-3">
            {data.incoming.map((g) => (
              <li key={g.id} className="border-b border-border-subtle py-2">
                <Link
                  prefetch={false}
                  className="underline"
                  href={'/student/delegations/' + encodeURIComponent(g.id) + query}
                >
                  {g.student_name || t('Student', 'طالب علم')} ·{' '}
                  {g.challan_reference ?? t('Financial summary', 'مالی خلاصہ')}
                </Link>
                <p>
                  {t('Access through', 'رسائی تا تاریخ')} {g.ends_on}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </main>
  );
}
