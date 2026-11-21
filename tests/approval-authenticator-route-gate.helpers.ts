import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Repository root and `src`. */
export const ROOT = resolve(__dirname, '..');
export const SRC = join(ROOT, 'src');

/** Every route handler under `src/app`, as a path relative to `src/app`. */
export function routeHandlers(): string[] {
  const app = join(SRC, 'app');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /^route\.(ts|tsx|js)$/.test(name) ? [relative(app, path)] : [];
    });
  return walk(app).sort();
}

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  if (base.startsWith(join(SRC, 'generated'))) return null;
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const extension of EXTENSIONS) if (existsSync(base + extension)) return base + extension;
  return null;
}

/** Value imports (static, dynamic and re-exports) of a module; type-only imports are skipped. */
function imports(file: string, source: string): string[] {
  const found: string[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(statement)) if (!match[2]) found.push(match[3]);
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g))
    found.push(match[1]);
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]);
  return found.flatMap((specifier) => resolveSpecifier(file, specifier) ?? []);
}

const sources = new Map<string, string>();
export function sourceOf(file: string): string {
  let source = sources.get(file);
  if (source === undefined) {
    source = readFileSync(file, 'utf8');
    sources.set(file, source);
  }
  return source;
}

/** Every `src` module a route handler loads, the route itself included (absolute paths). */
export function moduleClosure(route: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(SRC, 'app', route)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of imports(file, sourceOf(file))) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

// ── Server actions, one function at a time ────────────────────────────────────────────────

/** Every non-test source module under `src` (generated code excluded), absolute paths. */
export function sourceModules(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'generated' ? [] : walk(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  return walk(SRC);
}

type FunctionInfo = {
  file: string;
  name: string;
  body: ts.Node;
  source: ts.SourceFile;
  /** A server action: an exported function of a 'use server' module, or one whose body starts with 'use server'. */
  action: boolean;
};

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(
      file,
      sourceOf(file),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    parsed.set(file, source);
  }
  return source;
}

const startsWithUseServer = (statements: ts.NodeArray<ts.Statement> | undefined) => {
  const first = statements?.[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
};

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** Every named function in `file`, marking the server actions. */
export function functionsOf(file: string): FunctionInfo[] {
  const source = parse(file);
  const moduleAction = startsWithUseServer(source.statements);
  const found: FunctionInfo[] = [];
  const visit = (node: ts.Node) => {
    let name: string | undefined;
    let body: ts.Node | undefined;
    let exported = false;
    if (ts.isFunctionDeclaration(node) && node.body) {
      name = node.name?.text;
      body = node.body;
      exported = isExported(node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
      body = node.initializer.body;
      const statement = node.parent?.parent;
      exported = !!statement && ts.isVariableStatement(statement) && isExported(statement);
    }
    if (name && body) {
      const inline = ts.isBlock(body) && startsWithUseServer(body.statements);
      found.push({ file, name, body, source, action: inline || (moduleAction && exported) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The names a function body calls. With `identifiersOnly`, only plain calls (`f()`), not
 * method calls (`x.f()`), whose names say nothing about which function runs.
 */
export function calledNames(body: ts.Node, identifiersOnly = false): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (!identifiersOnly && ts.isPropertyAccessExpression(callee))
        names.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}

/** The entry points that resolve the signed-in member and refuse a held one. */
export const GATED_ENTRIES = ['resolveTenantActor', 'createTRPCContext'] as const;

/**
 * Names of functions anywhere in `src` that reach a gated entry through plain calls, to a fixed
 * point (a helper such as a page's `tenantContext()` that calls `resolveTenantActor`).
 */
export function gatedFunctionNames(all: FunctionInfo[]): Set<string> {
  const gated = new Set<string>(GATED_ENTRIES);
  const calls = all.map((fn) => ({ name: fn.name, calls: calledNames(fn.body, true) }));
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of calls)
      if (!gated.has(fn.name) && [...fn.calls].some((name) => gated.has(name))) {
        gated.add(fn.name);
        changed = true;
      }
  }
  return gated;
}

/** Calls that open the database directly, around the gated context's `db`. */
const DIRECT_DATABASE_CALLS = new Set([
  'withTenantDb',
  'withPlatformDb',
  'createTenantDb',
  'PrismaClient',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

/** Local names a module binds to the raw Prisma client (`import { db } from '@/lib/db'`). */
function rawClientNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (from !== '@/lib/db' && !from.startsWith('@/generated/prisma')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if (!element.isTypeOnly) names.add(element.name.text);
    if (statement.importClause?.name) names.add(statement.importClause.name.text);
  }
  return names;
}

/** Direct database use in a function body: a raw-client call, or the module's raw client. */
export function directDatabaseUse(fn: FunctionInfo): string[] {
  const raw = rawClientNames(fn.source);
  const uses = new Set<string>();
  for (const name of calledNames(fn.body)) if (DIRECT_DATABASE_CALLS.has(name)) uses.add(name);
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      raw.has(node.expression.text)
    )
      uses.add(`${node.expression.text}.${node.name.text}`);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return [...uses];
}

/**
 * The functions an action runs from its own module, to a fixed point: a database write moved
 * into a local helper is still the action's.
 */
export function sameModuleClosure(action: FunctionInfo, all: FunctionInfo[]): FunctionInfo[] {
  const local = all.filter((fn) => fn.file === action.file);
  const reached = new Map<string, FunctionInfo>([[action.name, action]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of [...reached.values()])
      for (const name of calledNames(fn.body, true))
        for (const candidate of local.filter((other) => other.name === name))
          if (!reached.has(candidate.name)) {
            reached.set(candidate.name, candidate);
            changed = true;
          }
  }
  return [...reached.values()];
}
