import Link from 'next/link';
import { portalLabel } from '@/lib/university/portal-labels';
import { learnerCommunityActions } from '@/lib/university/community';
import { notFound } from 'next/navigation';
import { SectionCard } from '@/components/ui/section-card';
import { PageHeader } from '@/components/ui/page-header';
import { getPortalHome, PortalError } from '@/lib/university/portal';
import { Field, Picker, PortalForm, SignIn, UploadDocument, type Language } from './portal-forms';

type Home = Awaited<ReturnType<typeof getPortalHome>>;
type Translate = (en: string, ur: string) => string;
const translateStatus: Record<string, string> = {
  SUBMITTED: 'جمع ہو گئی',
  ASSESSED: 'جانچ مکمل',
  OFFERED: 'پیشکش',
  ACCEPTED: 'قبول',
  MATRICULATED: 'داخلہ مکمل',
  WAITLISTED: 'انتظار کی فہرست',
  ENROLLED: 'اندراج مکمل',
  WITHDRAWN: 'واپس لے لیا',
  ACTIVE: 'فعال',
  OPEN: 'زیر غور',
  RESOLVED: 'فیصلہ ہو گیا',
  PUBLISHED: 'جاری کر دیا گیا',
  REJECTED: 'مسترد',
};
function Admissions({ home, t, language }: { home: Home; t: Translate; language: Language }) {
  const person = home.person;
  return (
    <>
      {person && (
        <SectionCard title={t('Applicant details', 'درخواست گزار کی تفصیلات')}>
          {person.identity_kind && (
            <p className="mb-3">
              {t('Identity evidence', 'شناختی ثبوت')} ·{' '}
              {person.identity_status === 'VERIFIED'
                ? t('Verified', 'تصدیق شدہ')
                : person.identity_status === 'CORRECTION'
                  ? t('Correction requested', 'اصلاح درکار ہے')
                  : t('Awaiting review', 'تصدیق زیر التوا')}
            </p>
          )}
          <PortalForm
            action="profile"
            label={t('Save details', 'تفصیلات محفوظ کریں')}
            language={language}
          >
            <Field
              name="name"
              label={t('Full legal name', 'مکمل قانونی نام')}
              required
              initial={person.full_name}
              max={160}
            />
            <Field
              name="nationality"
              label={t('Nationality', 'قومیت')}
              initial={person.nationality}
              required
              max={100}
            />
            <Picker
              name="kind"
              label={t('Identity document', 'شناختی دستاویز')}
              initial={person.identity_kind ?? 'CNIC'}
            >
              {['CNIC', 'CRC', 'NICOP', 'PASSPORT'].map((k, i) => (
                <option key={k} value={k}>
                  {['CNIC', 'CRC / B-Form', 'NICOP', t('Passport', 'پاسپورٹ')][i]}
                </option>
              ))}
            </Picker>
            <Field
              name="number"
              label={
                person.identity_kind
                  ? t(
                      'New document number (leave blank to keep existing)',
                      'نیا دستاویز نمبر (موجودہ نمبر رکھنے کے لیے خالی چھوڑیں)'
                    )
                  : t('Document number', 'دستاویز نمبر')
              }
              required={!person.identity_kind}
              max={40}
            />
          </PortalForm>
        </SectionCard>
      )}
      <SectionCard title={t('Open admissions', 'کھلے داخلے')}>
        {!home.intakes.length && (
          <p>{t('There are no open intakes today.', 'آج کسی پروگرام میں داخلے نہیں کھلے۔')}</p>
        )}
        {home.intakes.map((i) => {
          const draft = home.drafts.find((d) => d.intake_id === i.id);
          return (
            <article
              key={i.id}
              className="space-y-2 border-b border-border-subtle py-4 last:border-0"
            >
              <h3 className="font-semibold">
                {i.program} · {i.label}
              </h3>
              <p>
                {i.campus} · {t('Apply by', 'آخری تاریخ')} <bdi>{i.closes_on}</bdi>
              </p>
              {person && (
                <PortalForm
                  action="submit"
                  label={t('Submit application', 'درخواست جمع کریں')}
                  secondary={{ action: 'draft', label: t('Save draft', 'مسودہ محفوظ کریں') }}
                  language={language}
                >
                  <input type="hidden" name="intake" value={i.id} />
                  {i.categories.length > 0 && (
                    <Picker
                      name="category"
                      label={t('Seat category', 'نشست کی قسم')}
                      initial={draft?.category_id ?? 'GENERAL'}
                    >
                      <option value="GENERAL">{t('Open merit', 'اوپن میرٹ')}</option>
                      {i.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </Picker>
                  )}
                  <Field
                    name="qualification"
                    label={t(
                      'Qualification, board, original marks or grades',
                      'اہلیت، بورڈ، اصل نمبر یا گریڈ'
                    )}
                    initial={draft?.qualification}
                    max={1200}
                  />
                  <Field
                    name="equivalence"
                    label={t('Equivalence reference, if applicable', 'مساوات کا حوالہ، اگر ہو')}
                    initial={draft?.equivalence_reference}
                    max={300}
                  />
                </PortalForm>
              )}
            </article>
          );
        })}
      </SectionCard>
      {person && (
        <>
          <SectionCard title={t('Application documents', 'درخواست کی دستاویزات')}>
            <UploadDocument language={language} />
            <ul className="mt-4 space-y-2">
              {home.documents.map((doc) => (
                <li key={doc.id}>
                  <a
                    download
                    className="underline"
                    href={'/apply/documents/' + encodeURIComponent(doc.id)}
                  >
                    {portalLabel(doc.label, language)} · <bdi>{doc.filename}</bdi>
                  </a>
                </li>
              ))}
            </ul>
          </SectionCard>
          <SectionCard title={t('My applications', 'میری درخواستیں')}>
            {!home.applications.length && (
              <p>
                {t(
                  'Your submitted applications will appear here.',
                  'آپ کی جمع شدہ درخواستیں یہاں ظاہر ہوں گی۔'
                )}
              </p>
            )}
            {home.applications.map((a) => (
              <article key={a.id} className="space-y-2 border-b border-border-subtle py-3">
                <h3 className="font-semibold">
                  {a.program} · {a.intake}
                </h3>
                <p>
                  {t(a.status, translateStatus[a.status] ?? a.status)}
                  {a.merit_score !== null
                    ? ' · ' + t('Merit score', 'میرٹ اسکور') + ' ' + a.merit_score
                    : ''}
                </p>
                {a.category && (
                  <p>
                    {t('Seat category', 'نشست کی قسم')} · {a.category}
                  </p>
                )}
                {a.offered_rank !== null && (
                  <p>
                    {t('Offer rank', 'پیشکش کی درجہ بندی')} · {a.offered_rank}
                  </p>
                )}
                {a.appeal_status && (
                  <p>
                    {t('Appeal', 'اپیل')} ·{' '}
                    {t(a.appeal_status, translateStatus[a.appeal_status] ?? a.appeal_status)}
                  </p>
                )}
                {!a.appeal_status && ['ASSESSED', 'REJECTED'].includes(a.status) && (
                  <PortalForm
                    action="appeal-admission"
                    label={t('Appeal decision', 'فیصلے کے خلاف اپیل')}
                    language={language}
                  >
                    <input type="hidden" name="id" value={a.id} />
                    <Field
                      name="reason"
                      label={t('Reason for appeal', 'اپیل کی وجہ')}
                      max={1200}
                      required
                    />
                  </PortalForm>
                )}
                {a.status === 'OFFERED' && (
                  <PortalForm
                    action="accept"
                    label={t('Accept offer', 'پیشکش قبول کریں')}
                    language={language}
                  >
                    <input type="hidden" name="id" value={a.id} />
                  </PortalForm>
                )}
              </article>
            ))}
          </SectionCard>
        </>
      )}
    </>
  );
}
function time(minutes: number) {
  return [Math.floor(minutes / 60), minutes % 60]
    .map((v) => v.toString().padStart(2, '0'))
    .join(':');
}
const pkr = (paisa: number, lang: Language) =>
  new Intl.NumberFormat(lang === 'ur' ? 'ur-PK' : 'en-PK', {
    style: 'currency',
    currency: 'PKR',
  }).format(paisa / 100);

function readable(value: unknown, lang: Language) {
  if (value instanceof Date)
    return value.toLocaleString(lang === 'ur' ? 'ur-PK' : 'en-PK', { timeZone: 'Asia/Karachi' });
  return String(value ?? '—');
}
function SupportAndServices({
  home,
  t,
  language,
}: {
  home: Home;
  t: Translate;
  language: Language;
}) {
  const support = home.support,
    community = home.community;
  const rows: (readonly [string, Record<string, unknown>[]])[] = [
    [t('Examinations', 'امتحانات'), support?.exams ?? []],
    [t('Academic advisors', 'تعلیمی مشیر'), support?.advisors ?? []],
    [t('Holds', 'پابندیاں'), support?.holds ?? []],
    [t('Study leave', 'تعلیمی رخصت'), support?.leaves ?? []],
    [t('Recognized credits', 'منظور شدہ کریڈٹس'), support?.credits ?? []],
    [t('Housing requests', 'رہائش کی درخواستیں'), community?.housing ?? []],
    [t('Meal plans', 'کھانے کے منصوبے'), community?.dining ?? []],
    [t('Campus allocations', 'کیمپس کی مختص سہولیات'), community?.allocations ?? []],
    [t('Library loans', 'کتابوں کا عاریتا اجرا'), community?.libraryLoans ?? []],
    [t('Research projects', 'تحقیقی منصوبے'), home.research?.projects ?? []],
    [t('Research milestones', 'تحقیق کے مراحل'), home.research?.milestones ?? []],
    [
      t('Degree verification and HEC attestation', 'ڈگری کی تصدیق اور ایچ ای سی توثیق'),
      home.research?.verifications ?? [],
    ],
    [t('My cases', 'میرے معاملات'), community?.cases ?? []],
    [t('Credential verification', 'اسناد کی تصدیق'), community?.verifications ?? []],
    [t('Career opportunities', 'ملازمت کے مواقع'), community?.opportunities ?? []],
  ];
  const translations: Record<string, string> = {
    'housing-waitlist': 'ہاسٹل کی انتظار فہرست میں شامل ہوں',
    'leave-waitlist': 'ہاسٹل کی درخواست منسوخ کریں',
    'open-advising': 'مشیر سے رابطہ کریں',
    'open-grievance': 'شکایت درج کریں',
    'alumni-consent': 'سابق طلبہ کے لیے رضامندی',
    'apply-opportunity': 'موقع کے لیے درخواست دیں',
    'request-verification': 'سند کی تصدیق کی اجازت دیں',
  };
  const labels: Record<string, string> = {
    resourceId: 'ہاسٹل',
    startsOn: 'شروع کی تاریخ',
    endsOn: 'آخری تاریخ',
    waitlistId: 'رہائش کی درخواست',
    message: 'پیغام',
    consent: 'رضامندی',
    opportunityId: 'موقع',
    awardId: 'سند',
    recipient: 'وصول کنندہ کا ای میل',
  };
  const choices: Record<string, Record<string, unknown>[]> = community
    ? {
        resourceId: community.hostels,
        waitlistId: community.housing.filter((r) => r.status === 'WAITING'),
        opportunityId: community.opportunities,
        awardId: community.awards,
      }
    : {};
  return (
    <>
      {rows
        .filter(([, records]) => records.length)
        .map(([title, records]) => (
          <SectionCard key={title} title={title}>
            <ul className="space-y-3">
              {records.map((record, index) => (
                <li className="border-b border-border-subtle py-2" key={index}>
                  <dl className="grid gap-1 sm:grid-cols-2">
                    {Object.entries(record)
                      .filter(
                        ([key, value]) => value !== null && key !== 'id' && !key.endsWith('_id')
                      )
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt className="text-xs text-text-muted">{portalLabel(key, language)}</dt>
                          <dd>
                            <bdi>
                              {typeof value === 'boolean'
                                ? t(value ? 'Yes' : 'No', value ? 'ہاں' : 'نہیں')
                                : typeof value === 'string' && /^[A-Z_]+$/.test(value)
                                  ? portalLabel(value, language)
                                  : readable(value, language)}
                            </bdi>
                          </dd>
                        </div>
                      ))}
                  </dl>
                </li>
              ))}
            </ul>
          </SectionCard>
        ))}
      {community && (
        <SectionCard title={t('Campus services and alumni', 'کیمپس خدمات اور سابق طلبہ')}>
          {learnerCommunityActions
            .filter(
              (a) =>
                (!['alumni-consent', 'request-verification'].includes(a.key) ||
                  community.awards.length > 0) &&
                a.fields.every((f) => !choices[f.name] || choices[f.name].length > 0)
            )
            .map((a) => (
              <details className="border-b border-border-subtle py-3" key={a.key}>
                <summary className="cursor-pointer">{t(a.label, translations[a.key])}</summary>
                <PortalForm action={a.key} language={language} label={t('Submit', 'جمع کریں')}>
                  {a.fields.map((f) =>
                    choices[f.name] ? (
                      <Picker key={f.name} name={f.name} label={t(f.label, labels[f.name])}>
                        {choices[f.name].map((row) => (
                          <option key={String(row.id)} value={String(row.id)}>
                            {String(row.label ?? row.credential_number ?? row.title ?? row.id)}
                            {f.name === 'resourceId'
                              ? ' · ' + pkr(Number(row.allocation_fee_paisa), language)
                              : ''}
                          </option>
                        ))}
                      </Picker>
                    ) : f.options ? (
                      <Picker key={f.name} name={f.name} label={t(f.label, labels[f.name])}>
                        {f.options.map((v) => (
                          <option key={v} value={v}>
                            {portalLabel(v, language)}
                          </option>
                        ))}
                      </Picker>
                    ) : (
                      <Field
                        key={f.name}
                        name={f.name}
                        label={t(f.label, labels[f.name] ?? f.label)}
                        type={
                          f.type === 'date' ? 'date' : f.name === 'recipient' ? 'email' : 'text'
                        }
                        required={f.required !== false}
                      />
                    )
                  )}
                </PortalForm>
              </details>
            ))}
        </SectionCard>
      )}
    </>
  );
}
function AcademicRecords({ home, t, language }: { home: Home; t: Translate; language: Language }) {
  const ac = home.academics,
    fmt = (s: string) => t(s, translateStatus[s] ?? s);
  return (
    <>
      {ac && (
        <>
          <SectionCard title={t('My programs', 'میرے پروگرام')}>
            {!ac.programs.length && (
              <p>
                {t(
                  'Your program will appear after matriculation.',
                  'داخلہ مکمل ہونے پر پروگرام ظاہر ہوگا۔'
                )}
              </p>
            )}
            {ac.programs.map((p) => (
              <p key={p.id} className="py-2">
                {p.program} · {p.intake} · {fmt(p.status)} · {p.curriculum_version} ·{' '}
                {t('Roll number', 'رول نمبر')} <bdi>{p.roll_number}</bdi>
                {p.cgpa !== null && (
                  <>
                    {' '}
                    · {t('CGPA', 'سی جی پی اے')} {p.cgpa}
                  </>
                )}
                {p.term_gpas.map((g) => (
                  <span key={g.term} className="block text-sm">
                    {g.term} · GPA {g.gpa ?? '—'} · {g.credits} {t('credits', 'کریڈٹس')}
                  </span>
                ))}
              </p>
            ))}
          </SectionCard>
          <SectionCard title={t('Timetable and registration', 'اوقات اور اندراج')}>
            {!ac.sections.length && (
              <p>
                {t(
                  'There are no sections available for your program.',
                  'اس وقت کوئی سیکشن دستیاب نہیں۔'
                )}
              </p>
            )}
            {ac.sections.map((s) => {
              const state = ac.enrollments.find((e) => e.section_id === s.id)?.status;
              const active = state === 'ENROLLED' || state === 'WAITLISTED';
              const day = (
                language === 'ur'
                  ? ['پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ', 'اتوار']
                  : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
              )[s.weekday - 1];
              return (
                <article key={s.id} className="grid gap-2 border-b border-border-subtle py-3">
                  <h3 className="font-semibold">
                    {s.course} · {s.label}
                  </h3>
                  <p>
                    {s.term} · {s.room} · {day}{' '}
                    <bdi>
                      {time(s.start_minute)}–{time(s.end_minute)}
                    </bdi>
                    {state ? ' · ' + fmt(state) : ''}
                  </p>
                  <PortalForm
                    action={active ? 'withdraw' : 'register'}
                    label={active ? t('Withdraw', 'اندراج واپس لیں') : t('Register', 'اندراج کریں')}
                    confirm={
                      active
                        ? t(
                            'Withdraw from this section?',
                            'کیا آپ اس سیکشن سے اندراج واپس لینا چاہتے ہیں؟'
                          )
                        : undefined
                    }
                    language={language}
                  >
                    <input type="hidden" name="id" value={s.id} />
                  </PortalForm>
                </article>
              );
            })}
          </SectionCard>
          <SectionCard title={t('Published results and appeals', 'نتائج اور اپیلیں')}>
            {ac.enrollments.filter((e) => e.mark !== null).length === 0 && (
              <p>{t('Published results will appear here.', 'جاری کردہ نتائج یہاں ظاہر ہوں گے۔')}</p>
            )}
            {ac.enrollments
              .filter((e) => e.mark !== null)
              .map((e) => (
                <article className="space-y-2 py-3" key={e.id}>
                  <h3>
                    {e.course} · {e.term} · {e.mark}
                  </h3>
                  {e.appeal_status ? (
                    <p>
                      {t('Appeal', 'اپیل')} · {fmt(e.appeal_status)}
                    </p>
                  ) : (
                    <PortalForm
                      action="appeal"
                      label={t('Request review', 'نظر ثانی کی درخواست')}
                      language={language}
                    >
                      <input type="hidden" name="id" value={e.id} />
                      <Field
                        name="reason"
                        label={t('Reason for review', 'نظر ثانی کی وجہ')}
                        max={1200}
                        required
                      />
                    </PortalForm>
                  )}
                </article>
              ))}
          </SectionCard>
          {(ac.transcripts.length > 0 || ac.awards.length > 0) && (
            <SectionCard title={t('Credentials', 'اسناد')}>
              {ac.awards.map((a) => (
                <p key={a.id}>
                  {t('Degree', 'ڈگری')} · <bdi>{a.credential_number}</bdi>
                </p>
              ))}
              {ac.transcripts.map((a) => (
                <p key={a.id}>
                  <Link
                    className="underline"
                    href={'/student/transcript/' + encodeURIComponent(a.id) + '?lang=' + language}
                  >
                    {t('View transcript', 'ٹرانسکرپٹ دیکھیں')} ·{' '}
                    {new Date(a.issued_at).toLocaleDateString(
                      language === 'ur' ? 'ur-PK' : 'en-PK',
                      { timeZone: 'Asia/Karachi' }
                    )}
                  </Link>
                </p>
              ))}
            </SectionCard>
          )}
        </>
      )}
      <SupportAndServices home={home} language={language} t={t} />
      {home.financeEnabled && (
        <Link className="underline" href={'/student/delegations?lang=' + language}>
          {t('Guardian and sponsor access', 'سرپرست اور مالی معاون کی رسائی')}
        </Link>
      )}
      <SectionCard title={t('Fee challans', 'فیس چالان')}>
        {home.finance.length === 0 && (
          <p>{t('You have no fee challans to view.', 'کوئی فیس چالان دستیاب نہیں۔')}</p>
        )}
        {home.finance.map((c) => (
          <article key={c.reference} className="space-y-2 border-b border-border-subtle py-3">
            <h3>
              {portalLabel(c.feeHead, language)} · <bdi>{c.reference}</bdi>
            </h3>
            <p>
              {t('Outstanding', 'باقی رقم')} <bdi>{pkr(c.balancePaisa, language)}</bdi> ·{' '}
              {t('Due', 'آخری تاریخ')} <bdi>{c.dueDate}</bdi>
            </p>
            <Link
              className="underline"
              href={'/student/challan/' + encodeURIComponent(c.reference) + '?lang=' + language}
            >
              {t('View printable challan', 'پرنٹ کے لیے چالان دیکھیں')}
            </Link>
          </article>
        ))}
      </SectionCard>
    </>
  );
}
export async function UniversityPortal({
  mode,
  language,
}: {
  mode: 'apply' | 'student';
  language: Language;
}) {
  let home: Home;
  try {
    home = await getPortalHome(mode);
  } catch (error) {
    if (error instanceof PortalError && error.status === 404) notFound();
    throw error;
  }
  const t: Translate = (en, ur) => (language === 'ur' ? ur : en),
    base = mode === 'apply' ? '/apply' : '/student';
  return (
    <main
      id="main-content"
      dir={language === 'ur' ? 'rtl' : 'ltr'}
      lang={language}
      className="mx-auto min-h-screen max-w-5xl space-y-5 bg-background p-4 text-foreground md:p-9"
    >
      <noscript>
        {t(
          'Enable JavaScript to submit portal forms.',
          'پورٹل فارم جمع کرنے کے لیے جاوا اسکرپٹ فعال کریں۔'
        )}
      </noscript>
      <nav
        aria-label={t('University portal', 'یونیورسٹی پورٹل')}
        className="flex flex-wrap items-center gap-5 py-3"
      >
        <Link
          className="underline"
          aria-current={mode === 'apply' ? 'page' : undefined}
          href={'/apply?lang=' + language}
        >
          {t('Admissions', 'داخلے')}
        </Link>
        <Link
          className="underline"
          aria-current={mode === 'student' ? 'page' : undefined}
          href={'/student?lang=' + language}
        >
          {t('Student portal', 'طلبہ پورٹل')}
        </Link>
        <Link className="underline" href={base + '?lang=' + (language === 'ur' ? 'en' : 'ur')}>
          {t('اردو', 'English')}
        </Link>
      </nav>
      {home.person?.staff_linked && (
        <Link className="underline" href="/university">
          {t('Switch to staff workspace', 'عملے کے پورٹل پر جائیں')}
        </Link>
      )}
      <PageHeader
        eyebrow={home.institution}
        heading={
          mode === 'apply'
            ? t('University admissions', 'یونیورسٹی داخلے')
            : t('Student portal', 'طلبہ پورٹل')
        }
        description={home.person?.full_name || home.person?.email}
      />
      {!home.person && (
        <SectionCard title={t('Sign in with email', 'ای میل سے داخل ہوں')}>
          <SignIn language={language} />
        </SectionCard>
      )}
      {mode === 'apply' ? (
        <Admissions home={home} language={language} t={t} />
      ) : home.person ? (
        <AcademicRecords home={home} language={language} t={t} />
      ) : null}
      {home.person && (
        <PortalForm action="sign-out" label={t('Sign out', 'باہر نکلیں')} language={language} />
      )}
    </main>
  );
}
