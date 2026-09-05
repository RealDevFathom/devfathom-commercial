import type { Receipt } from './receipt-view';

/** Explicit OS-dialog fallback; no afterprint handler and no physical-success claim. */
export function requestReceiptDialog(receipt: Receipt, width: 58 | 80, preview?: string) {
  const popup = window.open('', '_blank', 'popup,width=420,height=720');
  if (!popup) throw new Error('Print window blocked. Allow popups and retry.');
  popup.opener = null;
  const doc = popup.document;
  doc.title = `Receipt ${receipt.receiptNumber ?? 'unissued'}`;
  const style = doc.createElement('style');
  const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
  if (nonce) style.nonce = nonce;
  // Shared server preview uses the captured job layout, or current saved layout before enqueue.
  // WHA-1354's ASCII-only preview schema cannot render Unicode yet; retain the inert plain
  // receipt fallback until that owner supplies a Unicode-capable shared browser preview.
  // CSS has no custom-width/auto-height page size. The OS dialog owns roll paper size.
  style.textContent = `@page { size: auto; margin: 2mm; } body { width: ${width - 4}mm; margin: 0; font: 10pt monospace; color: black; background: white; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }`;
  doc.head.append(style);
  const content = doc.createElement('pre');
  content.textContent =
    preview ??
    [
      doc.title,
      receipt.branchName,
      `Order ${receipt.orderNumber} / ${receipt.channel}`,
      receipt.businessDate,
      receipt.settledAt,
      `Split ${receipt.splitKind}`,
      ...receipt.lines.map(
        (line) =>
          `${line.quantity} x ${line.name} @ ${line.unitPrice}\n  Line subtotal ${line.lineSubtotal} / Line total ${line.lineTotal} / Comp ${line.compAmount}`
      ),
      `Subtotal ${receipt.totals.subtotal}`,
      `Delivery ${receipt.totals.deliveryFeeTotal}`,
      `Service charge ${receipt.totals.serviceChargeTotal}`,
      `Tax ${receipt.totals.taxTotal}`,
      `Comp ${receipt.totals.compTotal}`,
      `Rounding ${receipt.totals.roundingAdjustment}`,
      `TOTAL ${receipt.totals.grandTotal}`,
      ...receipt.tenders.map(
        (t) =>
          `${t.type} ${t.amount}\nTip ${t.tipAmount}${t.changeGiven === null ? '' : ` / Change ${t.changeGiven}`}`
      ),
      'Browser copy',
    ].join('\n');
  doc.body.replaceChildren(content);
  popup.focus();
  popup.print();
}
