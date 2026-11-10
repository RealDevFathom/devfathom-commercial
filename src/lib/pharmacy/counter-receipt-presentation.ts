import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { tenderTotalsSchema } from './manual-payments';
import { buildReceiptPreview } from '@/lib/receipts/preview';

import {
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptDate,
  formatReceiptIssuedAt,
  receiptTitle,
  receiptCashReceived,
  type CounterReceipt,
  type CounterReceiptLine,
  type CounterReceiptLocale,
} from './counter-receipt';

const labels = {
  en: {
    unavailable: 'Historical identity unavailable',
    unknown: 'Unavailable',
    units: 'Tablets/units',
    payments: 'Payment details unavailable',
  },
  ur: {
    unavailable: 'تاریخی شناخت دستیاب نہیں',
    unknown: 'دستیاب نہیں',
    units: 'گولیاں/یونٹس',
    payments: 'ادائیگی کی تفصیل دستیاب نہیں',
  },
} as const;

const cashReceivedLabels: Partial<Record<CounterReceiptLocale, string>> = { en: 'Cash received' };

export function receiptCashReceivedLabel(locale: CounterReceiptLocale): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  return cashReceivedLabels[locale] ?? `${strings.tenderName.CASH} ${strings.tendered}`;
}

/**
 * Show integer-minor-unit arithmetic that exactly reconciles to the stored
 * gross. Mixed lots can make gross / quantity non-integral, so displaying only
 * the representative unit price would make the printed equation false.
 */
export function exactReceiptPriceBreakdown(
  quantity: number,
  grossMinor: number,
  multiplicationSign = '×',
  locale: CounterReceiptLocale = 'en'
): string {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(grossMinor)) {
    throw new Error('Receipt line pricing is invalid.');
  }
  if (grossMinor % quantity === 0) {
    return `${quantity} ${multiplicationSign} ${formatMinor(grossMinor / quantity, locale)}`;
  }
  // State quantity and gross directly when one integer unit price cannot
  // represent the charge. Never invent synthetic lot prices from an average.
  return `${quantity}${multiplicationSign === 'x' ? ' - ' : ' · '}${formatMinor(grossMinor, locale)}`;
}

export function counterLinePricing(
  line: CounterReceiptLine,
  locale: CounterReceiptLocale,
  multiplicationSign = '×'
): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const priced = line.allocations?.filter((row) => row.grossMinor != null) ?? [];
  const gross = line.lineTotalMinor + line.discountMinor;
  const scale = line.canonicalUnits / line.quantity;
  const separator = multiplicationSign === 'x' ? ' - ' : ' · ';
  if (
    priced.length &&
    priced.length === line.allocations!.length &&
    priced.reduce((sum, row) => sum + row.grossMinor!, 0) === gross
  ) {
    const wholeSaleUnits = priced.every((row) => {
      const quantity = row.canonicalUnits / scale;
      return Number.isSafeInteger(quantity) && quantity > 0 && row.grossMinor! % quantity === 0;
    });
    if (wholeSaleUnits) {
      return `${strings.saleUnit[line.saleUnit]}: ${priced
        .map((row) =>
          exactReceiptPriceBreakdown(
            row.canonicalUnits / scale,
            row.grossMinor!,
            multiplicationSign,
            locale
          )
        )
        .join(' + ')}`;
    }
    return priced
      .map(
        (row) =>
          `${labels[locale].units}: ${row.canonicalUnits}${separator}${strings.gross}: ${formatMinor(row.grossMinor!, locale)}`
      )
      .join(' + ');
  }
  return gross === line.quantity * line.unitPriceMinor
    ? `${strings.saleUnit[line.saleUnit]}: ${exactReceiptPriceBreakdown(line.quantity, gross, multiplicationSign, locale)}`
    : `${strings.quantity}: ${line.quantity} ${strings.saleUnit[line.saleUnit]}${separator}${strings.gross}: ${formatMinor(gross, locale)}`;
}

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
      return `${strings.batch}: ${batch ?? text.unknown} · ${strings.expiry}: ${expiry ? formatReceiptDate(expiry) : text.unknown} · ${text.units}: ${allocation.canonicalUnits}`;
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
  const cashReceived = receiptCashReceived(receipt.tenders);
  const ntn = receipt.taxIdentity?.ntn?.trim();
  const strn = receipt.taxIdentity?.strn?.trim();
  const identity = receipt.taxIdentity;
  return buildReceiptPreview(
    { ...DEFAULT_RECEIPT_LAYOUT, paperWidth, footerText: reprint ? strings.reprint : '' },
    {
      businessName: receipt.branchName,
      invoiceNumber:
        receipt.receiptNumber === null
          ? receiptTitle(receipt, locale)
          : String(receipt.receiptNumber),
      invoiceLabel: strings.invoice,
      issuedAt: `${strings.date}: ${formatReceiptIssuedAt(receipt.completedAt)}${receipt.cashierName ? `\n${strings.cashier}: ${receipt.cashierName}` : ''}`,
      lines: receipt.lines.map((line) => {
        const presentation = counterLinePresentation(line, locale);
        return [
          presentation.identity,
          counterLinePricing(line, locale),
          ...presentation.allocations,
          `${strings.lineTotal}: ${formatMinor(line.lineTotalMinor, locale)}`,
        ].join('\n');
      }),
      taxBreakdown: 'UNAVAILABLE',
      // Identity is historical receipt data; the model supplies no tax breakdown.
      taxLines: [
        ...(identity?.address?.trim() ? [identity.address.trim()] : []),
        ...(identity?.phone?.trim() ? [`${strings.phone}: ${identity.phone.trim()}`] : []),
        ...(identity?.licenceNumber?.trim()
          ? [`${strings.licence}: ${identity.licenceNumber.trim()}`]
          : []),
        ...(ntn ? [`NTN: ${ntn}`] : []),
        ...(strn ? [`STRN: ${strn}`] : []),
      ],
      totals: [
        locale === 'ur' && receipt.currency === 'PKR' ? 'پاکستانی روپے' : receipt.currency,
        `${strings.gross}: ${formatMinor(receipt.totals.grossMinor, locale)}`,
        `${strings.discount}: ${formatMinor(receipt.totals.discountMinor, locale)}`,
        `${strings.net}: ${formatMinor(receipt.totals.netMinor, locale)}`,
        `${strings.tendered}: ${formatMinor(receipt.totals.tenderedMinor, locale)}`,
        ...(cashReceived !== null
          ? [`${receiptCashReceivedLabel(locale)}: ${formatMinor(cashReceived, locale)}`]
          : []),
        `${strings.change}: ${formatMinor(receipt.totals.changeMinor, locale)}`,
      ],
      payments: receipt.tenders.length
        ? receipt.tenders.map(
            (tender) =>
              `${strings.tenderName[tender.type] ?? tender.type}: ${formatMinor(tender.amountMinor, locale)}`
          )
        : [labels[locale].payments],
    }
  );
}

/** Aggregate-only report: no patient, medicine, or tender identity is exported. */
export type CounterZReport = {
  tenderTotals?: unknown;
  id: string;
  branchName: string;
  businessDate: string;
  currency: string;
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
    report.currency,
    ...amounts.map((amount, i) => `${labels[i + 2]}: ${formatMinor(amount, locale)}`),
    ...(report.tenderTotals == null
      ? []
      : tenderTotalsSchema
          .parse(report.tenderTotals)
          .map(
            (row) =>
              `${row.type}: ${formatMinor(row.amountMinor, locale)} · ${locale === 'ur' ? 'واپسی' : 'Refunds'}: ${formatMinor(row.refundMinor, locale)} · ${locale === 'ur' ? 'خالص' : 'Net'}: ${formatMinor(row.netMinor, locale)}`
          )),
    `${labels[8]}: ${report.reason ?? '—'}`,
    report.isFinal ? 'Final' : 'Provisional — migration reconciliation pending',
  ].join('\n');
}
