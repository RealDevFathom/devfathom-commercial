import type { Prisma } from '../src/generated/prisma/client.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertFreshRuntimeRole,
  type FreshDatabaseGuard,
  type FreshDatabaseInput,
} from './fresh-database.js';
import {
  digest,
  fingerprint,
  quoteIdentifier,
  stable,
  type Dataset,
  type FingerprintPlan,
  type Row,
  type Table,
} from './fresh-database-fingerprint.js';
import type { createPrivateFactory } from './fresh-database-adapter.js';
import { WRITER_INSERT_COLUMNS } from './fresh-database-prep.js';

export type Policy = {
  name: string;
  command: string;
  permissive: boolean;
  roles: string[];
  using: string | null;
  check: string | null;
};
export type CatalogTable = Table & {
  rls: boolean;
  force: boolean;
  owner: string;
  select: boolean;
  policies: Policy[];
};
export type Catalog = { tables: CatalogTable[]; facts: unknown[] };
const fail = () => {
  throw new Error('Complete same-transaction visibility rejected.');
};

// Catalog queries are fixed. No caller-supplied SQL or security-definer helper participates.
export const TABLE_CATALOG_SQL = `SELECT jsonb_build_object(
 'name',c.relname,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),
 'select',has_table_privilege(c.oid,'SELECT'),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull) ORDER BY a.attnum)
 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'primaryKey',COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.n) FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum,n)
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE p.conrelid=c.oid AND p.contype='p'),'[]'::jsonb),
 'foreignKeys',COALESCE((SELECT jsonb_agg(jsonb_build_object('columns',
 (SELECT jsonb_agg(a.attname ORDER BY k.n) FROM unnest(p.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.attnum),
 'table',(SELECT relname FROM pg_class WHERE oid=p.confrelid),'references',
 (SELECT jsonb_agg(a.attname ORDER BY k.n) FROM unnest(p.confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=p.confrelid AND a.attnum=k.attnum),
 'validated',p.convalidated) ORDER BY p.conname) FROM pg_constraint p WHERE p.conrelid=c.oid AND p.contype='f'),'[]'::jsonb),
 'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
 'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),
 'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
 FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb)) AS value
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`;

export const CATALOG_FACTS_SQL = `SELECT section, value FROM (
 SELECT 'relations' section,jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
 'acl',c.relacl::text,'options',c.reloptions,'partition',pg_get_expr(c.relpartbound,c.oid),'persistence',c.relpersistence,
 'insert',has_table_privilege(c.oid,'INSERT'),'update',has_table_privilege(c.oid,'UPDATE'),'delete',has_table_privilege(c.oid,'DELETE'),
 'truncate',has_table_privilege(c.oid,'TRUNCATE'),'references',has_table_privilege(c.oid,'REFERENCES'),'trigger',has_table_privilege(c.oid,'TRIGGER')) value
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT 'columns',jsonb_build_object('table',c.relname,'name',a.attname,'number',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
 'acl',a.attacl::text,'select',has_column_privilege(c.oid,a.attnum,'SELECT'),'insert',has_column_privilege(c.oid,a.attnum,'INSERT'),
 'update',has_column_privilege(c.oid,a.attnum,'UPDATE'),'kind',c.relkind,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
 'collation',co.collname,'dropped',a.attisdropped)
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation
 WHERE n.nspname='public' AND a.attnum>0
 UNION ALL SELECT 'constraints',jsonb_build_object('table',c.relname,'name',p.conname,'definition',pg_get_constraintdef(p.oid),
 'valid',p.convalidated,'deferred',p.condeferred,'deferrable',p.condeferrable,'parentSchema',pn.nspname)
 FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_class pc ON pc.oid=p.confrelid LEFT JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE n.nspname='public'
 UNION ALL SELECT 'functions',jsonb_build_object('schema',n.nspname,'name',p.proname,'args',pg_get_function_identity_arguments(p.oid),
 'body',p.prosrc,'language',l.lanname,'result',pg_get_function_result(p.oid),'securityDefiner',p.prosecdef,'config',p.proconfig,
 'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'execute',has_function_privilege(p.oid,'EXECUTE'))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT 'triggers',jsonb_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid))
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
 UNION ALL SELECT 'extensions',jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,'owner',pg_get_userbyid(e.extowner))
 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
 UNION ALL SELECT 'schemas',jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl::text,
 'usage',has_schema_privilege(n.oid,'USAGE'),'create',has_schema_privilege(n.oid,'CREATE'))
 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT 'database',jsonb_build_object('name',d.datname,'owner',pg_get_userbyid(d.datdba),'acl',d.datacl::text,
 'create',has_database_privilege(d.oid,'CREATE'),'temporary',has_database_privilege(d.oid,'TEMPORARY')) FROM pg_database d WHERE d.datname=current_database()
 UNION ALL SELECT 'types',jsonb_build_object('schema',n.nspname,'name',t.typname,'kind',t.typtype,'owner',pg_get_userbyid(t.typowner),
 'acl',t.typacl::text,'base',format_type(t.typbasetype,t.typtypmod),'labels',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid))
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
 UNION ALL SELECT 'sequences',jsonb_build_object('name',c.relname,'usage',has_sequence_privilege(c.oid,'USAGE'),
 'select',has_sequence_privilege(c.oid,'SELECT'),'update',has_sequence_privilege(c.oid,'UPDATE')) FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'
 UNION ALL SELECT 'role_database_settings',jsonb_build_object('entries',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN s.setrole=0 THEN 'ALL' ELSE pg_get_userbyid(s.setrole) END,
 'database',CASE WHEN s.setdatabase=0 THEN 'ALL' ELSE d.datname END,'settings',s.setconfig) ORDER BY s.setdatabase,s.setrole)
 FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase
 WHERE (s.setrole=0 OR s.setrole=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 AND (s.setdatabase=0 OR d.datname=current_database())), '[]'::jsonb))
 UNION ALL SELECT 'rewrite_rules',jsonb_build_object('entries',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',r.rulename,
 'enabled',r.ev_enabled,'event',r.ev_type,'instead',r.is_instead,'definition',pg_get_ruledef(r.oid)) ORDER BY n.nspname,c.relname,r.rulename)
 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind NOT IN ('v','m')), '[]'::jsonb))
 UNION ALL SELECT 'defaults',jsonb_build_object('role',pg_get_userbyid(d.defaclrole),'schema',n.nspname,'type',d.defaclobjtype,'acl',d.defaclacl::text)
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
 ) facts ORDER BY section,value::text`;

/** Exact pg_get_expr forms only. Literal/identifier bytes and grouping are significant. */
const platform = "(current_setting('app.is_platform_admin'::text, true) = 'true'::text)";
const organization = `("organizationId" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text))`;
const branch = `("branchId" = NULLIF(current_setting('app.current_branch_id'::text, true), ''::text))`;
const optionalBranch = `((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) IS NULL) OR ("branchId" = current_setting('app.current_branch_id'::text, true)))`;
type Scope = 'global' | 'organization' | 'branch';
export function policyScope(table: CatalogTable): Scope {
  if (!table.select || table.owner === 'devfathom_app') return fail();
  const tenant =
    table.columns.some((c) => c.name === 'organizationId') || table.name === 'organizations';
  if (!table.rls) {
    if (tenant) return fail();
    return 'global';
  }
  if (!table.force) return fail();
  const policies = table.policies.filter((p) => ['r', '*'].includes(p.command));
  if (
    policies.length !== 1 ||
    !policies[0].permissive ||
    !policies[0].roles.some((r) => r === 'public' || r === 'devfathom_app')
  )
    return fail();
  const value = policies[0].using;
  // Exact PostgreSQL boolean constant. The single applicable permissive SELECT
  // policy above cannot hide rows; multiple/restrictive/unknown-role cases reject.
  if (value === 'true') return 'global';
  if (
    value === `(${platform} OR ${organization})` ||
    (table.name === 'organizations' &&
      value === `(${platform} OR ${organization.replace('"organizationId"', 'id')})`)
  )
    return 'global';
  if (value === organization || value === `(${organization} AND ${optionalBranch})`)
    return 'organization';
  if (value === `(${organization} AND ${branch})`) return 'branch';
  return fail();
}

export function proveVisibility(tables: CatalogTable[]) {
  const scopes = new Map(tables.map((t) => [t.name, policyScope(t)]));
  if (scopes.get('organizations') !== 'global' || scopes.get('restaurant_branches') !== 'global')
    return fail();
  const nonnull = (t: Table, names: string[]) =>
    names.every((n) => t.columns.some((c) => c.name === n && !c.nullable));
  const anchored = (table: CatalogTable, visited = new Set<string>()): boolean => {
    if (table.name === 'organizations') return true;
    if (visited.has(table.name) || !nonnull(table, ['organizationId'])) return false;
    visited.add(table.name);
    return table.foreignKeys.some((fk) => {
      const parent = tables.find((t) => t.name === fk.table);
      if (!parent || !fk.validated || !nonnull(table, fk.columns)) return false;
      const i = fk.columns.indexOf('organizationId');
      return (
        i >= 0 &&
        ((parent.name === 'organizations' && fk.references[i] === 'id') ||
          (fk.references[i] === 'organizationId' && anchored(parent, new Set(visited))))
      );
    });
  };
  for (const t of tables) {
    if (scopes.get(t.name) === 'organization' && !anchored(t)) return fail();
    if (
      scopes.get(t.name) === 'branch' &&
      (!nonnull(t, ['organizationId', 'branchId']) ||
        !t.foreignKeys.some(
          (f) =>
            f.validated &&
            f.table === 'restaurant_branches' &&
            stable(f.columns) === stable(['organizationId', 'branchId']) &&
            stable(f.references) === stable(['organizationId', 'id'])
        ))
    )
      return fail();
  }
  return scopes;
}

/** Read the pinned Prisma schema, including SQL-mapped names; never take a caller's table allowlist as completeness proof. */
export function schemaInventory(root: string) {
  const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const names = new Set(models.map((m) => m[1]));
  if (models.length !== 451) return fail();
  return models
    .map((m) => ({
      name: /@@map\("([^"]+)"\)/.exec(m[2])?.[1] ?? m[1],
      columns: [...m[2].matchAll(/^\s+(\w+)\s+(\w+)(?:\[\]|\?)?([^\n]*)/gm)]
        .filter((f) => !names.has(f[2]) && !f[3].includes('@ignore'))
        .map((f) => /@map\("([^"]+)"\)/.exec(f[3])?.[1] ?? f[1])
        .sort(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function assertCatalog(
  plan: FingerprintPlan,
  catalog: Catalog,
  expected: Catalog,
  root: string
) {
  if (digest(catalog) !== digest(expected)) return fail();
  const app = catalog.tables.filter((t) => t.name !== '_prisma_migrations');
  const ledger = catalog.tables.filter((t) => t.name === '_prisma_migrations');
  if (
    ledger.length !== 1 ||
    ledger[0].rls ||
    !ledger[0].select ||
    ledger[0].owner === 'devfathom_app'
  )
    return fail();
  const inventory = app
    .map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name).sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  if (
    stable(inventory) !== stable(schemaInventory(root)) ||
    digest(
      app.map(({ name, columns, primaryKey, foreignKeys }) => ({
        name,
        columns,
        primaryKey,
        foreignKeys,
      }))
    ) !== digest(plan.tables)
  )
    return fail();
  // Mandatory empty sections prove the fixed query covered these catalogs, even when empty.
  // Unreviewed session defaults or rewrite side effects have no supported execution contract.
  for (const section of ['role_database_settings', 'rewrite_rules']) {
    const entries = (
      catalog.facts as Array<{ section: string; value: Record<string, unknown> }>
    ).filter((f) => f.section === section);
    if (entries.length !== 1 || stable(entries[0].value) !== stable({ entries: [] })) return fail();
  }
  for (const fact of catalog.facts as Array<{ section: string; value: Record<string, unknown> }>) {
    const v = fact.value;
    if (
      v.owner === 'devfathom_app' ||
      v.create === true ||
      v.temporary === true ||
      v.truncate === true
    )
      return fail();
    if (
      fact.section === 'relations' &&
      (v.insert === true ||
        v.update === true ||
        v.delete === true ||
        v.references === true ||
        v.trigger === true)
    )
      return fail();
    if (fact.section === 'columns' && ['r', 'p'].includes(String(v.kind)) && v.dropped !== true) {
      if (
        v.update === true ||
        (v.insert === true &&
          !(
            WRITER_INSERT_COLUMNS[String(v.table) as keyof typeof WRITER_INSERT_COLUMNS] ?? []
          ).includes(String(v.name)))
      )
        return fail();
    }
    if (
      fact.section === 'columns' &&
      ['r', 'p'].includes(String(v.kind)) &&
      v.select !== true &&
      v.dropped !== true
    )
      return fail();
    if (
      fact.section === 'constraints' &&
      (v.valid !== true || (v.parentSchema && v.parentSchema !== 'public'))
    )
      return fail();
    if (
      fact.section === 'relations' &&
      (v.schema !== 'public' || !['r', 'p', 'i', 'I', 'S'].includes(String(v.kind)))
    )
      return fail();
  }
  return proveVisibility(app);
}

const GUC_READ = `SELECT current_setting('app.is_platform_admin',true) AS platform,
 current_setting('app.current_organization_id',true) AS organization,current_setting('app.current_branch_id',true) AS branch`;
const GUC_WRITE = `SELECT set_config('app.is_platform_admin',$1,true),set_config('app.current_organization_id',$2,true),set_config('app.current_branch_id',$3,true)`;
export async function collectRows(
  tx: Prisma.TransactionClient,
  plan: FingerprintPlan,
  scopes: Map<string, Scope>
): Promise<Dataset> {
  const [previous] =
    await tx.$queryRawUnsafe<
      Array<{ platform: string | null; organization: string | null; branch: string | null }>
    >(GUC_READ);
  if (!previous) return fail();
  const data: Dataset = {};
  const read = async (t: Table) =>
    tx.$queryRawUnsafe<Row[]>(
      `SELECT ${t.columns.map((c) => `${quoteIdentifier(c.name)}::text AS ${quoteIdentifier(c.name)}`).join(',')} FROM public.${quoteIdentifier(t.name)}`
    );
  try {
    await tx.$queryRawUnsafe(GUC_WRITE, 'true', '', '');
    for (const t of plan.tables) if (scopes.get(t.name) === 'global') data[t.name] = await read(t);
    // Include orphan branch pairs: restaurant_branches has no universal organization FK.
    const organizations = data.organizations.map((r) => r.id);
    const pairs = data.restaurant_branches.map((r) => [r.organizationId, r.id]);
    if (organizations.some((v) => !v) || pairs.some((p) => p.some((v) => !v))) return fail();
    for (const t of plan.tables)
      if (scopes.get(t.name) !== 'global') {
        data[t.name] = [];
        const contexts =
          scopes.get(t.name) === 'organization' ? organizations.map((o) => [o, '']) : pairs;
        for (const [organization, branch] of contexts) {
          await tx.$queryRawUnsafe(GUC_WRITE, 'true', organization, branch);
          data[t.name].push(...(await read(t)));
        }
      }
    return data;
  } finally {
    // Missing custom GUC and empty GUC are equivalent for the recognized NULLIF policies.
    await tx.$queryRawUnsafe(
      GUC_WRITE,
      previous.platform ?? '',
      previous.organization ?? '',
      previous.branch ?? ''
    );
  }
}

export function concreteObserver(
  owner: ReturnType<typeof createPrivateFactory>,
  input: FreshDatabaseInput,
  guard: Omit<FreshDatabaseGuard, 'observe'>,
  plan: FingerprintPlan,
  expected: Catalog,
  purpose: 'INITIAL_TRANSITION' | 'COMPLETED_REPLAY'
): FreshDatabaseGuard['observe'] {
  let before: 'INITIAL' | 'COMPLETED' | undefined;
  return async (tx) => {
    const socket = owner.session(tx);
    const [identity] = await tx.$queryRawUnsafe<
      Array<{
        current_user: string;
        session_user: string;
        database_name: string;
        pid: number;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolcanlogin: boolean;
        rolreplication: boolean;
        membership_count: number;
      }>
    >(
      `SELECT current_user,session_user,current_database() database_name,pg_backend_pid() pid,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolcanlogin,r.rolreplication,
      (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) membership_count FROM pg_roles r WHERE rolname=current_user`
    );
    assertFreshRuntimeRole(identity);
    if (
      identity.session_user !== identity.current_user ||
      identity.pid !== socket.backendPid ||
      identity.database_name !== guard.endpoint.database
    )
      return fail();
    const tables = (
      await tx.$queryRawUnsafe<Array<{ value: CatalogTable }>>(TABLE_CATALOG_SQL)
    ).map((r) => r.value);
    const facts = await tx.$queryRawUnsafe<unknown[]>(CATALOG_FACTS_SQL);
    const catalog = { tables, facts };
    const scopes = assertCatalog(plan, catalog, expected, guard.sourceRoot);
    const { pid: _pid, ...role } = identity;
    const postureSha256 = digest({ catalog, role, endpoint: guard.endpoint });
    if (postureSha256 !== guard.baseline.postureSha256) return fail();
    await tx.$queryRawUnsafe(
      `SELECT set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true),set_config('extra_float_digits','3',true),set_config('bytea_output','hex',true)`
    );
    const rows = await collectRows(tx, plan, scopes);
    const state = await fingerprint(plan, rows, {
      mode: before === 'INITIAL' ? 'AFTER_INITIAL' : 'EXACT',
      secrets: {
        admin: input.restaurant.adminPassword!,
        platform: input.restaurant.platformAdminPassword!,
      },
    });
    const phase = observedPhase(state, guard.baseline, purpose, before);
    before ??= phase;
    owner.session(tx);
    return {
      ...state,
      phase,
      target: input.target,
      endpoint: guard.endpoint,
      tlsServerIdentityVerified: true,
      completeVisibility: true,
      fingerprintPlanSha256: digest(plan),
      postureSha256,
    };
  };
}

export function observedPhase(
  state: { operationalSha256: string; catalogSha256: string },
  baseline: FreshDatabaseGuard['baseline'],
  purpose: 'INITIAL_TRANSITION' | 'COMPLETED_REPLAY',
  before?: 'INITIAL' | 'COMPLETED'
) {
  const expectedPhase = before || purpose === 'COMPLETED_REPLAY' ? 'COMPLETED' : 'INITIAL';
  const expected = expectedPhase === 'INITIAL' ? baseline.initial : baseline.completed;
  if (stable(expected) !== stable(state)) return fail();
  return expectedPhase;
}
