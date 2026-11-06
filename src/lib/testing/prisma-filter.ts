/**
 * TEST-ONLY (see `eslint.config.mjs`). Evaluates a Prisma-style `where` filter
 * against an in-memory row, so suites can check a filter builder and its
 * in-memory twin against the same rows.
 */
type Row = Record<string, unknown>;

function matchesField(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null;
  if (condition instanceof Date) return value instanceof Date && +value === +condition;
  if (typeof condition !== 'object') return value === condition;
  return Object.entries(condition as Record<string, unknown>).every(([op, operand]) => {
    if (op === 'equals') return matchesField(value, operand);
    if (!(value instanceof Date) || !(operand instanceof Date)) return false;
    if (op === 'gt') return value > operand;
    if (op === 'lte') return value <= operand;
    throw new Error(`Unsupported operator ${op}`);
  });
}

/** Evaluates a Prisma-style filter (AND/OR, gt/lte/equals, null) the way Postgres would. */
export function matchesFilter(row: Row, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as Record<string, unknown>[]).some((part) => matchesFilter(row, part));
    }
    if (key === 'AND') {
      return (condition as Record<string, unknown>[]).every((part) => matchesFilter(row, part));
    }
    return matchesField(row[key], condition);
  });
}
