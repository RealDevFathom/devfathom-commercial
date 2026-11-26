import { encodeQr, qrSvgPath } from '@/lib/qr/qr-code';
import {
  COUNTER_RECEIPT_STRINGS,
  type CounterReceipt,
  type CounterReceiptLocale,
} from './counter-receipt';
import { counterReceiptFacts } from './counter-receipt-presentation';
import { receiptBlocks } from './receipt-blocks';
import { safePharmacyLayout } from './receipt-layout';

export function escapeReceiptHtml(value: string | number) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );
}
export function receiptHtmlText(text: string, locale: CounterReceiptLocale) {
  if (locale === 'en') return escapeReceiptHtml(text);
  return text
    .split(/([A-Za-z0-9][\x20-\x7e]*)/g)
    .map((part, i) =>
      i % 2 ? `<bdi dir="ltr">${escapeReceiptHtml(part)}</bdi>` : escapeReceiptHtml(part)
    )
    .join('');
}

export function designedReceiptHtml(
  receipt: CounterReceipt,
  requested: CounterReceiptLocale,
  width: 58 | 80,
  reprint: boolean
) {
  const layout = safePharmacyLayout(receipt.receiptLayout);
  const locales: CounterReceiptLocale[] =
    layout.version === 1
      ? [requested]
      : layout.locale === 'both'
        ? ['en', 'ur']
        : [requested === 'ur' ? 'ur' : layout.locale];
  return locales
    .map((locale) => {
      const mark = reprint
        ? COUNTER_RECEIPT_STRINGS[locale].reprint
        : locale === 'ur'
          ? 'اصل'
          : 'Original';
      const blocks = receiptBlocks(
        layout,
        receipt.printFacts?.[locale] ?? counterReceiptFacts(receipt, locale),
        mark,
        width
      );
      return `<section lang="${locale}" dir="${locale === 'ur' ? 'rtl' : 'ltr'}">${blocks
        .map((block) => {
          if (block.kind === 'facts') return `<pre>${receiptHtmlText(block.text, locale)}</pre>`;
          if (block.kind === 'text')
            return `<pre class="${block.alignment} ${block.emphasis}" dir="auto">${receiptHtmlText(block.text, locale)}</pre>`;
          if (block.kind === 'logo')
            return receipt.receiptLogoPng && /^[A-Za-z0-9+/]+=*$/.test(receipt.receiptLogoPng)
              ? `<img alt="Pharmacy logo" width="${Math.round((block.maxWidthMm * 96) / 25.4)}" src="data:image/png;base64,${receipt.receiptLogoPng}">`
              : '';
          const matrix = encodeQr(block.url);
          return `<figure lang="en" dir="ltr"><svg aria-label="Website QR code" viewBox="0 0 ${matrix.length + 8} ${matrix.length + 8}"><rect width="100%" height="100%" fill="white"/><path d="${qrSvgPath(matrix)}"/></svg><figcaption>${block.caption}</figcaption></figure>`;
        })
        .join('')}</section>`;
    })
    .join('');
}
