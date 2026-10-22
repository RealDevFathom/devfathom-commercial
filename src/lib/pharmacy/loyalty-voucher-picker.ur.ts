/**
 * Urdu catalogue for the pharmacy loyalty voucher picker.
 *
 * The picker itself is supplied by the sibling feature branch. Keeping its
 * English key contract here lets this locale-only branch remain independent
 * while still making a missing translation a type error and a test failure.
 */
export const LOYALTY_VOUCHER_PICKER_EN_KEYS = [
  'title',
  'description',
  'aiLabel',
  'aiUnavailable',
  'aiUnavailableDescription',
  'loading',
  'emptyTitle',
  'emptyDescription',
  'customerLabel',
  'customerPlaceholder',
  'searchLabel',
  'searchPlaceholder',
  'voucherLabel',
  'voucherPlaceholder',
  'recommendedBadge',
  'pointsBalance',
  'pointsRequired',
  'voucherValue',
  'expiresOn',
  'termsLabel',
  'selectVoucher',
  'selectedVoucher',
  'clearSelection',
  'confirmSelection',
  'cancel',
  'sendOnWhatsApp',
  'whatsappConsentRequired',
  'whatsappVoucherTemplate',
  'errorTitle',
  'errorDescription',
  'retry',
] as const;

export type LoyaltyVoucherPickerKey = (typeof LOYALTY_VOUCHER_PICKER_EN_KEYS)[number];

export const LOYALTY_VOUCHER_PICKER_UR = {
  title: 'لائلٹی واؤچر منتخب کریں',
  description: 'اس گاہک کے لیے دستیاب واؤچرز دیکھیں اور ایک منتخب کریں۔',
  aiLabel: 'DevFathom AI',
  aiUnavailable: 'AI دستیاب نہیں ہے',
  aiUnavailableDescription: 'ادارے کے لیے AI فراہم کنندہ ترتیب دینے کے بعد تجاویز دستیاب ہوں گی۔',
  loading: 'واؤچرز لوڈ ہو رہے ہیں…',
  emptyTitle: 'کوئی واؤچر دستیاب نہیں',
  emptyDescription: 'اس گاہک کے پوائنٹس کے لیے فی الحال کوئی موزوں واؤچر نہیں ہے۔',
  customerLabel: 'گاہک',
  customerPlaceholder: 'گاہک منتخب کریں',
  searchLabel: 'واؤچر تلاش کریں',
  searchPlaceholder: 'نام یا کوڈ سے تلاش کریں',
  voucherLabel: 'واؤچر',
  voucherPlaceholder: 'واؤچر منتخب کریں',
  recommendedBadge: 'تجویز کردہ',
  pointsBalance: 'پوائنٹس کا بیلنس',
  pointsRequired: 'درکار پوائنٹس',
  voucherValue: 'واؤچر کی مالیت',
  expiresOn: 'میعاد ختم ہونے کی تاریخ',
  termsLabel: 'شرائط',
  selectVoucher: 'یہ واؤچر منتخب کریں',
  selectedVoucher: 'منتخب واؤچر',
  clearSelection: 'انتخاب ہٹائیں',
  confirmSelection: 'انتخاب کی تصدیق کریں',
  cancel: 'منسوخ کریں',
  sendOnWhatsApp: 'واٹس ایپ پر بھیجیں',
  whatsappConsentRequired: 'پیغام بھیجنے کے لیے گاہک کی واٹس ایپ اجازت ضروری ہے۔',
  whatsappVoucherTemplate:
    'آپ کی فارمیسی کی جانب سے {{1}} واؤچر دستیاب ہے۔ واؤچر کوڈ: {{2}}۔ میعاد: {{3}}۔ شرائط لاگو ہیں۔ پیغامات بند کرنے کے لیے STOP لکھیں۔',
  errorTitle: 'واؤچرز لوڈ نہیں ہو سکے',
  errorDescription: 'دوبارہ کوشش کریں یا کسی دوسرے گاہک کو منتخب کریں۔',
  retry: 'دوبارہ کوشش کریں',
} as const satisfies Readonly<Record<LoyaltyVoucherPickerKey, string>>;

export const LOYALTY_VOUCHER_PICKER_UR_DIRECTION = 'rtl' as const;
