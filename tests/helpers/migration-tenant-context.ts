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
 *
 * DEV-954 widened what counts as a read or write and what counts as setting the tenant:
 * - tables later in a comma-separated FROM / USING list (`FROM a, b`, `UPDATE t ... FROM a, b`),
 *   `TABLE t` queries (`CREATE TABLE x AS TABLE t`, `INSERT INTO x TABLE t`) and statements
 *   that open with a parenthesis (`(SELECT ...)`);
 * - a tenant set to a constant (a literal id) reaches one organisation only, so it does not
 *   count as setting the tenant for a backfill;
 * - a tenant set inside an IF / ELSIF / ELSE or CASE branch counts only inside that branch,
 *   since the branch may never run;
 * - dynamic SQL in a DO block (see `DYNAMIC_SQL`).
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

/**
 * Every write of the tenant setting: set_config(name, value, is_local), SET [LOCAL|SESSION]
 * name = value, and RESET name / RESET ALL. A value of '' or NULL (or DEFAULT) clears it.
 */
const TENANT_SETTING = new RegExp(
  String.raw`set_config\s*\(\s*'app\.current_organization_id'\s*,\s*([^,]*?)\s*,\s*([^)]*?)\s*\)|` +
    String.raw`\bSET\s+(LOCAL\s+|SESSION\s+)?"?app\.current_organization_id"?\s*(?:=|TO)\s*('(?:[^']|'')*'|[^;\s]+)|` +
    String.raw`\bRESET\s+(?:"?app\.current_organization_id"?|ALL)\b`,
  'gi'
);

/** A change of the tenant setting at an offset; `expire` is the end of a transaction. */
type ContextEvent = { at: number } & (
  | { kind: 'set'; active: boolean; local: boolean; until?: number }
  | { kind: 'reset' }
  | { kind: 'expire' }
);

function clears(value: string): boolean {
  return /^(?:''|NULL|DEFAULT)$/i.test(value.trim());
}

/**
 * A literal value names one fixed organisation: a backfill run under it skips every other one.
 * In set_config the value is an expression, so only a quoted literal or a number is constant; a
 * SET value is always written out, so any word or literal is (a `%L` placeholder in an EXECUTE
 * template is not).
 */
function constantFunctionValue(value: string): boolean {
  return /^(?:E?'(?:[^']|'')*'|-?\d+)(?:\s*::\s*[A-Za-z_][A-Za-z0-9_ ]*)*$/i.test(value.trim());
}

function constantSetValue(value: string): boolean {
  return /^(?:'(?:[^']|'')*'|[A-Za-z0-9_.-]+)$/.test(value.trim());
}

function contextEvents(statement: string, offset: number): ContextEvent[] {
  const events: ContextEvent[] = [];
  for (const m of statement.matchAll(TENANT_SETTING)) {
    const at = offset + m.index!;
    if (m[1] !== undefined)
      events.push({
        at,
        kind: 'set',
        active: !clears(m[1]) && !constantFunctionValue(m[1]),
        local: !/^false$/i.test(m[2]!.trim()),
      });
    else if (m[4] !== undefined)
      events.push({
        at,
        kind: 'set',
        active: !clears(m[4]) && !constantSetValue(m[4]),
        local: /^LOCAL/i.test(m[3] ?? ''),
      });
    else events.push({ at, kind: 'reset' });
  }
  return events;
}

/** Whether the tenant is set at `position`, given the events of the file so far. */
function tenantSetAt(events: ContextEvent[], position: number): boolean {
  let active = false;
  let local = false;
  for (const event of events) {
    if (event.at >= position) break;
    if (event.kind === 'set') {
      // A set inside a branch does not hold after the branch: it may never have run.
      if (event.active && event.until !== undefined && position >= event.until) continue;
      ({ active, local } = event);
    } else if (event.kind === 'reset' || local) active = false;
  }
  return active;
}

/**
 * The IF / ELSIF / ELSE and CASE WHEN / ELSE branches of a PL/pgSQL body (strings blanked), as
 * [start, end) offsets. A statement-level keyword follows `;`, THEN, ELSE, LOOP or BEGIN (or opens
 * the body); that tells `IF ... THEN` from DDL's `IF [NOT] EXISTS`, and CASE statements from CASE
 * expressions, whose WHEN and ELSE never follow a `;`.
 */
export function plpgsqlBranches(body: string): Array<{ start: number; end: number }> {
  const branches: Array<{ start: number; end: number }> = [];
  const stack: Array<{ kind: 'if' | 'case'; start: number }> = [];
  let previous = '';
  let previousEnd = 0;
  for (const m of body.matchAll(
    /\b(?:END\s+IF|END\s+CASE|ELSIF|ELSEIF|ELSE|IF|CASE|WHEN|THEN|LOOP|BEGIN)\b|;/gi
  )) {
    const token = m[0].toUpperCase().replace(/\s+/g, ' ');
    const adjacent = body.slice(previousEnd, m.index).trim() === '';
    const statementStart =
      adjacent && ['', ';', 'THEN', 'ELSE', 'LOOP', 'BEGIN'].includes(previous);
    const top = stack.at(-1);
    const close = (at: number) => branches.push({ start: top!.start, end: at });
    if ((token === 'IF' || token === 'CASE') && statementStart)
      stack.push({ kind: token === 'IF' ? 'if' : 'case', start: m.index! });
    else if (
      top?.kind === 'if' &&
      ['ELSIF', 'ELSEIF', 'ELSE'].includes(token) &&
      previous === ';' &&
      adjacent
    ) {
      close(m.index!);
      top.start = m.index!;
    } else if (
      top?.kind === 'case' &&
      ['WHEN', 'ELSE'].includes(token) &&
      previous === ';' &&
      adjacent
    ) {
      close(m.index!);
      top.start = m.index!;
    } else if (
      (token === 'END IF' && top?.kind === 'if') ||
      (token === 'END CASE' && top?.kind === 'case')
    ) {
      close(m.index! + m[0].length);
      stack.pop();
    }
    previous = token;
    previousEnd = m.index! + m[0].length;
  }
  return branches;
}

/**
 * Dynamic SQL cannot be read statically, so DEV-954 sets this rule for every `EXECUTE` in a
 * migration DO block (EXECUTE FUNCTION / PROCEDURE of a trigger excepted):
 * 1. A command whose literal text starts with DDL (ALTER, CREATE other than a table or
 *    materialized view `AS` a query, DROP, COMMENT, GRANT, REVOKE, TRUNCATE, ...) reads no
 *    rows under RLS, so it needs no tenant.
 * 2. A literal command with no `%I` / `%s` placeholder and no concatenation is read like any
 *    other statement: each tenant-only table it names needs the tenant set at the EXECUTE.
 * 3. Anything else could name any table, so the tenant must be set at the EXECUTE (an explicit
 *    per-organisation loop around it), or the EXECUTE line or the comment lines right above it
 *    must carry `-- tenant-context: allow <reason>`, a reason of at least ten characters for
 *    the reviewer. Otherwise it is reported against the pseudo-table `DYNAMIC_SQL`.
 * A false alarm costs one comment; a miss is a backfill that silently skips every shop. Every
 * EXECUTE in the migrations reviewed for DEV-954 is DDL, so the rule raises no existing alarm.
 */
export const DYNAMIC_SQL = '<dynamic sql>';

const ALLOW_DYNAMIC = /--\s*tenant-context:\s*allow\b[\s:-]*(\S.*)$/i;

function dynamicSqlAllowed(sql: string, position: number): boolean {
  const lines = sql.slice(0, position).split('\n');
  const reason = (line: string) => (ALLOW_DYNAMIC.exec(line)?.[1]?.trim().length ?? 0) >= 10;
  const lineEnd = sql.indexOf('\n', position);
  if (reason(lines.at(-1)! + sql.slice(position, lineEnd === -1 ? sql.length : lineEnd)))
    return true;
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('--')) break;
    if (reason(line)) return true;
  }
  return false;
}

const DDL_COMMAND =
  /^\s*(?:ALTER|DROP|COMMENT|GRANT|REVOKE|TRUNCATE|LOCK|ANALYZE|REINDEX|CLUSTER|SET|RESET|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(?:RECURSIVE\s+)?VIEW|CREATE\b(?![\s\S]*\bAS\s*\(?\s*(?:SELECT|WITH|TABLE|VALUES)\b))\b/i;

/** The literal text an EXECUTE runs, and whether it is fully static. */
function executedCommand(rest: string): { text: string; dynamic: boolean } | null {
  const format = /^format\s*\(\s*/i.exec(rest);
  const start = format ? format[0].length : 0;
  const tail = rest.slice(start);
  let text: string;
  let after: number;
  const dollar = /^\$[A-Za-z0-9_]*\$/.exec(tail)?.[0];
  if (dollar) {
    const end = tail.indexOf(dollar, dollar.length);
    if (end === -1) return null;
    text = tail.slice(dollar.length, end);
    after = end + dollar.length;
  } else {
    const quoted = /^E?'((?:[^']|'')*)'/i.exec(tail);
    if (!quoted) return null;
    text = quoted[1]!.replace(/''/g, "'");
    after = quoted[0].length;
  }
  let remainder = tail.slice(after);
  if (format) {
    // Step past the rest of the format(...) call, so `format(...) || x` is seen as concatenated.
    let depth = 0;
    let end = remainder.length;
    for (let i = 0; i < remainder.length; i += 1) {
      const literal = /^(?:E?'(?:[^']|'')*'|(\$[A-Za-z0-9_]*\$)[\s\S]*?\1)/i.exec(
        remainder.slice(i)
      );
      if (literal) {
        i += literal[0].length - 1;
        continue;
      }
      if (remainder[i] === '(') depth += 1;
      else if (remainder[i] === ')' && depth-- === 0) {
        end = i + 1;
        break;
      }
    }
    remainder = remainder.slice(end);
  }
  const concatenated = /^\s*\|\|/.test(remainder);
  // %I and %s, also with a position (%1$I) or a width (%-10s, %*s, %*2$s).
  const placeholders = format !== null && /%(?:\d+\$)?-?(?:\d+|\*(?:\d+\$)?)?[Is]/.test(text);
  return { text, dynamic: concatenated || placeholders };
}

const PLATFORM = /app\.is_platform_admin/i;

/** Words that end a FROM / USING list at its own depth. */
const LIST_END = new RegExp(
  String.raw`(?:WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|FETCH|WINDOW|UNION|INTERSECT|EXCEPT|RETURNING|ON\s+CONFLICT|FOR|LOOP|THEN|INTO|WHEN|DO)\b`,
  'iy'
);
const LIST_ITEM = new RegExp(String.raw`\s*(?:LATERAL\s+)?(?:ONLY\s+)?(${QUALIFIED})`, 'iy');

/** The tables a statement reads or writes (strings blanked), with their offsets in it. */
export function tableReferences(text: string): Array<{ name: string; index: number }> {
  const found: Array<{ name: string; index: number }> = [];
  const push = (m: RegExpMatchArray, group = 1) =>
    found.push({ name: unquote(m[group]!), index: m.index! + m[0].length - m[group]!.length });
  for (const m of text.matchAll(
    new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE|USING)\s+(?:ONLY\s+)?(${QUALIFIED})`, 'gi')
  ))
    push(m);
  // `TABLE t` is `SELECT * FROM t`: after AS, a parenthesis, a set operator or INSERT INTO x.
  for (const m of text.matchAll(
    new RegExp(
      String.raw`(?:^|\(|\bAS|\bUNION|\bINTERSECT|\bEXCEPT|\bALL|\bDISTINCT|\bINSERT\s+INTO\s+${QUALIFIED}(?:\s+AS\s+${IDENT})?(?:\s*\([^)]*\))?)\s*TABLE\s+(?:ONLY\s+)?(${QUALIFIED})`,
      'gi'
    )
  ))
    push(m);
  // Every later item of a comma-separated FROM / USING list, up to the end of the list at its
  // own parenthesis depth. `IS DISTINCT FROM` compares values and opens no list.
  for (const m of text.matchAll(/\b(?:FROM|USING)\b/gi)) {
    if (/\bDISTINCT\s+$/i.test(text.slice(Math.max(0, m.index! - 16), m.index!))) continue;
    let depth = 0;
    for (let i = m.index! + m[0].length; i < text.length; i += 1) {
      const ch = text[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth < 0) break;
      } else if (ch === ';') break;
      else if (depth > 0) continue;
      else if (ch === ',') {
        LIST_ITEM.lastIndex = i + 1;
        const item = LIST_ITEM.exec(text);
        if (item)
          found.push({ name: unquote(item[1]!), index: LIST_ITEM.lastIndex - item[1]!.length });
      } else if (/[A-Za-z]/.test(ch) && !/[A-Za-z0-9_$".]/.test(text[i - 1] ?? ' ')) {
        LIST_END.lastIndex = i;
        if (LIST_END.test(text)) break;
      }
    }
  }
  return found;
}

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

  private report(migration: string, table: string): void {
    if (!this.offenders.some((o) => o.migration === migration && o.table === table))
      this.offenders.push({ migration, table });
  }

  /** Reports each tenant-only table `text` names; `at` fixes the position (an EXECUTE). */
  private flag(
    migration: string,
    text: string,
    offset: number,
    events: ContextEvent[],
    at?: number
  ): void {
    for (const ref of tableReferences(blankStrings(text))) {
      if (!this.isTenantOnly(this.tables.get(ref.name))) continue;
      if (tenantSetAt(events, at ?? offset + ref.index)) continue;
      this.report(migration, ref.name);
    }
  }

  /** Applies the `DYNAMIC_SQL` rule to every EXECUTE of a DO block body. */
  private flagDynamic(
    migration: string,
    sql: string,
    body: string,
    bodyOffset: number,
    events: ContextEvent[]
  ): void {
    for (const m of blankStrings(body).matchAll(
      /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)\s*/gi
    )) {
      const at = bodyOffset + m.index!;
      const command = executedCommand(body.slice(m.index! + m[0].length));
      if (command && DDL_COMMAND.test(command.text)) continue;
      if (command && !command.dynamic) {
        this.flag(migration, command.text, at, events, at);
        continue;
      }
      if (tenantSetAt(events, at) || dynamicSqlAllowed(sql, at)) continue;
      this.report(migration, DYNAMIC_SQL);
    }
  }

  /** Reads one migration file in order: DDL updates the table states, DML is checked against them. */
  analyze(migration: string, sql: string, knownTables: Set<string>): void {
    const executed = stripSqlComments(sql);
    let consumed = 0;
    // Every set, clear and transaction end of the tenant setting, in file order.
    const events: ContextEvent[] = [];
    for (const statement of splitSqlStatements(executed)) {
      const offset = executed.indexOf(statement, consumed);
      consumed = offset + statement.length;
      const head = statement.replace(/^\s+/, '');
      if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(head)) continue;
      const body = /^DO\b/i.test(head)
        ? /\$([A-Za-z0-9_]*)\$([\s\S]*)\$\1\$/.exec(statement)
        : null;
      const bodyStart = body ? statement.indexOf(body[2]!) : 0;
      const bodyOffset = offset + bodyStart;
      // The outer pass keeps dollar-quoted bodies whole; blank their comments too (offsets
      // kept), so a comment neither hides a branch keyword nor reads as a set or a reference.
      const bodyText = body ? stripSqlComments(body[2]!) : '';
      const statementEvents = contextEvents(
        body
          ? statement.slice(0, bodyStart) + bodyText + statement.slice(bodyStart + bodyText.length)
          : statement,
        offset
      );
      if (body)
        for (const branch of plpgsqlBranches(blankStrings(bodyText)))
          for (const event of statementEvents) {
            const end = bodyOffset + branch.end;
            if (event.kind !== 'set' || event.at < bodyOffset + branch.start || event.at >= end)
              continue;
            // Nested branches: the innermost (earliest) end applies.
            event.until = Math.min(event.until ?? end, end);
          }
      events.push(...statementEvents);
      // A transaction-local setting ends with its transaction.
      if (/^(?:COMMIT|ROLLBACK|END)\b/i.test(head)) events.push({ at: offset, kind: 'expire' });
      if (/^DO\b/i.test(head)) {
        if (!body) continue;
        // Static DDL inside the block, usually behind IF [NOT] EXISTS (...) THEN.
        for (const inner of splitSqlStatements(body[2]!)) {
          const start = blankStrings(inner).search(
            /\b(?:CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY|ALTER\s+TABLE|DROP\s+TABLE)\b/i
          );
          if (start !== -1) this.applyDdl(inner.slice(start));
        }
        this.applyDynamicDdl(body[2]!, knownTables);
        this.flag(migration, bodyText, bodyOffset, events);
        this.flagDynamic(migration, sql, bodyText, bodyOffset, events);
        continue;
      }
      if (
        /^\(*\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|TABLE)\b/i.test(head) ||
        /^CREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE|MATERIALIZED\s+VIEW)\b[\s\S]*?\bAS\s*\(?\s*(?:SELECT|WITH|TABLE)\b/i.test(
          head
        )
      ) {
        this.flag(migration, statement, offset, events);
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
