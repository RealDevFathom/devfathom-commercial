export type BillLineOption = {
  id: string;
  name: string;
  quantity: number;
  lineSubtotal: string;
};

/**
 * Build the labels shown by the comp bill-line picker.
 *
 * The bill-line id remains the option value, while the one-based position gives an
 * operator a visible, stable-in-this-list way to distinguish repeated snapshots of
 * the same menu item. Do this for every line rather than only duplicate names so the
 * picker does not change labels as lines are removed or become ineligible.
 */
export function labelBillLineOptions(lines: readonly BillLineOption[]) {
  return lines.map((line, index) => ({
    ...line,
    label: `Line ${index + 1} · ${line.quantity} × ${line.name} · ${line.lineSubtotal}`,
  }));
}
