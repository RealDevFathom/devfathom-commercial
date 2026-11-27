/**
 * WHA-1603 — INV-07 packing slip for the browser/OS print path.
 *
 * Same contract as `lib/pharmacy/counter-browser-print`: the same paper choices,
 * an allowlisted model rendered as escaped inert text into an isolated pop-up
 * (no opener, no copied DOM), and a print request that never claims paper came
 * out. The slip carries physical facts only — medicine, batch, expiry, packs and
 * locations — and no cost, price or patient data.
 */
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import { printInWindow } from '@/lib/browser-print/print-window';
import type { CounterReceiptFormat } from '@/lib/pharmacy/counter-browser-print';
import { formatLotExpiry } from '@/lib/pharmacy/product-class';
import { batchPhrase } from '@/lib/pharmacy/unrecorded-batch';

export type PackingSlipLine = {
  medicineName: string;
  /** DEV-853: null when the batch number was never recorded. */
  batchNumber: string | null;
  /** DEV-853: null when the expiry was never recorded. */
  expiresAt: string | null;
  sourceLocation: string;
  destinationLocation: string;
  quantityUnits: number;
  sealedPacks: number;
  looseUnits: number;
  unitsPerPack: number;
};

export type PackingSlip = {
  timeZone?: string;
  reference: string;
  status: string;
  fromBranch: string;
  toBranch: string;
  allocatedBy: string | null;
  approvedBy: string | null;
  dispatchedBy: string | null;
  dispatchedAt: string | null;
  lines: PackingSlipLine[];
};

export const PACKING_SLIP_FORMATS: ReadonlyArray<{ value: CounterReceiptFormat; label: string }> = [
  { value: 'A4', label: 'A4 sheet' },
  { value: 'THERMAL', label: '80 mm thermal' },
  { value: 'THERMAL_58', label: '58 mm thermal' },
];

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

/** ISO calendar day: unambiguous on paper whatever the printing browser's locale. */
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Plain-text slip body; narrow paper gets one field per line instead of a table. */
export function buildPackingSlipText(slip: PackingSlip, columns: number): string {
  const rule = '-'.repeat(columns);
  const out = [
    'PACKING SLIP — INTER-BRANCH TRANSFER',
    `Transfer ${slip.reference}`,
    rule,
    `From: ${slip.fromBranch}`,
    `To:   ${slip.toBranch}`,
    `Allocated by: ${slip.allocatedBy ?? '—'}`,
    `Approved by:  ${slip.approvedBy ?? '—'}`,
    `Dispatched:   ${slip.dispatchedAt ? `${pharmacyCalendarDay(slip.timeZone, new Date(slip.dispatchedAt))} by ${slip.dispatchedBy ?? '—'}` : 'not yet'}`,
    rule,
  ];
  slip.lines.forEach((line, index) => {
    out.push(
      `${index + 1}. ${line.medicineName}`,
      `   ${batchPhrase(line.batchNumber)} · ${formatLotExpiry(line.expiresAt, (value) => `exp ${day(value)}`)}`,
      `   ${line.quantityUnits} units = ${line.sealedPacks} sealed × ${line.unitsPerPack} + ${line.looseUnits} loose`,
      `   Pick: ${line.sourceLocation}`,
      `   Put:  ${line.destinationLocation}`,
      '   Received: ______   Short: ______'
    );
  });
  const total = slip.lines.reduce((sum, line) => sum + line.quantityUnits, 0);
  out.push(
    rule,
    `${slip.lines.length} line(s) · ${total} units`,
    '',
    'Dispatched by (sign): ____________________',
    'Carried by (sign):    ____________________',
    'Received by (sign):   ____________________',
    'Witness to any shortfall: ________________'
  );
  return out.join('\n');
}

export function buildPackingSlipHtml(slip: PackingSlip, format: CounterReceiptFormat): string {
  if (!['THERMAL', 'THERMAL_58', 'A4'].includes(format))
    throw new Error('Choose a supported paper size.');
  if (slip.lines.length === 0) throw new Error('This transfer has no lines to print.');
  const width = format === 'THERMAL_58' ? '58mm' : format === 'THERMAL' ? '80mm' : '190mm';
  const columns = format === 'THERMAL_58' ? 32 : format === 'THERMAL' ? 42 : 72;
  // Every value is escaped inert text. Physical print styles only.
  return `<!doctype html><html lang="en" dir="ltr"><head>
<meta charset="utf-8"><title>${escapeHtml(`Packing slip ${slip.reference}`)}</title>
<style>@page { size: ${format === 'A4' ? 'A4' : 'auto'}; margin: ${format === 'A4' ? '10mm' : '0'}; }
* { box-sizing: border-box; } body { margin: 0; width: ${width}; max-width: 100%; padding: 3mm; font: 12px monospace; color: black; background: white; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }</style>
</head><body><pre>${escapeHtml(buildPackingSlipText(slip, columns))}</pre></body></html>`;
}

/** Opens only the isolated slip. Returning does not confirm physical printing. */
export function printPackingSlip(slip: PackingSlip, format: CounterReceiptFormat): Promise<void> {
  const html = buildPackingSlipHtml(slip, format);
  // DEV-973: an isolated window that prints itself, so this page never freezes.
  return printInWindow(html, {
    features: 'popup,width=640,height=820',
    blockedMessage: 'Allow pop-ups for this site, then retry Print packing slip.',
    failedMessage: 'The browser print dialog could not open. Retry Print packing slip.',
  });
}
