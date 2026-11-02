import type { AIOutputLocale } from '@/lib/ai/locale';
import type { PharmacyDailyWorkPack } from '@/lib/pharmacy/daily-work-pack';

/**
 * DEV-582: the user-facing text of the Ask Fathom pharmacy tools, per answer locale.
 *
 * Messages, scope gaps, suggestion text and metric labels follow the assistant-context
 * locale. Metric definitions, sources, limitations and model instructions stay in the
 * canonical English contract wording; the Urdu result carries an output-language
 * directive so the answer renders them in Urdu without changing their meaning.
 */
const EN = {
  refusal: 'I cannot answer that from the pharmacy reports you are authorized to see.',
  unsupported: 'I cannot answer that from authorized reports because no supporting metric exists.',
  unavailable: 'Pharmacy report data is currently unavailable. No stale figures were used.',
  financeInput: 'Use one exact branch and valid report dates.',
  financePeriod: 'Use a nonfuture inventory cutoff or a 1–92 day UTC half-open leakage period.',
  insightInput: 'Use one exact branch and valid bounded UTC report dates.',
  insightPeriod:
    'Margin requires 1–92 days and no cutoff. Repeat requires at most 90 inclusive enrollment days and a nonfuture asOf cutoff on or after enrollment.',
  workPackInput: 'Use one exact branch, report dates and asOf.',
  workPackPeriod: 'Use a bounded inclusive UTC report period and a valid nonfuture asOf.',
  branchScopeGap:
    'A unique active tenant branch is required. Staff and multi-branch scope are not inferred.',
  inventoryEvidence:
    'Observed inventory ledger book values; stock condition and recoverability unavailable.',
  inventorySuggestion:
    'If book exposure warrants investigation, review receipts, stock counts and supplier credit status in authorized workflows. No recovery amount or action is inferred.',
  leakageEvidence: 'Nonzero signed discount, write-off or shrinkage postings in the cited period.',
  leakageSuggestion:
    'If these postings warrant investigation, review receipts and discounts, waste records and stock counts. These are review options, not proven causes or guaranteed savings.',
  marginEvidence: 'Negative reconciled gross-margin difference in these periods.',
  marginSuggestion:
    'If this decline warrants investigation, review posted revenue, discounts and COGS in the linked report. This does not identify a cause or guarantee revenue improvement.',
};

const UR: typeof EN = {
  refusal: 'میں اس کا جواب اُن فارمیسی رپورٹس سے نہیں دے سکتا جنہیں دیکھنے کی آپ کو اجازت ہے۔',
  unsupported:
    'میں مجاز رپورٹس سے اس کا جواب نہیں دے سکتا کیونکہ اس کی تائید کرنے والا کوئی میٹرک موجود نہیں۔',
  unavailable: 'فارمیسی رپورٹ کا ڈیٹا اس وقت دستیاب نہیں۔ کوئی پرانے اعداد استعمال نہیں کیے گئے۔',
  financeInput: 'ایک درست برانچ اور رپورٹ کی درست تاریخیں استعمال کریں۔',
  financePeriod:
    'انوینٹری کے لیے ایسی کٹ آف دیں جو مستقبل کی نہ ہو، یا لیکیج کے لیے 1 سے 92 دن کی UTC مدت دیں (آغاز شامل، اختتام شامل نہیں)۔',
  insightInput: 'ایک درست برانچ اور محدود، درست UTC رپورٹ تاریخیں استعمال کریں۔',
  insightPeriod:
    'مارجن کے لیے 1 سے 92 دن درکار ہیں اور کوئی کٹ آف نہیں۔ دوبارہ خریداری کے لیے زیادہ سے زیادہ 90 دن کی اندراج مدت (دونوں سرے شامل) اور اندراج کے دن یا اس کے بعد کی asOf کٹ آف درکار ہے جو مستقبل کی نہ ہو۔',
  workPackInput: 'ایک درست برانچ، رپورٹ کی تاریخیں اور asOf استعمال کریں۔',
  workPackPeriod:
    'محدود UTC رپورٹ مدت (دونوں سرے شامل) اور ایسی درست asOf استعمال کریں جو مستقبل کی نہ ہو۔',
  branchScopeGap:
    'ایک منفرد فعال برانچ درکار ہے۔ عملے یا ایک سے زیادہ برانچوں کا دائرہ خود سے اخذ نہیں کیا جاتا۔',
  inventoryEvidence:
    'انوینٹری لیجر کی درج شدہ بک ویلیو؛ اسٹاک کی حالت اور وصولی کی گنجائش دستیاب نہیں۔',
  inventorySuggestion:
    'اگر بک ایکسپوژر کی جانچ ضروری لگے تو مجاز ورک فلو میں وصولیاں، اسٹاک گنتی اور سپلائر کریڈٹ کی صورتحال دیکھیں۔ کوئی وصولی رقم یا اقدام اخذ نہیں کیا گیا۔',
  leakageEvidence: 'درج مدت میں ڈسکاؤنٹ، رائٹ آف یا اسٹاک کی کمی کی غیر صفر درج شدہ پوسٹنگز۔',
  leakageSuggestion:
    'اگر ان پوسٹنگز کی جانچ ضروری لگے تو رسیدیں اور ڈسکاؤنٹ، ضیاع کے ریکارڈ اور اسٹاک گنتی دیکھیں۔ یہ جائزے کے اختیارات ہیں، ثابت شدہ وجوہات یا یقینی بچت نہیں۔',
  marginEvidence: 'ان مدتوں میں مطابقت شدہ مجموعی مارجن کا فرق منفی ہے۔',
  marginSuggestion:
    'اگر اس کمی کی جانچ ضروری لگے تو منسلک رپورٹ میں درج شدہ آمدنی، ڈسکاؤنٹ اور فروخت شدہ مال کی لاگت (COGS) دیکھیں۔ اس سے کسی وجہ کی نشاندہی نہیں ہوتی اور نہ آمدنی میں بہتری کی ضمانت ملتی ہے۔',
};

export type PharmacyReportText = typeof EN;

export function pharmacyReportText(locale: AIOutputLocale): PharmacyReportText {
  return locale === 'ur' ? UR : EN;
}

/** Urdu labels for every RPT-02 metric contract key; English uses the contract label. */
export const PHARMACY_METRIC_LABELS_UR: Readonly<Record<string, string>> = {
  salesMinor: 'آج کی فروخت',
  marginMinor: 'مجموعی مارجن',
  cashMinor: 'آج کی نقدی',
  cashVarianceMinor: 'نقدی کا فرق',
  refundsMinor: 'رقم کی واپسی',
  openStockSignals: 'اسٹاک کے کھلے اشارے',
  lostDemandEvents: 'پوری نہ ہونے والی طلب کے درج شدہ واقعات',
  recommendedOrders: 'تجویز کردہ آرڈر',
  expiryValueMinor30: 'میعاد ختم ہونے والی مالیت · 30 دن',
  expiryValueMinor60: 'میعاد ختم ہونے والی مالیت · 60 دن',
  expiryValueMinor90: 'میعاد ختم ہونے والی مالیت · 90 دن',
  expiryValueMinor180: 'میعاد ختم ہونے والی مالیت · 180 دن',
  openRecalls: 'واپسی (ریکال) کے کھلے نوٹس',
  quarantineUnits: 'قرنطینہ میں رکھے یونٹس',
  openClaims: 'سپلائر کے کھلے کلیم',
  openReceivingExceptions: 'وصولی کی کھلی بے ضابطگیاں',
  pharmacistCoverage: 'فارماسسٹ کی موجودگی',
  safetyQueue: 'حفاظتی جائزے کی قطار',
  accountsPayableMinor: 'قابلِ ادائیگی رقوم',
  accountsReceivableMinor: 'قابلِ وصولی رقوم',
  khataAgingMinor: 'کھاتے کی میعاد گزری رقم',
  agingFiscalDocuments: 'زیرِ التوا مالیاتی دستاویزات',
  rejectedFiscalDocuments: 'مسترد مالیاتی دستاویزات',
  deviceFiscalOfflineExceptions: 'ڈیوائس/مالیاتی/آف لائن بے ضابطگیاں',
};

export function pharmacyMetricLabel(
  metric: { key: string; label: string },
  locale: AIOutputLocale
): string {
  return (locale === 'ur' && PHARMACY_METRIC_LABELS_UR[metric.key]) || metric.label;
}

type WorkPackGroup = PharmacyDailyWorkPack['groups'][number]['key'];

/** Urdu titles for the daily work-pack review groups (English comes from the reader). */
export const PHARMACY_WORK_PACK_TITLES_UR: Readonly<Record<WorkPackGroup, string>> = {
  'inventory-review': 'متعلقہ انوینٹری اشاروں کا جائزہ لیں',
  'anomaly-review': 'درج شدہ مالی بے ضابطگیوں کا جائزہ لیں',
  'supplier-credit-review': 'سپلائر کلیمز اور ترسیل کے شواہد کا جائزہ لیں',
};

/** The work pack with its group titles and review labels in the answer locale. */
export function localizeWorkPack(
  workPack: PharmacyDailyWorkPack,
  locale: AIOutputLocale
): PharmacyDailyWorkPack {
  if (locale !== 'ur') return workPack;
  return {
    ...workPack,
    groups: workPack.groups.map((group) => {
      const title = PHARMACY_WORK_PACK_TITLES_UR[group.key];
      return {
        ...group,
        tasks: group.tasks.map((task) => ({
          ...task,
          title,
          nextActions: task.nextActions.map((action) => ({ ...action, label: title })),
        })),
      };
    }),
  };
}
