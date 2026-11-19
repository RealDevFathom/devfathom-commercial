import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { splitSqlStatements } from '../split-sql-statements';

/**
 * DEV-951: static reading of prisma/migrations for one hazard. A table with FORCE ROW LEVEL
 * SECURITY whose policies have no `app.is_platform_admin` clause shows a NOSUPERUSER
 * NOBYPASSRLS migration owner nothing unless `app.current_organization_id` is set. A
 * migration that reads or writes such a table before setting it silently does nothing.
 *
 * The table list is derived from the migrations themselves, in the order Prisma applies them:
 * `ALTER TABLE ... [NO] FORCE ROW LEVEL SECURITY`, `CREATE / ALTER / DROP POLICY`, table
 * renames and drops, including the `EXECUTE format(...)` loops in DO blocks.
 */

export type TenantContextOffender = { migration: string; table: string };

type TableState = { forced: boolean; policies: Map<string, boolean> };

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;

function unquote(name: string): string {
  const last = name.split('.').pop()!.trim();
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

/** Removes `--` and `/* *\/` comments outside strings and dollar quotes, keeping offsets. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let dollar: string | null = null;
  let quote = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        out += dollar;
        i += dollar.length - 1;
        dollar = null;
      } else out += ch;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") {
      quote = true;
      out += ch;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        dollar = tag;
        out += tag;
        i += tag.length - 1;
        continue;
      }
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Blanks the contents of single-quoted strings (keeping offsets), so names in messages are not references. */
function blankStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, (literal) => `'${' '.repeat(literal.length - 2)}'`);
}

/** A set_config / SET of the tenant setting to a real value (not a reset to '' or NULL). */
const SETS_TENANT = new RegExp(
  String.raw`set_config\s*\(\s*'app\.current_organization_id'\s*,(?!\s*''\s*,)(?!\s*NULL\b)|` +
    String.raw`\bSET\s+(?:LOCAL\s+|SESSION\s+)?"?app\.current_organization_id"?\s*(?:=|TO)(?!\s*(?:''|NULL\b|DEFAULT\b))`,
  'i'
);

const PLATFORM = /app\.is_platform_admin/i;

export class MigrationTenantContextAnalyzer {
  private readonly tables = new Map<string, TableState>();
  readonly offenders: TenantContextOffender[] = [];

  /** Tables that, after everything applied so far, are forced and have no platform clause. */
  tenantOnlyTables(): string[] {
    return [...this.tables]
      .filter(([, state]) => this.isTenantOnly(state))
      .map(([name]) => name)
      .sort();
  }

  private isTenantOnly(state: TableState | undefined): boolean {
    return !!state && state.forced && ![...state.policies.values()].some(Boolean);
  }

  private state(table: string): TableState {
    let state = this.tables.get(table);
    if (!state) {
      state = { forced: false, policies: new Map() };
      this.tables.set(table, state);
    }
    return state;
  }

  /** Applies one RLS-relevant DDL statement (static text, comments removed). */
  private applyDdl(statement: string): void {
    const s = statement.trim();
    let m: RegExpExecArray | null;
    if (
      (m = new RegExp(String.raw`^CREATE\s+POLICY\s+(${IDENT})\s+ON\s+(${QUALIFIED})`, 'i').exec(s))
    ) {
      this.state(unquote(m[2]!)).policies.set(unquote(m[1]!), PLATFORM.test(s));
      return;
    }
    if (
      (m = new RegExp(
        String.raw`^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${QUALIFIED})`,
        'i'
      ).exec(s))
    ) {
      this.tables.get(unquote(m[2]!))?.policies.delete(unquote(m[1]!));
      return;
    }
    if (
      (m = new RegExp(String.raw`^ALTER\s+POLICY\s+(${IDENT})\s+ON\s+(${QUALIFIED})`, 'i').exec(s))
    ) {
      const state = this.state(unquote(m[2]!));
      const rename = new RegExp(String.raw`\bRENAME\s+TO\s+(${IDENT})`, 'i').exec(s);
      const name = unquote(m[1]!);
      if (rename) {
        const value = state.policies.get(name) ?? false;
        state.policies.delete(name);
        state.policies.set(unquote(rename[1]!), value);
      } else if (/\b(USING|WITH\s+CHECK)\b/i.test(s)) state.policies.set(name, PLATFORM.test(s));
      return;
    }
    if (
      (m = new RegExp(
        String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})`,
        'i'
      ).exec(s))
    ) {
      const table = unquote(m[1]!);
      const rename = new RegExp(
        String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s+RENAME\s+TO\s+(${IDENT})`,
        'i'
      ).exec(s);
      if (rename) {
        const state = this.tables.get(table);
        if (state) {
          this.tables.delete(table);
          this.tables.set(unquote(rename[1]!), state);
        }
        return;
      }
      if (/\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s)) this.state(table).forced = false;
      else if (/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s)) this.state(table).forced = true;
      return;
    }
    if (
      (m = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+?)(?:\s+(?:CASCADE|RESTRICT))?\s*$/i.exec(s))
    ) {
      for (const name of m[1]!.split(',')) this.tables.delete(unquote(name.trim()));
    }
  }

  /** The `EXECUTE format('<template>', args)` calls of a DO block. */
  private applyDynamicDdl(body: string, knownTables: Set<string>): void {
    const literals = new Set(
      [...body.matchAll(/'([a-z_][a-z0-9_]*)'/g)]
        .map((m) => m[1]!)
        .filter((n) => knownTables.has(n))
    );
    for (const call of body.matchAll(/EXECUTE\s+format\s*\(\s*/gi)) {
      const start = call.index! + call[0].length;
      const rest = body.slice(start);
      let template: string;
      let after: number;
      const dollar = /^\$[A-Za-z0-9_]*\$/.exec(rest)?.[0];
      if (dollar) {
        const end = rest.indexOf(dollar, dollar.length);
        if (end === -1) continue;
        template = rest.slice(dollar.length, end);
        after = end + dollar.length;
      } else {
        const quoted = /^'((?:[^']|'')*)'/.exec(rest);
        if (!quoted) continue;
        template = quoted[1]!.replace(/''/g, "'");
        after = quoted[0].length;
      }
      const tail = rest.slice(after);
      const args = tail.slice(0, tail.search(/;|$/)).replace(/\)\s*$/, '');
      // Templates over one table variable: ALTER TABLE %I ..., CREATE/DROP POLICY <name> ON %I.
      // A %s argument carries the policy expression; it decides whether a platform clause exists.
      const nameArg =
        args
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)[0] ?? '';
      const suffix = /\|\|\s*'([^']*)'/.exec(nameArg)?.[1];
      for (const table of literals) {
        const policyName =
          /^'([^']*)'$/.exec(nameArg)?.[1] ?? (suffix !== undefined ? table + suffix : table);
        const concrete = template
          .trim()
          .replace(/(POLICY\s+(?:IF\s+EXISTS\s+)?)%I/i, `$1"${policyName}"`)
          .replace(/%I/g, `"${table}"`)
          .replace(/%s/g, `(${args})`);
        this.applyDdl(concrete);
      }
    }
  }

  private flag(migration: string, text: string, offset: number, contextAt: number): void {
    const blanked = blankStrings(text);
    const refs = new RegExp(
      String.raw`\b(?:FROM|JOIN|INTO|UPDATE|USING)\s+(?:ONLY\s+)?(${QUALIFIED})`,
      'gi'
    );
    for (const m of blanked.matchAll(refs)) {
      const table = unquote(m[1]!);
      if (!this.isTenantOnly(this.tables.get(table))) continue;
      if (contextAt !== -1 && contextAt < offset + m.index!) continue;
      if (!this.offenders.some((o) => o.migration === migration && o.table === table))
        this.offenders.push({ migration, table });
    }
  }

  /** Reads one migration file in order: DDL updates the table states, DML is checked against them. */
  analyze(migration: string, sql: string, knownTables: Set<string>): void {
    const executed = stripSqlComments(sql);
    let consumed = 0;
    // Offset (in the executed text) of the first statement that sets the tenant, or -1.
    let contextAt = -1;
    for (const statement of splitSqlStatements(executed)) {
      const offset = executed.indexOf(statement, consumed);
      consumed = offset + statement.length;
      const head = statement.replace(/^\s+/, '');
      if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(head)) continue;
      const setAt = statement.search(SETS_TENANT);
      if (contextAt === -1 && setAt !== -1) contextAt = offset + setAt;
      if (/^DO\b/i.test(head)) {
        const body = /\$([A-Za-z0-9_]*)\$([\s\S]*)\$\1\$/.exec(statement);
        if (!body) continue;
        const bodyOffset = offset + statement.indexOf(body[2]!);
        // Static DDL inside the block, usually behind IF [NOT] EXISTS (...) THEN.
        for (const inner of splitSqlStatements(body[2]!)) {
          const start = blankStrings(inner).search(
            /\b(?:CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY|ALTER\s+TABLE|DROP\s+TABLE)\b/i
          );
          if (start !== -1) this.applyDdl(inner.slice(start));
        }
        this.applyDynamicDdl(body[2]!, knownTables);
        this.flag(migration, body[2]!, bodyOffset, contextAt);
        continue;
      }
      if (
        /^(?:SELECT|INSERT|UPDATE|DELETE|WITH|MERGE)\b/i.test(head) ||
        /^CREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE|MATERIALIZED\s+VIEW)\b[\s\S]*?\bAS\s*\(?\s*(?:SELECT|WITH)\b/i.test(
          head
        )
      ) {
        this.flag(migration, statement, offset, contextAt);
        continue;
      }
      this.applyDdl(head);
    }
  }
}

export const MIGRATIONS_DIR = 'prisma/migrations';

export function migrationNames(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every table any migration creates (the candidates for a DO block's table-name literals). */
export function createdTables(sqls: string[]): Set<string> {
  const tables = new Set<string>();
  const create = new RegExp(
    String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
    'gi'
  );
  for (const sql of sqls) for (const m of sql.matchAll(create)) tables.add(unquote(m[1]!));
  return tables;
}

/** Applies every migration in Prisma order and returns the analyzer with its findings. */
export function analyzeMigrations(dir = MIGRATIONS_DIR): MigrationTenantContextAnalyzer {
  const names = migrationNames(dir);
  const sqls = names.map((name) => readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
  const known = createdTables(sqls.map(stripSqlComments));
  const analyzer = new MigrationTenantContextAnalyzer();
  names.forEach((name, index) => analyzer.analyze(name, sqls[index]!, known));
  return analyzer;
}
