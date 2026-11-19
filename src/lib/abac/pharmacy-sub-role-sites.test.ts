// @vitest-environment node
/**
 * DEV-959A: every place the server checks a pharmacy action must be explained by the
 * sub-role that holds it. This test finds every use of each action's name in the
 * server, the libraries and the API routes, and fails when a use is not counted by
 * an entry in the catalogue's "what this allows" table (or in the short list of uses
 * that grant nothing). A new check, a removed check, or one moved to another file
 * all fail here until the owner-facing description is reviewed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PHARMACY_ACTION_NON_GRANTING_SITES,
  PHARMACY_SUB_ROLES,
  PHARMACY_SUB_ROLE_ACTIONS,
} from './pharmacy-sub-roles';

const ROOTS = ['src/server', 'src/lib', 'src/app/api'];
/** Where actions are defined or the engine itself lives, and other business types. */
const NOT_A_USE_SITE = [
  /^src\/lib\/abac\//,
  /^src\/server\/trpc\.ts$/,
  /^src\/lib\/vertical-catalog\.ts$/,
  /restaurant/,
  /hotel/,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const root = process.cwd();
const FILES = ROOTS.flatMap((dir) => sourceFiles(join(root, dir)))
  .map((full) => ({ path: relative(root, full).split('\\').join('/'), full }))
  .filter(({ path }) => !NOT_A_USE_SITE.some((pattern) => pattern.test(path)))
  .map(({ path, full }) => ({ path, text: readFileSync(full, 'utf8') }));

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Occurrences of the quoted action name, per file. */
function useSites(action: string): Record<string, number> {
  const pattern = new RegExp(`(['"\`])${escape(action)}\\1`, 'g');
  const counts: Record<string, number> = {};
  for (const file of FILES) {
    const found = file.text.match(pattern)?.length ?? 0;
    if (found > 0) counts[file.path] = found;
  }
  return counts;
}

/** The use sites the catalogue explains for an action, per file. */
function explainedSites(action: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (path: string, count: number) => {
    counts[path] = (counts[path] ?? 0) + count;
  };
  for (const subRole of PHARMACY_SUB_ROLES) {
    for (const item of subRole.allows) {
      if ((item.action ?? subRole.actions[0]) !== action) continue;
      for (const [path, count] of Object.entries(item.sites)) add(path, count);
    }
  }
  for (const [path, site] of Object.entries(PHARMACY_ACTION_NON_GRANTING_SITES[action] ?? {}))
    add(path, site.count);
  return counts;
}

describe('every pharmacy check is explained by its sub-role', () => {
  it.each(PHARMACY_SUB_ROLE_ACTIONS.map((action) => [action]))(
    '%s: each use in the code is counted by a "what this allows" entry',
    (action) => {
      expect(explainedSites(action)).toEqual(useSites(action));
    }
  );

  it('names an action for any entry of a sub-role that holds several', () => {
    for (const subRole of PHARMACY_SUB_ROLES) {
      if (subRole.actions.length === 1) continue;
      for (const item of subRole.allows) expect(subRole.actions).toContain(item.action);
    }
  });

  it('backs every line an owner reads with at least one real use', () => {
    for (const subRole of PHARMACY_SUB_ROLES) {
      expect(subRole.allows.length).toBeGreaterThan(0);
      for (const item of subRole.allows) {
        const total = Object.values(item.sites).reduce((sum, count) => sum + count, 0);
        expect(total, `${subRole.key}: ${item.text}`).toBeGreaterThan(0);
      }
      const texts = subRole.allows.map((item) => item.text);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it('gives a reason for every use that grants nothing', () => {
    for (const sites of Object.values(PHARMACY_ACTION_NON_GRANTING_SITES))
      for (const site of Object.values(sites)) expect(site.reason.length).toBeGreaterThan(0);
  });

  it('finds the checks it is meant to find', () => {
    // Guards the scanner itself: a known capability procedure must be seen.
    expect(
      useSites('pharmacy:dispense')['src/server/routers/pharmacy-dispensing.ts']
    ).toBeGreaterThan(0);
  });
});
