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
 'validated',p.convalidated,'name',p.conname,'parentSchema',(SELECT nspname FROM pg_namespace WHERE oid=(SELECT relnamespace FROM pg_class WHERE oid=p.confrelid)),
 'deferrable',p.condeferrable,'deferred',p.condeferred,'enforcement',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'table',tc.relname,'schema',fn.nspname,'function',f.proname,'enabled',tr.tgenabled,'internal',tr.tgisinternal,'deferrable',tr.tgdeferrable,'deferred',tr.tginitdeferred) ORDER BY tc.relname,f.proname)
 FROM pg_trigger tr JOIN pg_class tc ON tc.oid=tr.tgrelid JOIN pg_proc f ON f.oid=tr.tgfoid JOIN pg_namespace fn ON fn.oid=f.pronamespace WHERE tr.tgconstraint=p.oid),'[]'::jsonb)) ORDER BY p.conname) FROM pg_constraint p WHERE p.conrelid=c.oid AND p.contype='f'),'[]'::jsonb),
 'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
 'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),
 'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
 FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb)) AS value
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`;

export const CATALOG_FACTS_SQL = `SELECT section, value FROM (
 SELECT 'execution_posture' section,jsonb_build_object('session_replication_role',current_setting('session_replication_role')) value
 UNION ALL SELECT 'relations' section,jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
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
// Saved PostgreSQL forms: each complete expression has the exact platform equality
// as its top-level disjunct. No prefix matching, SQL normalization, or table allowlist.
const platformForms = new Set<string>([
  "(current_setting('app.is_platform_admin'::text, true) = 'true'::text)",
  "((current_setting('app.is_platform_admin'::text, true) = 'true'::text) OR ((\"organizationId\" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND ((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) IS NULL) OR (\"branchId\" = current_setting('app.current_branch_id'::text, true)))))",
  "((current_setting('app.is_platform_admin'::text, true) = 'true'::text) OR ((\"organizationId\" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND ((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) IS NULL) OR (\"branchId\" = NULLIF(current_setting('app.current_branch_id'::text, true), ''::text)))))",
  "((current_setting('app.is_platform_admin'::text, true) = 'true'::text) OR ((\"organizationId\" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND ((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) IS NULL) OR ((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) = \"sourceBranchId\") OR (NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) = \"destinationBranchId\")))))",
  "((current_setting('app.is_platform_admin'::text, true) = 'true'::text) OR ((\"organizationId\" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND ((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) IS NULL) OR (\"branchId\" IS NULL) OR (\"branchId\" = NULLIF(current_setting('app.current_branch_id'::text, true), ''::text)))))",
  "((current_setting('app.is_platform_admin'::text, true) = 'true'::text) OR ((\"organizationId\" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND (\"branchId\" = NULLIF(current_setting('app.current_branch_id'::text, true), ''::text))))",
  '((current_setting(\'app.is_platform_admin\'::text, true) = \'true\'::text) OR (("organizationId" = NULLIF(current_setting(\'app.current_organization_id\'::text, true), \'\'::text)) AND (EXISTS ( SELECT 1\n   FROM pharmacy_interbranch_transfers t\n  WHERE ((t."organizationId" = pharmacy_interbranch_transfer_lines."organizationId") AND (t.id = pharmacy_interbranch_transfer_lines."transferId"))))))',
  "((current_setting('app.is_platform_admin'::text, true) = 'true'::text) OR ((\"organizationId\" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND ((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) IS NULL) OR ((current_setting('app.current_branch_id'::text, true) = \"fromBranchId\") OR (current_setting('app.current_branch_id'::text, true) = \"toBranchId\")))))",
  '((current_setting(\'app.is_platform_admin\'::text, true) = \'true\'::text) OR (("organizationId" = NULLIF(current_setting(\'app.current_organization_id\'::text, true), \'\'::text)) AND (EXISTS ( SELECT 1\n   FROM pharmacy_debit_notes n\n  WHERE ((n."organizationId" = pharmacy_supplier_credit_allocations."organizationId") AND (n.id = pharmacy_supplier_credit_allocations."debitNoteId"))))))',
]);
const campaignForms = {
  pharmacy_campaign_delivery_events:
    '(("organizationId" = NULLIF(current_setting(\'app.current_organization_id\'::text, true), \'\'::text)) AND (EXISTS ( SELECT 1\n   FROM pharmacy_campaign_dispatch_attempts a\n  WHERE ((a."organizationId" = pharmacy_campaign_delivery_events."organizationId") AND (a.id = pharmacy_campaign_delivery_events."attemptId")))))',
  pharmacy_campaign_dispatch_attempts:
    "((\"organizationId\" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1\n   FROM pharmacy_campaign_captures c\n  WHERE ((c.\"organizationId\" = pharmacy_campaign_dispatch_attempts.\"organizationId\") AND (c.id = pharmacy_campaign_dispatch_attempts.\"captureId\") AND ((NULLIF(current_setting('app.current_branch_id'::text, true), ''::text) IS NULL) OR (c.\"branchId\" = NULLIF(current_setting('app.current_branch_id'::text, true), ''::text)))))))",
} as const;
const supplementalPermissiveForms = new Set<string>([
  '(("organizationId" = NULLIF(current_setting(\'app.current_organization_id\'::text, true), \'\'::text)) AND ("branchId" = NULLIF(current_setting(\'app.current_branch_id\'::text, true), \'\'::text)) AND ("orderLineId" IS NOT NULL) AND (EXISTS ( SELECT 1\n   FROM pharmacy_customer_order_lines line\n  WHERE ((line."organizationId" = pharmacy_restock_interests."organizationId") AND (line."branchId" = pharmacy_restock_interests."branchId") AND (line.id = pharmacy_restock_interests."orderLineId")))))',
  '(("organizationId" = NULLIF(current_setting(\'app.current_organization_id\'::text, true), \'\'::text)) AND ("branchId" = NULLIF(current_setting(\'app.current_branch_id\'::text, true), \'\'::text)) AND (EXISTS ( SELECT 1\n   FROM pharmacy_restock_interests interest\n  WHERE ((interest."organizationId" = pharmacy_restock_reservations."organizationId") AND (interest."branchId" = pharmacy_restock_reservations."branchId") AND (interest.id = pharmacy_restock_reservations."interestId") AND (interest."orderLineId" IS NOT NULL)))))',
]);
export type Scope = 'global' | 'organization' | 'branch' | 'conditional-empty';
const scopeOrder: Scope[] = ['global', 'organization', 'branch'];
function expressionScope(table: CatalogTable, value: string | null): Scope | 'supplemental' {
  if (value === 'true') {
    if (table.name === 'organizations' || table.columns.some((c) => c.name === 'organizationId'))
      return fail();
    return 'global';
  }
  if (platformForms.has(value ?? '')) return 'global';
  if (
    value === `(${platform} OR ${organization})` ||
    (table.name === 'organizations' &&
      value === `(${platform} OR ${organization.replace('"organizationId"', 'id')})`)
  )
    return 'global';
  if (
    value === organization ||
    value === `("organizationId" = current_setting('app.current_organization_id'::text, true))` ||
    value === `(${organization} AND ${optionalBranch})` ||
    Object.entries(campaignForms).some(([name, form]) => table.name === name && value === form)
  )
    return 'organization';
  if (value === `(${organization} AND ${branch})`) return 'branch';
  // These two exact saved ALL policies add rows via permissive OR. They are not
  // sufficient proofs themselves; a covering SELECT predicate is still required.
  if (supplementalPermissiveForms.has(value ?? '')) return 'supplemental';
  return fail();
}
export function policyScope(table: CatalogTable): Scope {
  if (!table.select || table.owner === 'devfathom_app') return fail();
  const tenant =
    table.columns.some((c) => c.name === 'organizationId') || table.name === 'organizations';
  if (!table.rls) {
    if (tenant) return fail();
    return 'global';
  }
  if (!table.force) return fail();
  // Runtime role guard forbids memberships. Only PUBLIC and the exact runtime role apply.
  const policies = table.policies.filter(
    (p) =>
      ['r', '*'].includes(p.command) && p.roles.some((r) => r === 'public' || r === 'devfathom_app')
  );
  const classified = policies.map((p) => ({ ...p, scope: expressionScope(table, p.using) }));
  const covers = (proof: Scope | 'supplemental', context: Scope) =>
    proof !== 'supplemental' && scopeOrder.indexOf(proof) <= scopeOrder.indexOf(context);
  for (const context of scopeOrder) {
    if (
      classified.some((p) => p.permissive && covers(p.scope, context)) &&
      classified.every((p) => p.permissive || covers(p.scope, context))
    )
      return context;
  }
  return fail();
}
const nonnull = (t: Table, names: string[]) =>
  names.length > 0 && names.every((n) => t.columns.some((c) => c.name === n && !c.nullable));
const validForeignKey = (t: Table, fk: Table['foreignKeys'][number], parent: Table) =>
  fk.validated &&
  fk.parentSchema === 'public' &&
  fk.deferrable === false &&
  fk.deferred === false &&
  typeof fk.name === 'string' &&
  fk.name.length > 0 &&
  fk.enforcement?.length === 4 &&
  fk.enforcement.every(
    (e) =>
      e.schema === 'pg_catalog' &&
      e.internal === true &&
      e.enabled === 'O' &&
      e.deferrable === false &&
      e.deferred === false
  ) &&
  ['RI_FKey_check_ins', 'RI_FKey_check_upd'].every(
    (f) => fk.enforcement!.filter((e) => e.table === t.name && e.function === f).length === 1
  ) &&
  ['del', 'upd'].every(
    (event) =>
      fk.enforcement!.filter(
        (e) =>
          e.table === parent.name &&
          new RegExp(`^RI_FKey_(noaction|restrict|cascade|setnull|setdefault)_${event}$`).test(
            e.function
          )
      ).length === 1
  ) &&
  new Set(fk.columns).size === fk.columns.length &&
  new Set(fk.references).size === fk.references.length &&
  fk.columns.length === fk.references.length &&
  nonnull(t, fk.columns) &&
  fk.references.every((n) => parent.columns.some((c) => c.name === n));

/** Every root is independently globally readable before any tenant context is used. */
export function organizationContextRoots(tables: Table[], scopes: Map<string, Scope>) {
  return tables.filter(
    (t) =>
      scopes.get(t.name) === 'global' &&
      (t.name === 'organizations' ? nonnull(t, ['id']) : nonnull(t, ['organizationId']))
  );
}
export function branchContextRoots(tables: Table[], scopes: Map<string, Scope>) {
  return tables.filter(
    (t) =>
      ['restaurant_branches', 'pharmacy_branches'].includes(t.name) &&
      scopes.get(t.name) === 'global' &&
      nonnull(t, ['organizationId', 'id'])
  );
}

/** Shared renderer/observer context contract. UNION deduplicates repeated tenant IDs/pairs. */
export function visibilityContextSQL(
  tables: Table[],
  scopes: Map<string, Scope>,
  scope: 'organization' | 'branch'
) {
  const roots =
    scope === 'organization'
      ? organizationContextRoots(tables, scopes)
      : branchContextRoots(tables, scopes);
  if (!roots.length) return fail();
  return roots
    .map((t) =>
      scope === 'organization'
        ? `SELECT ${t.name === 'organizations' ? 'id' : '"organizationId"'} AS org,''::text AS branch FROM public.${quoteIdentifier(t.name)}`
        : `SELECT "organizationId" AS org,id AS branch FROM public.${quoteIdentifier(t.name)}`
    )
    .join(' UNION ');
}

/** Diagnostic structural coverage; never authorizes partial observation. */
export function visibilityCoverage(tables: CatalogTable[]) {
  const scopes = new Map<string, Scope>();
  const refusals = new Map<string, string>();
  for (const t of tables) {
    try {
      scopes.set(t.name, policyScope(t));
    } catch {
      refusals.set(t.name, 'unsupported policy or table posture');
    }
  }
  const roots = new Set(organizationContextRoots(tables, scopes).map((t) => t.name));
  const branches = new Set(branchContextRoots(tables, scopes).map((t) => t.name));
  const anchored = (table: CatalogTable, pair: boolean, visited = new Set<string>()): boolean => {
    if ((pair ? branches : roots).has(table.name)) return true;
    if (
      visited.has(table.name) ||
      !nonnull(table, pair ? ['organizationId', 'branchId'] : ['organizationId'])
    )
      return false;
    visited.add(table.name);
    return table.foreignKeys.some((fk) => {
      const parent = tables.find((t) => t.name === fk.table);
      if (!parent || !validForeignKey(table, fk, parent)) return false;
      const org = fk.columns.indexOf('organizationId');
      const branchIndex = fk.columns.indexOf('branchId');
      return (
        org >= 0 &&
        fk.references[org] === (parent.name === 'organizations' ? 'id' : 'organizationId') &&
        (!pair ||
          (branchIndex >= 0 &&
            fk.references[branchIndex] === (branches.has(parent.name) ? 'id' : 'branchId'))) &&
        anchored(parent, pair, new Set(visited))
      );
    });
  };
  const proven = new Set<string>();
  const prove = (t: CatalogTable, visiting = new Set<string>()): boolean => {
    if (proven.has(t.name)) return true;
    const scope = scopes.get(t.name);
    if (!scope || visiting.has(t.name)) return false;
    visiting.add(t.name);
    if (scope !== 'global' && !anchored(t, scope === 'branch')) {
      refusals.set(t.name, 'missing validated nonnullable correlated context ancestry');
      return false;
    }
    const campaign = Object.entries(campaignForms).find(
      ([name, form]) =>
        name === t.name &&
        t.policies.some((p) => ['r', '*'].includes(p.command) && p.using === form)
    );
    if (campaign && scope === 'branch') {
      refusals.set(t.name, 'campaign parent branch may differ from child branch');
      return false;
    }
    if (campaign) {
      const delivery = t.name === 'pharmacy_campaign_delivery_events';
      const parentName = delivery
        ? 'pharmacy_campaign_dispatch_attempts'
        : 'pharmacy_campaign_captures';
      const parent = tables.find((p) => p.name === parentName);
      const childId = delivery ? 'attemptId' : 'captureId';
      // EXISTS uses organization+identity. Extra nonnull FK components strengthen the proof.
      if (
        !parent ||
        !['global', 'organization'].includes(scopes.get(parentName) ?? '') ||
        !t.foreignKeys.some(
          (fk) =>
            fk.table === parentName &&
            validForeignKey(t, fk, parent) &&
            fk.references[fk.columns.indexOf('organizationId')] === 'organizationId' &&
            fk.references[fk.columns.indexOf(childId)] === 'id'
        ) ||
        !prove(parent, visiting)
      ) {
        refusals.set(t.name, 'parent correlation or same-context parent visibility unproven');
        return false;
      }
    }
    proven.add(t.name);
    return true;
  };
  for (const t of tables) prove(t);
  return { scopes: new Map([...scopes].filter(([name]) => proven.has(name))), refusals };
}
/** Exact audited relationships, not permission to SELECT through a filtered policy. */
const emptyParentEdges = [
  {
    table: 'pharmacy_customer_orders',
    parent: 'pharmacy_customers',
    name: 'pharmacy_customer_orders_customer_fkey',
    columns: ['organizationId', 'customerId'],
    references: ['organizationId', 'id'],
  },
  ...[
    'pharmacy_customer_order_lines',
    'pharmacy_customer_order_events',
    'pharmacy_order_delivery_evidence',
  ].map((table) => ({
    table,
    parent: 'pharmacy_customer_orders',
    name: table === 'pharmacy_order_delivery_evidence' ? null : `${table}_order_fkey`,
    columns: ['organizationId', 'branchId', 'orderId'],
    references: ['organizationId', 'branchId', 'id'],
  })),
];
export function conditionalObligations(tables: Table[], scopes: Map<string, Scope>) {
  const obligations = [];
  for (const edge of emptyParentEdges) {
    if (scopes.get(edge.table) !== 'conditional-empty') continue;
    const t = tables.find((t) => t.name === edge.table);
    const parent = tables.find((t) => t.name === edge.parent);
    if (
      !t ||
      !parent ||
      scopes.get('pharmacy_customers') !== 'global' ||
      (edge.parent !== 'pharmacy_customers' && scopes.get(edge.parent) !== 'conditional-empty')
    )
      return fail();
    const fks = t.foreignKeys.filter(
      (fk) =>
        (edge.name === null || fk.name === edge.name) &&
        fk.table === edge.parent &&
        stable(fk.columns) === stable(edge.columns) &&
        stable(fk.references) === stable(edge.references) &&
        validForeignKey(t, fk, parent)
    );
    if (fks.length !== 1) return fail();
    obligations.push({
      table: t.name,
      parent: parent.name,
      root: 'pharmacy_customers',
      foreignKeySha256: digest(fks[0]),
      inventorySha256: digest(
        tables.map(({ name, columns, primaryKey, foreignKeys }) => ({
          name,
          columns,
          primaryKey,
          foreignKeys,
        }))
      ),
      parentContext: { platform: 'true', organization: '', branch: '' },
    });
  }
  if ([...scopes.values()].filter((s) => s === 'conditional-empty').length !== obligations.length)
    return fail();
  return obligations;
}
export type ProofSession = {
  pid: number;
  snapshot: string;
  transaction_started_at: string;
  isolation: string;
  replication: string;
};
export const PROOF_SESSION_SQL = `SELECT pg_backend_pid() pid,txid_current_snapshot()::text snapshot,transaction_timestamp()::text transaction_started_at,current_setting('transaction_isolation') isolation,current_setting('session_replication_role') replication`;
export function assertProofSession(
  start: ProofSession,
  end: ProofSession,
  isolation: 'serializable' | 'repeatable read'
) {
  if (
    !start ||
    !end ||
    !Number.isInteger(start.pid) ||
    start.pid <= 0 ||
    !start.snapshot ||
    !Number.isFinite(Date.parse(start.transaction_started_at)) ||
    start.isolation !== isolation ||
    start.replication !== 'origin' ||
    stable(start) !== stable(end)
  )
    return fail();
}
export function resolveConditionalRows(
  tables: Table[],
  scopes: Map<string, Scope>,
  rows: Dataset,
  catalogSha256: string,
  session: ProofSession
) {
  const proofs = [];
  for (const obligation of conditionalObligations(tables, scopes)) {
    if (
      !Array.isArray(rows[obligation.parent]) ||
      rows[obligation.parent].length !== 0 ||
      !Array.isArray(rows[obligation.root]) ||
      rows[obligation.root].length !== 0
    )
      return fail();
    rows[obligation.table] = [];
    proofs.push({
      section: 'absence_proof',
      ...obligation,
      catalogSha256,
      parentRowsSha256: digest(rows[obligation.parent]),
      session,
    });
  }
  return proofs;
}
export function proveVisibility(tables: CatalogTable[]) {
  const { scopes, refusals } = visibilityCoverage(tables);
  for (const edge of emptyParentEdges) {
    if (!refusals.has(edge.table)) continue;
    const t = tables.find((t) => t.name === edge.table)!;
    if (!t.select || !t.rls || !t.force || t.owner === 'devfathom_app') return fail();
    scopes.set(edge.table, 'conditional-empty');
    refusals.delete(edge.table);
  }
  if (
    refusals.size ||
    scopes.size !== tables.length ||
    scopes.get('organizations') !== 'global' ||
    scopes.get('restaurant_branches') !== 'global'
  )
    return fail();
  conditionalObligations(tables, scopes);
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
  const execution = (catalog.facts as Array<{ section: string; value: unknown }>).filter(
    (f) => f.section === 'execution_posture'
  );
  if (
    execution.length !== 1 ||
    stable(execution[0].value) !== stable({ session_replication_role: 'origin' })
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
  scopes: Map<string, Scope>,
  evidence?: { catalogSha256: string; proofs: ReturnType<typeof resolveConditionalRows> }
): Promise<Dataset> {
  const [previous] =
    await tx.$queryRawUnsafe<
      Array<{ platform: string | null; organization: string | null; branch: string | null }>
    >(GUC_READ);
  if (!previous) return fail();
  const data: Dataset = {};
  const conditional = [...scopes.values()].includes('conditional-empty');
  if (conditional && !evidence) return fail();
  const start = conditional
    ? (await tx.$queryRawUnsafe<ProofSession[]>(PROOF_SESSION_SQL))[0]
    : undefined;
  if (conditional) assertProofSession(start!, start!, 'serializable');
  const read = async (t: Table) =>
    tx.$queryRawUnsafe<Row[]>(
      `SELECT ${t.columns.map((c) => `${quoteIdentifier(c.name)}::text AS ${quoteIdentifier(c.name)}`).join(',')} FROM public.${quoteIdentifier(t.name)}`
    );
  try {
    await tx.$queryRawUnsafe(GUC_WRITE, 'true', '', '');
    for (const t of plan.tables) if (scopes.get(t.name) === 'global') data[t.name] = await read(t);
    if (conditional)
      evidence!.proofs.push(
        ...resolveConditionalRows(plan.tables, scopes, data, evidence!.catalogSha256, start!)
      );
    // Include orphan branch pairs: restaurant_branches has no universal organization FK.
    const organizations = [
      ...new Set(
        organizationContextRoots(plan.tables, scopes).flatMap((t) =>
          data[t.name].map((r) => (t.name === 'organizations' ? r.id : r.organizationId))
        )
      ),
    ];
    const pairs = [
      ...new Map(
        branchContextRoots(plan.tables, scopes).flatMap((t) =>
          data[t.name].map(
            (r) => [[r.organizationId, r.id].join('\u0000'), [r.organizationId, r.id]] as const
          )
        )
      ).values(),
    ];
    if (organizations.some((v) => !v) || pairs.some((p) => p.some((v) => !v))) return fail();
    for (const t of plan.tables)
      if (scopes.get(t.name) !== 'global' && scopes.get(t.name) !== 'conditional-empty') {
        data[t.name] = [];
        const contexts =
          scopes.get(t.name) === 'organization' ? organizations.map((o) => [o, '']) : pairs;
        for (const [organization, branch] of contexts) {
          await tx.$queryRawUnsafe(GUC_WRITE, 'true', organization, branch);
          data[t.name].push(...(await read(t)));
        }
      }
    if (conditional)
      assertProofSession(
        start!,
        (await tx.$queryRawUnsafe<ProofSession[]>(PROOF_SESSION_SQL))[0],
        'serializable'
      );
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
    const evidence = {
      catalogSha256: digest(catalog),
      proofs: [] as ReturnType<typeof resolveConditionalRows>,
    };
    const rows = await collectRows(tx, plan, scopes, evidence);
    if (evidence.proofs.some((p) => p.session.pid !== socket.backendPid)) return fail();
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
      absenceProofs: evidence.proofs,
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
