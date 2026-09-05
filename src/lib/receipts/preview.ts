import { z } from 'zod';
import { ReceiptLayoutSchema, type ReceiptLayout } from './configuration';

const fact = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[\x20-\x7e\n]+$/);
export const ReceiptPreviewFactsSchema = z
  .object({
    businessName: fact,
    invoiceNumber: fact,
    issuedAt: fact,
    lines: z.array(fact).min(1).max(200),
    taxLines: z.array(fact).min(1).max(100),
    totals: z.array(fact).min(1).max(100),
    payments: z.array(fact).min(1).max(100),
    orderNumber: fact.optional(),
    channel: fact.optional(),
  })
  .strict();
export type ReceiptPreviewFacts = z.infer<typeof ReceiptPreviewFactsSchema>;

/** Fixed-cell baseline, not a claim about any particular printer's printable area. */
export function receiptColumns(layout: ReceiptLayout): number {
  return ReceiptLayoutSchema.parse(layout).paperWidth === 58 ? 32 : 48;
}

export function wrapReceiptText(value: string, columns: number): string[] {
  if (!Number.isInteger(columns) || columns < 1 || columns > 48)
    throw new Error('Invalid receipt columns.');
  return value.split('\n').flatMap((line) => {
    const result: string[] = [];
    while (line.length > columns) {
      const space = line.lastIndexOf(' ', columns);
      const end = space > 0 ? space : columns;
      result.push(line.slice(0, end));
      line = line.slice(end + (space > 0 ? 1 : 0));
    }
    result.push(line);
    return result;
  });
}

/** Shared preview/renderer input. Facts come from a settled snapshot, never calculated here. */
export function buildReceiptPreview(input: ReceiptLayout, snapshot: ReceiptPreviewFacts): string {
  const layout = ReceiptLayoutSchema.parse(input);
  const facts = ReceiptPreviewFactsSchema.parse(snapshot);
  const columns = receiptColumns(layout);
  const divider = '-'.repeat(columns);
  const lines = [
    facts.businessName,
    layout.businessText,
    layout.headerText,
    `Invoice: ${facts.invoiceNumber}`,
    facts.issuedAt,
    layout.showOrderNumber && facts.orderNumber ? `Order: ${facts.orderNumber}` : '',
    layout.showChannel && facts.channel ? `Channel: ${facts.channel}` : '',
    divider,
    ...facts.lines,
    divider,
    ...facts.taxLines,
    ...facts.totals,
    divider,
    ...facts.payments,
    layout.footerText,
  ];
  return lines
    .filter(Boolean)
    .flatMap((line) => wrapReceiptText(line, columns))
    .join('\n');
}

export const SAMPLE_RECEIPT: ReceiptPreviewFacts = {
  businessName: 'Example Restaurant',
  invoiceNumber: 'SAMPLE-001',
  issuedAt: '2026-09-05 12:00',
  orderNumber: '42',
  channel: 'Dine in',
  lines: ['2 x Lunch @ PKR 500.00 = PKR 1000.00'],
  taxLines: ['Tax (sample 5%): PKR 50.00'],
  totals: ['Subtotal: PKR 1000.00', 'Total: PKR 1050.00'],
  payments: ['Cash: PKR 1100.00', 'Change: PKR 50.00'],
};
