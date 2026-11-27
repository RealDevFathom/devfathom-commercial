import { notFound } from 'next/navigation';
import Link from 'next/link';
import { portalLabel } from '@/lib/university/portal-labels';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { getPortalHome, PortalError } from '@/lib/university/portal';
import { PrintDocument } from '../../../apply/portal-forms';
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { reference } = await params,
    ur = (await searchParams).lang === 'ur',
    t = (en: string, u: string) => (ur ? u : en);
  const home = await getPortalHome('student').catch((e) => {
    if (e instanceof PortalError) notFound();
    throw e;
  });
  const account = home.finance.find((c) => c.reference === reference);
  if (!account || !home.person) notFound();
  const money = (paisa: number) =>
    new Intl.NumberFormat(ur ? 'ur-PK' : 'en-PK', { style: 'currency', currency: 'PKR' }).format(
      paisa / 100
    );
  const rows = [
    [t('Student', 'طالب علم'), home.person.full_name],
    [t('Challan reference', 'چالان حوالہ'), account.reference],
    [t('Fee category', 'فیس کی قسم'), portalLabel(account.feeHead, ur ? 'ur' : 'en')],
    [t('Due date', 'آخری تاریخ'), account.dueDate],
    [t('Assessed amount', 'مقررہ رقم'), money(account.amountPaisa)],
    [t('Scholarship or sponsorship', 'وظیفہ'), money(account.scholarshipPaisa)],
    [t('Paid', 'ادا شدہ'), money(account.paidPaisa)],
    [t('Refund', 'واپسی'), money(account.refundPaisa)],
    [
      t(
        account.balancePaisa < 0 ? 'Credit balance' : 'Balance due',
        account.balancePaisa < 0 ? 'جمع شدہ رقم' : 'باقی رقم'
      ),
      money(Math.abs(account.balancePaisa)),
    ],
  ];
  if (account.balancePaisa > 0 && account.bankName)
    rows.push(
      [t('Bank', 'بینک'), account.bankName],
      [t('Beneficiary', 'اکاؤنٹ کا نام'), account.beneficiary ?? ''],
      ['IBAN', account.iban ?? '']
    );
  return (
    <main
      id="main-content"
      lang={ur ? 'ur' : 'en'}
      dir={ur ? 'rtl' : 'ltr'}
      className="mx-auto grid max-w-3xl gap-5 p-5 md:p-9"
    >
      <Link className="underline print:hidden" href={'/student?lang=' + (ur ? 'ur' : 'en')}>
        {t('Student portal', 'طلبہ پورٹل')}
      </Link>
      <PageHeader eyebrow={home.institution} heading={t('Fee challan', 'فیس چالان')} />
      <SectionCard>
        <dl className="grid gap-2">
          {rows.map(([label, val]) => (
            <div
              key={label}
              className="flex flex-wrap justify-between gap-2 border-b border-border-subtle py-2"
            >
              <dt>{label}</dt>
              <dd>
                <bdi>{val}</bdi>
              </dd>
            </div>
          ))}
        </dl>
        {account.balancePaisa > 0 && !account.bankName && (
          <p className="mt-3">
            {t(
              'Contact the treasury office for collection instructions.',
              'ادائیگی کی ہدایات کے لیے دفتر خزانہ سے رابطہ کریں۔'
            )}
          </p>
        )}
      </SectionCard>
      <PrintDocument language={ur ? 'ur' : 'en'} />
    </main>
  );
}
