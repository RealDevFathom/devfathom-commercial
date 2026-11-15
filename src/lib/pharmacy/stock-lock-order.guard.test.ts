/**
 * DEV-825 — guard: every explicit stock-row lock (batch, medicine, lot,
 * balance) and the controlled-register lock is taken through
 * stock-lock-order.ts, which sorts its keys and takes the classes in the one
 * global order. A locking clause on those rows anywhere else could take them in
 * its own order and deadlock against the rest, so it fails this test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(__dirname, '..', '..');
const HELPER = join('lib', 'pharmacy', 'stock-lock-order.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const STOCK_TABLES =
  /pharmacy_stock_balances|pharmacy_inventory_lots|pharmacy_manufacturing_batches|pharmacy_medicines/;
/** Aliases the pharmacy stock queries give those tables. */
const STOCK_ALIASES = new Set(['balance', 'bal', 'b', 'lot', 'l', 'batch', 'mb', 'medicine']);
const LOCK_CLAUSE = /FOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)(?:\s+OF\s+([\w",\s]+))?/g;
const REGISTER_LOCK =
  /pg_advisory_xact_lock\(\s*hashtextextended\(\s*\$\{\s*[\w.]+\s*\+\s*':'\s*\+\s*[\w.]*branchId\s*\}/;

/** Every stock-row locking clause or register lock outside the helper, as file:line. */
function stockLockOffenders(files: Array<{ path: string; text: string }>) {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    if (path === HELPER) continue;
    const at = (index: number) => `${path}:${text.slice(0, index).split('\n').length}`;
    for (const match of text.matchAll(LOCK_CLAUSE)) {
      const index = match.index ?? 0;
      // The statement the clause belongs to: back to the call or declaration that
      // builds it, so nested template fragments do not hide its tables.
      const start = Math.max(
        ...['$queryRaw', '$executeRaw', 'const ', 'return '].map((marker) =>
          text.lastIndexOf(marker, index)
        )
      );
      const statement = text.slice(Math.max(start, 0), index);
      const aliases = (match[1] ?? '')
        .split(',')
        .map((alias) => alias.replace(/"/g, '').trim().split(/\s+/)[0]!)
        .filter(Boolean);
      const lockedAliases = aliases.filter((alias) => STOCK_ALIASES.has(alias));
      const stockStatement = STOCK_TABLES.test(statement);
      if (aliases.length ? lockedAliases.length > 0 && /pharmacy/.test(path) : stockStatement)
        offenders.push(at(index));
    }
    for (const match of text.matchAll(new RegExp(REGISTER_LOCK, 'g')))
      offenders.push(at(match.index ?? 0));
  }
  return offenders;
}

/** Blank out comments (keeping line numbers) so prose about locks is not scanned. */
function withoutComments(text: string) {
  const blank = (comment: string) => comment.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^\s*\/\/.*$/gm, blank);
}

const files = sourceFiles(srcRoot).map((path) => ({
  path: path.slice(srcRoot.length + 1),
  text: withoutComments(readFileSync(path, 'utf8')),
}));

describe('stock locks go through the shared lock-order helper', () => {
  it('finds no stock-row or register lock outside stock-lock-order.ts', () => {
    expect(stockLockOffenders(files)).toEqual([]);
  });

  it('scans the real lock sites (the helper itself would be caught)', () => {
    const helper = files.find(({ path }) => path === HELPER)!;
    // Its two balance statements and the register lock (the batch, medicine and
    // lot clauses are built by `rowLock`, outside any stock statement's text).
    const caught = stockLockOffenders([{ ...helper, path: 'lib/pharmacy/elsewhere.ts' }]);
    expect(caught).toHaveLength(3);
  });

  it.each([
    ['a joined lock', 'sql`SELECT 1 FROM x ${JOINS} FOR UPDATE OF balance`'],
    [
      'a plain stock-table lock',
      'sql`SELECT id FROM "pharmacy_inventory_lots" WHERE id=1 FOR UPDATE`',
    ],
    [
      'a shared batch lock',
      'sql`SELECT 1 FROM pharmacy_inventory_lots l JOIN y mb ON 1=1 FOR SHARE OF mb`',
    ],
    [
      'an inline register lock',
      "db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':' + scope.branchId},0))`",
    ],
  ])('flags %s', (_label, text) => {
    expect(stockLockOffenders([{ path: 'lib/pharmacy/example.ts', text }])).toHaveLength(1);
  });

  it.each([
    ['a document lock', 'sql`SELECT id FROM pharmacy_sales WHERE id=1 FOR UPDATE`'],
    ['a reservation lock', 'sql`${query} FOR UPDATE OF reservation`'],
    [
      'a request-scoped advisory lock',
      "sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':return:' + key}, 0))`",
    ],
  ])('allows %s', (_label, text) => {
    expect(stockLockOffenders([{ path: 'lib/pharmacy/example.ts', text }])).toEqual([]);
  });
});
