export type BillLineOptionSource = {
  id: string;
  name: string;
  quantity: number;
  lineSubtotal: string;
};

/**
 * Option labels for picking one bill line. Lines that would render identically
 * ("1 × Tikka Bun — 14.00" twice) get a "line N of M" discriminator, numbered by
 * position among the bill's lines so the number is stable as lines get comped.
 */
export function billLineOptionLabels(
  allLines: readonly BillLineOptionSource[],
  pickable: readonly BillLineOptionSource[] = allLines
): Map<string, string> {
  const base = (line: BillLineOptionSource) =>
    `${line.quantity} × ${line.name} — ${line.lineSubtotal}`;
  const groups = new Map<string, string[]>();
  for (const line of allLines) {
    const key = base(line);
    groups.set(key, [...(groups.get(key) ?? []), line.id]);
  }
  const labels = new Map<string, string>();
  for (const line of pickable) {
    const ids = groups.get(base(line)) ?? [line.id];
    labels.set(
      line.id,
      ids.length > 1
        ? `${base(line)} (line ${ids.indexOf(line.id) + 1} of ${ids.length})`
        : base(line)
    );
  }
  return labels;
}
