import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) found.push(match[1]);
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
