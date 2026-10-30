import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { buildReceiptPreview } from '@/lib/receipts/preview';

import {
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptDate,
  formatReceiptInteger,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLine,
  type CounterReceiptLocale,
} from './counter-receipt';

const labels = {
  en: {
    unavailable: 'Historical identity unavailable',
    unknown: 'Unavailable',
    units: 'Canonical units',
    tax: 'Tax breakdown unavailable in receipt source',
    payments: 'Payment details unavailable',
  },
  ur: {
    unavailable: 'تاریخی شناخت دستیاب نہیں',
    unknown: 'دستیاب نہیں',
    units: 'بنیادی اکائیاں',
    tax: 'رسید کے ماخذ میں ٹیکس کی تفصیل دستیاب نہیں',
    payments: 'ادائیگی کی تفصیل دستیاب نہیں',
  },
} as const;

/** Missing status on legacy callers is not evidence of issued identity. */
export function counterLinePresentation(line: CounterReceiptLine, locale: CounterReceiptLocale) {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const text = labels[locale];
  const issued = line.identityStatus === 'ISSUED';
  return {
    identity: issued
      ? [line.medicineName, line.strength, line.presentation].filter(Boolean).join(' · ')
      : text.unavailable,
    allocations: (line.allocations ?? []).map((allocation) => {
      const batch = issued ? allocation.batchNumber : null;
      const expiry = issued ? allocation.expiresAt : null;
      return `${strings.batch}: ${batch ?? text.unknown} · ${strings.expiry}: ${expiry ? formatReceiptDate(expiry, locale) : text.unknown} · ${text.units}: ${formatReceiptInteger(allocation.canonicalUnits, locale)}`;
    }),
  };
}

/** Browser semantics only. No raw queue capability or saved settings authorization. */
export function buildCounterReceiptPreview(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  paperWidth: 58 | 80,
  reprint = false
): string {
  const amounts = [
    ...Object.values(receipt.totals),
    ...receipt.lines.flatMap((line) => [line.unitPriceMinor, line.lineTotalMinor]),
    ...receipt.tenders.map((tender) => tender.amountMinor),
  ];
  if (!amounts.every(Number.isSafeInteger)) throw new Error('Receipt amounts are invalid.');
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const ntn = receipt.taxIdentity?.ntn?.trim();
  const strn = receipt.taxIdentity?.strn?.trim();
  return buildReceiptPreview(
    { ...DEFAULT_RECEIPT_LAYOUT, paperWidth, footerText: reprint ? strings.reprint : '' },
    {
      businessName: receipt.branchName,
      invoiceNumber: receiptTitle(receipt, locale),
      issuedAt: `${strings.date}: ${formatReceiptDate(receipt.businessDate ?? receipt.completedAt, locale)}`,
      lines: receipt.lines.map((line) => {
        const presentation = counterLinePresentation(line, locale);
        return [
          presentation.identity,
          `${formatReceiptInteger(line.quantity, locale)} ${strings.saleUnit[line.saleUnit]} × ${formatMinor(line.unitPriceMinor, locale)}`,
          ...presentation.allocations,
          `${strings.lineTotal}: ${formatMinor(line.lineTotalMinor, locale)}`,
        ].join('\n');
      }),
      // Identity is historical receipt data; the model supplies no tax breakdown.
      taxLines: [
        ...(ntn ? [`NTN: ${ntn}`] : []),
        ...(strn ? [`STRN: ${strn}`] : []),
        labels[locale].tax,
      ],
      totals: [
        receipt.currency,
        `${strings.gross}: ${formatMinor(receipt.totals.grossMinor, locale)}`,
        `${strings.discount}: ${formatMinor(receipt.totals.discountMinor, locale)}`,
        `${strings.net}: ${formatMinor(receipt.totals.netMinor, locale)}`,
        `${strings.tendered}: ${formatMinor(receipt.totals.tenderedMinor, locale)}`,
        `${strings.change}: ${formatMinor(receipt.totals.changeMinor, locale)}`,
      ],
      payments: receipt.tenders.length
        ? receipt.tenders.map(
            (tender) => `${tender.type}: ${formatMinor(tender.amountMinor, locale)}`
          )
        : [labels[locale].payments],
    }
  );
}

/** Aggregate-only report: no patient, medicine, or tender identity is exported. */
export type CounterZReport = {
  id: string;
  branchName: string;
  businessDate: string;
  sequence: number;
  grossSalesMinor: number;
  refundTotalMinor: number;
  netSalesMinor: number;
  cashExpectedMinor: number;
  cashCountedMinor: number;
  cashVarianceMinor: number;
  reason: string | null;
  isFinal: boolean;
};

export function buildCounterZReportPreview(
  report: CounterZReport,
  locale: CounterReceiptLocale
): string {
  const amounts = [
    report.grossSalesMinor,
    report.refundTotalMinor,
    report.netSalesMinor,
    report.cashExpectedMinor,
    report.cashCountedMinor,
    report.cashVarianceMinor,
  ];
  if (!report.id || !amounts.every(Number.isSafeInteger))
    throw new Error('Load a recorded day close before printing.');
  const labels =
    locale === 'ur'
      ? [
          'روزانہ اختتامی رپورٹ',
          'تاریخ',
          'فروخت',
          'واپسی',
          'خالص فروخت',
          'متوقع نقد',
          'گنتی شدہ نقد',
          'فرق',
          'فرق کی وجہ',
        ]
      : [
          'Z-report',
          'Business date',
          'Gross sales',
          'Refunds',
          'Net sales',
          'Expected cash',
          'Counted cash',
          'Variance',
          'Variance note',
        ];
  return [
    labels[0],
    report.branchName,
    `${labels[1]}: ${report.businessDate}`,
    `#${report.sequence} · ${report.id}`,
    'PKR',
    ...amounts.map((amount, i) => `${labels[i + 2]}: ${formatMinor(amount)}`),
    `${labels[8]}: ${report.reason ?? '—'}`,
    report.isFinal ? 'Final' : 'Provisional — migration reconciliation pending',
  ].join('\n');
}
