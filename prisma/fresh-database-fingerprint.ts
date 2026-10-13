import { createHash } from 'node:crypto';
import { compare } from 'bcryptjs';

export const ENCODING_VERSION = 'restaurant-state-v2';
export type Row = Record<string, string | null>;
export type Column = { name: string; type: string; nullable: boolean };
export type ForeignKey = {
  columns: string[];
  table: string;
  references: string[];
  validated: boolean;
  name?: string;
  parentSchema?: string;
  deferrable?: boolean;
  deferred?: boolean;
  enforcement?: Array<{
    table: string;
    schema: string;
    function: string;
    enabled: string;
    internal: boolean;
    deferrable: boolean;
    deferred: boolean;
  }>;
};
export type Table = {
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
};
export type CreatedRow = {
  table: string;
  selector: Row;
  token: string;
  idColumn?: string;
  timestamps: string[];
  password?: { column: 'password' | 'passwordHash'; secret: 'admin' | 'platform'; cost: 12 };
};
export type FingerprintPlan = {
  version: typeof ENCODING_VERSION;
  tables: Table[];
  created: CreatedRow[];
};
export type Dataset = Record<string, Row[]>;
export const WRITER_TABLES = [
  'platform_modules',
  'platform_packages',
  'platform_package_modules',
  'organizations',
  'organization_departments',
  'organization_roles',
  'organization_role_permissions',
  'organization_brands',
  'users',
  'platform_users',
] as const;
const fail = () => {
  throw new Error('Reviewed state encoding rejected.');
};
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function stable(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return fail();
}
export const digest = (value: unknown) => sha256(stable(value));
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Buffer.byteLength(name) > 63) return fail();
  return `"${name}"`;
}
export function numeric(value: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!m) return fail();
  let digits = (m[2] + (m[3] || '')).replace(/^0+/, '');
  let exponent = BigInt(m[4] || '0') - BigInt((m[3] || '').length);
  if (!digits) return '0';
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent++;
  }
  return `${m[1]}${digits}e${exponent}`;
}
/** Lossless JSON: numeric lexemes never pass through a JavaScript Number. */
export function canonicalJSON(text: string): unknown {
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] || '') && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
      if (text[i - 1] === '\\') i++;
    }
    return fail();
  };
  const parse = (): unknown => {
    space();
    if (text[i] === '"') return ['string', string()];
    if (text[i] === '{') {
      i++;
      space();
      const entries: Array<[string, unknown]> = [];
      const seen = new Set<string>();
      if (text[i] !== '}')
        while (true) {
          space();
          if (text[i] !== '"') return fail();
          const key = string();
          space();
          if (seen.has(key) || text[i++] !== ':') return fail();
          seen.add(key);
          entries.push([key, parse()]);
          space();
          if (text[i] !== ',') break;
          i++;
        }
      if (text[i++] !== '}') return fail();
      return ['object', entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))];
    }
    if (text[i] === '[') {
      i++;
      space();
      const items: unknown[] = [];
      if (text[i] !== ']')
        while (true) {
          items.push(parse());
          space();
          if (text[i] !== ',') break;
          i++;
        }
      if (text[i++] !== ']') return fail();
      return ['array', items];
    }
    for (const literal of ['true', 'false', 'null'])
      if (text.slice(i, i + literal.length) === literal) {
        i += literal.length;
        return [literal];
      }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!number) return fail();
    i += number[0].length;
    return ['number', numeric(number[0])];
  };
  const result = parse();
  space();
  if (i !== text.length) return fail();
  return result;
}
export function encodeCell(column: Column, value: string | null): unknown {
  if (value === null) {
    if (!column.nullable) return fail();
    return ['null'];
  }
  if (typeof value !== 'string') return fail();
  const type = column.type;
  if (type === 'numeric' || type === 'decimal') {
    numeric(value); // Validate, but preserve unconstrained PostgreSQL scale.
    return [type, value];
  }
  if (/^(smallint|integer|bigint|numeric(?:\(\d+,\d+\))?|decimal(?:\(\d+,\d+\))?)$/.test(type))
    return [type, numeric(value)];
  if (type === 'json' || type === 'jsonb') return [type, canonicalJSON(value)];
  if (type === 'bytea') {
    if (!/^\\x(?:[a-f0-9]{2})*$/.test(value)) return fail();
    return [type, value];
  }
  if (type === 'boolean' && !['true', 'false', 't', 'f'].includes(value)) return fail();
  // Dates/arrays/floats/enums retain PostgreSQL's lossless text under pinned DateStyle/TimeZone/extra_float_digits.
  return [type, type === 'boolean' ? ['true', 't'].includes(value) : value];
}
export function validatePlan(plan: FingerprintPlan) {
  if (
    plan.version !== ENCODING_VERSION ||
    !Array.isArray(plan.tables) ||
    !Array.isArray(plan.created)
  )
    return fail();
  const names = new Set<string>();
  for (const t of plan.tables) {
    quoteIdentifier(t.name);
    if (names.has(t.name) || !t.columns.length || !t.primaryKey.length) return fail();
    names.add(t.name);
    const columns = new Set(
      t.columns.map((c) => {
        quoteIdentifier(c.name);
        if (!c.type) return fail();
        return c.name;
      })
    );
    if (columns.size !== t.columns.length || t.primaryKey.some((c) => !columns.has(c)))
      return fail();
    for (const fk of t.foreignKeys)
      if (
        !fk.validated ||
        !fk.columns.length ||
        fk.columns.length !== fk.references.length ||
        fk.columns.some((c) => !columns.has(c)) ||
        !plan.tables.some(
          (p) =>
            p.name === fk.table && fk.references.every((c) => p.columns.some((x) => x.name === c))
        )
      )
        return fail();
  }
  const tokens = new Set<string>();
  for (const rule of plan.created) {
    const t = plan.tables.find((t) => t.name === rule.table);
    if (
      !t ||
      !(WRITER_TABLES as readonly string[]).includes(rule.table) ||
      !rule.token ||
      tokens.has(rule.token) ||
      !Object.keys(rule.selector).length ||
      Object.values(rule.selector).some((v) => v === null) ||
      Object.keys(rule.selector).some((c) => !t.columns.some((x) => x.name === c)) ||
      rule.selector.organizationId === 'org_devfathom' ||
      rule.selector.id === 'org_devfathom'
    )
      return fail();
    for (const [column, value] of Object.entries(rule.selector))
      if (value?.startsWith('@ref:')) {
        const parent = plan.created.find((p) => p.token === value.slice(5));
        if (
          !parent?.idColumn ||
          !tokens.has(parent.token) ||
          !t.foreignKeys.some(
            (f) =>
              f.table === parent.table &&
              f.columns.includes(column) &&
              f.references[f.columns.indexOf(column)] === parent.idColumn
          )
        )
          return fail();
      }
    tokens.add(rule.token);
    if (
      rule.idColumn &&
      (rule.idColumn !== 'id' ||
        rule.selector.id !== undefined ||
        !t.columns.some((c) => c.name === 'id'))
    )
      return fail();
    for (const field of rule.timestamps)
      if (
        (!['createdAt', 'updatedAt'].includes(field) &&
          !(rule.table === 'users' && field === 'startDate')) ||
        !t.columns.some((c) => c.name === field && /^timestamp/.test(c.type))
      )
        return fail();
    if (
      rule.password &&
      (rule.password.cost !== 12 ||
        !(
          (rule.table === 'users' &&
            rule.password.column === 'password' &&
            rule.password.secret === 'admin') ||
          (rule.table === 'platform_users' &&
            rule.password.column === 'passwordHash' &&
            rule.password.secret === 'platform')
        ) ||
        !rule.selector.id)
    )
      return fail();
  }
}
export function createdMatches(plan: FingerprintPlan, data: Dataset) {
  const ids = new Map<string, string>();
  return plan.created.map((rule) => {
    const selector = Object.fromEntries(
      Object.entries(rule.selector).map(([k, v]) => [
        k,
        v?.startsWith('@ref:') ? ids.get(v.slice(5)) : v,
      ])
    );
    const rows = data[rule.table].filter((row) =>
      Object.entries(selector).every(([k, v]) => v !== undefined && row[k] === v)
    );
    if (rows.length > 1) return fail();
    if (rows.length && rule.idColumn) {
      const id = rows[0][rule.idColumn];
      if (!id) return fail();
      ids.set(rule.token, id);
    }
    return { rule, rows, selector };
  });
}
export async function fingerprint(
  plan: FingerprintPlan,
  data: Dataset,
  options: {
    mode: 'EXACT' | 'AFTER_INITIAL' | 'OFFLINE';
    secrets?: { admin: string; platform: string };
  } = { mode: 'EXACT' }
) {
  validatePlan(plan);
  if (stable(Object.keys(data).sort()) !== stable(plan.tables.map((t) => t.name).sort()))
    return fail();
  const transformed = new Map<Row, Record<string, unknown>>();
  const ids = new Map<string, unknown>();
  for (const t of plan.tables) {
    const keys = new Set<string>();
    for (const row of data[t.name]) {
      if (stable(Object.keys(row).sort()) !== stable(t.columns.map((c) => c.name).sort()))
        return fail();
      const key = stable(t.primaryKey.map((c) => row[c]));
      if (keys.has(key)) return fail();
      keys.add(key);
      transformed.set(
        row,
        Object.fromEntries(t.columns.map((c) => [c.name, encodeCell(c, row[c.name])]))
      );
    }
  }
  for (const { rule, rows } of options.mode === 'EXACT' ? [] : createdMatches(plan, data)) {
    if (rows.length > 1) return fail();
    if (!rows.length) continue;
    const row = rows[0],
      output = transformed.get(row)!;
    if (rule.idColumn) {
      const key = stable([rule.table, rule.idColumn, row[rule.idColumn]]);
      if (!row[rule.idColumn] || ids.has(key)) return fail();
      const token = ['generated-id', rule.token];
      ids.set(key, token);
      output[rule.idColumn] = token;
    }
    for (const column of rule.timestamps) {
      if (
        !row[column] ||
        !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:[+-]\d\d(?::\d\d)?|Z)?$/.test(row[column]!)
      )
        return fail();
      output[column] = ['generated-time', rule.token, column];
    }
    if (rule.password && options.mode !== 'EXACT') {
      const value = row[rule.password.column];
      if (options.mode === 'OFFLINE') {
        if (value !== `@initial-password:${rule.password.secret}`) return fail();
      } else if (
        !value ||
        !/^\$2[ab]\$12\$[./A-Za-z0-9]{53}$/.test(value) ||
        !options.secrets?.[rule.password.secret] ||
        !(await compare(options.secrets[rule.password.secret], value))
      )
        return fail();
      output[rule.password.column] = ['initial-password-verified', rule.password.secret, 12];
    }
  }
  for (const t of plan.tables)
    for (const row of data[t.name])
      for (const fk of t.foreignKeys) {
        const values = fk.columns.map((c) => row[c]);
        if (values.some((v) => v === null)) continue;
        const parent = data[fk.table].filter((p) =>
          fk.references.every((c, i) => p[c] === values[i])
        );
        if (parent.length !== 1) return fail();
        for (let i = 0; i < values.length; i++) {
          const mapped = ids.get(stable([fk.table, fk.references[i], values[i]]));
          if (mapped) transformed.get(row)![fk.columns[i]] = mapped;
        }
      }
  const tables = [...plan.tables]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((t) => ({
      name: t.name,
      count: data[t.name].length,
      rows: data[t.name].map((r) => stable(transformed.get(r))).sort(),
    }));
  return {
    operationalSha256: digest([ENCODING_VERSION, tables]),
    catalogSha256: digest(plan.tables),
  };
}
