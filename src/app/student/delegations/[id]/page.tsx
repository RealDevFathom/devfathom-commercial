import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { readDelegatedFees, DelegationError } from '@/lib/university/delegation';
import { PortalError } from '@/lib/university/portal';
import { withDelegationSession } from '../access';

export const dynamic = 'force-dynamic';
function money(paisa: string) {
  const value = BigInt(paisa),
    abs = value < BigInt(0) ? -value : value;
  return (
    'PKR ' +
    (value < BigInt(0) ? '-' : '') +
    new Intl.NumberFormat('en-PK').format(abs / BigInt(100)) +
    '.' +
    (abs % BigInt(100)).toString().padStart(2, '0')
  );
}
export default async function SharedFinancialPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { id } = await params,
    urdu = (await searchParams).lang === 'ur',
    query = urdu ? '?lang=ur' : '',
    t = (en: string, ur: string) => (urdu ? ur : en);
  const result = await withDelegationSession((ctx) => readDelegatedFees(ctx, id)).catch((error) => {
    if (error instanceof PortalError && error.status === 401) redirect('/student' + query);
    if (error instanceof DelegationError || (error instanceof PortalError && error.status === 404))
      notFound();
    throw error;
  });
  const details =
    result.permission === 'SPECIFIC_CHALLAN'
      ? [
          [t('Reference', 'حوالہ'), result.challan.reference],
          [t('Fee type', 'فیس کی قسم'), result.challan.fee_head],
          [t('Challan amount', 'چالان کی رقم'), money(result.challan.amount_paisa)],
          [t('Balance', 'بقایا'), money(result.challan.balance_paisa)],
          [t('Due date', 'آخری تاریخ'), result.challan.due_date],
        ]
      : [
          [t('Account balance', 'اکاؤنٹ بیلنس'), money(result.summary.balance_paisa)],
          [t('Overdue balance', 'واجب الادا رقم'), money(result.summary.overdue_paisa)],
          [t('Open challans', 'کھلے چالان'), String(result.summary.open_challans)],
        ];
  return (
    <main dir={urdu ? 'rtl' : 'ltr'} className="mx-auto grid max-w-4xl gap-6 p-4 sm:p-8">
      <PageHeader
        eyebrow={
          <Link href={'/student/delegations' + query}>
            {t('Guardian and sponsor access', 'سرپرست اور مالی معاون کی رسائی')}
          </Link>
        }
        heading={
          result.permission === 'SPECIFIC_CHALLAN'
            ? t('Shared challan', 'شیئر کردہ چالان')
            : t('Shared financial summary', 'شیئر کردہ مالی خلاصہ')
        }
      />
      <SectionCard title={t('Authorized financial information', 'مجاز مالی معلومات')}>
        <dl className="grid gap-2">
          {details.map(([label, value]) => (
            <div
              key={label}
              className="flex flex-wrap justify-between gap-2 border-b border-border-subtle py-2"
            >
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
    </main>
  );
}
