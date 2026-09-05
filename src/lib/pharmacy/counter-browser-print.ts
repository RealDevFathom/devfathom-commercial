import {
  COUNTER_RECEIPT_DIRECTION,
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptDate,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLocale,
} from './counter-receipt';

// Transient browser paper choice, not a second saved designer/settings schema.
export type CounterReceiptFormat = 'THERMAL' | 'THERMAL_58' | 'A4';

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

/** Allowlisted receipt fields only: never copy the POS DOM or patient panel. */
export function buildCounterBrowserReceipt(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  format: CounterReceiptFormat,
  reprint = false
): string {
  if (!['en', 'ur'].includes(locale) || !['THERMAL', 'THERMAL_58', 'A4'].includes(format)) {
    throw new Error('Choose a supported receipt language and paper size.');
  }
  if (receipt.receiptNumber === null || !receipt.completedAt || receipt.lines.length === 0) {
    throw new Error('Load a settled receipt before printing.');
  }
  const amounts = [
    ...Object.values(receipt.totals),
    ...receipt.lines.flatMap((line) => [line.unitPriceMinor, line.lineTotalMinor]),
    ...receipt.tenders.map((tender) => tender.amountMinor),
  ];
  if (!amounts.every(Number.isSafeInteger)) throw new Error('Receipt amounts are invalid.');
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const width = format === 'THERMAL_58' ? '58mm' : format === 'THERMAL' ? '80mm' : '190mm';
  const pairs = [
    [strings.gross, receipt.totals.grossMinor],
    [strings.discount, receipt.totals.discountMinor],
    [strings.net, receipt.totals.netMinor],
    [strings.tendered, receipt.totals.tenderedMinor],
    [strings.change, receipt.totals.changeMinor],
  ] as const;
  // Print-only physical page styling; no application palette or external assets.
  return `<!doctype html><html lang="${locale}" dir="${COUNTER_RECEIPT_DIRECTION[locale]}"><head>
<meta charset="utf-8"><title>${escapeHtml(receiptTitle(receipt, locale))}</title>
<style>@page { size: ${format === 'A4' ? 'A4' : 'auto'}; margin: ${format === 'A4' ? '10mm' : '0'}; }
* { box-sizing: border-box; } body { margin: 0; width: ${width}; max-width: 100%; padding: 3mm; font: 12px monospace; color: black; background: white; overflow-wrap: anywhere; }
h1 { font-size: 16px; } ul { padding: 0; list-style: none; } li { padding: 2mm 0; border-bottom: 1px dashed; break-inside: avoid; } dl div { display: flex; justify-content: space-between; gap: 2mm; } dd { margin: 0; } p { margin: 2mm 0; }</style>
</head><body><h1>${escapeHtml(receiptTitle(receipt, locale))}</h1>
<p>${escapeHtml(strings.branch)}: ${escapeHtml(receipt.branchName)}</p>
<p>${escapeHtml(strings.date)}: ${escapeHtml(receipt.businessDate ?? formatReceiptDate(receipt.completedAt))}</p>
<p>${escapeHtml(receipt.currency)}</p>${reprint ? `<p>${escapeHtml(strings.reprint)}</p>` : ''}
<ul>${receipt.lines
    .map(
      (line) => `<li><p>${escapeHtml(line.medicineName)} ${escapeHtml(line.strength ?? '')}</p>
<p>${escapeHtml(line.presentation)} · ${escapeHtml(line.quantity)} ${escapeHtml(strings.saleUnit[line.saleUnit])} × ${formatMinor(line.unitPriceMinor)}</p>
<p>${escapeHtml(strings.batch)}: ${escapeHtml(line.batchNumber)} · ${escapeHtml(strings.expiry)}: ${escapeHtml(formatReceiptDate(line.expiresAt))}</p>
<p>${escapeHtml(strings.lineTotal)}: ${formatMinor(line.lineTotalMinor)}</p></li>`
    )
    .join('')}</ul>
<dl>${pairs.map(([label, amount]) => `<div><dt>${escapeHtml(label)}</dt><dd>${formatMinor(amount)}</dd></div>`).join('')}</dl>
${receipt.tenders.length ? `<p>${escapeHtml(strings.tenders)}</p><dl>${receipt.tenders.map((tender) => `<div><dt>${escapeHtml(tender.type)}</dt><dd>${formatMinor(tender.amountMinor)}</dd></div>`).join('')}</dl>` : ''}
</body></html>`;
}

/** Opens only an isolated receipt. Returning does not confirm physical printing. */
export function printCounterBrowserReceipt(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  format: CounterReceiptFormat,
  reprint = false
): void {
  const html = buildCounterBrowserReceipt(receipt, locale, format, reprint);
  const popup = window.open('', '_blank', 'popup,width=480,height=720');
  if (!popup) throw new Error('Allow pop-ups for this site, then retry Print receipt.');
  popup.opener = null;
  try {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.focus();
    popup.print();
  } catch {
    popup.close();
    throw new Error('The browser print dialog could not open. Retry Print receipt.');
  }
}
