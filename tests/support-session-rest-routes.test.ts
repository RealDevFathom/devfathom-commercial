/**
 * @vitest-environment node
 *
 * DEV-1053: every REST route has a support-session decision.
 *
 * tRPC procedures are decided in `support-session-mutation-policy.test.ts`. This is the same
 * for `src/app/api/**\/route.ts`: each route is listed in
 * `tests/fixtures/support-session-rest-routes.ts` as acting as the member (under the support
 * rule), refusing a support session itself, or not using a member session at all. A new route
 * fails here until it is listed, and a listing the source does not bear out fails too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REST_NOT_A_MEMBER_SESSION,
  REST_REFUSES_SUPPORT,
  REST_TENANT_ACTOR,
} from './fixtures/support-session-rest-routes';

const root = path.resolve(__dirname, '..');
const apiDir = path.join(root, 'src/app/api');

function routeDirs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeDirs(full);
    return entry === 'route.ts' ? [path.relative(apiDir, dir).split(path.sep).join('/')] : [];
  });
}

const routes = routeDirs(apiDir).sort();
const source = (route: string) => readFileSync(path.join(apiDir, route, 'route.ts'), 'utf8');

/** How a route gets the signed-in member, and with them the support identity. */
const RESOLVES_MEMBER = /\bresolveTenantActor\(|\bcreateTRPCContext\(|\bauth\(\)/;
/** A check on the support identity. */
const CHECKS_SUPPORT =
  /\bactor\.support\b|\bisSupportSessionActor\(|\bgetSupportSession\(|\.isSupportSession\b/;

const tenantActor = Object.keys(REST_TENANT_ACTOR);
const refuses = Object.keys(REST_REFUSES_SUPPORT);
const notMember = Object.values(REST_NOT_A_MEMBER_SESSION).flat();

describe('DEV-1053 every REST route has a support-session decision', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('classifies every route exactly once, with no stale entry', () => {
    const classified = [...tenantActor, ...refuses, ...notMember];
    expect(
      classified.filter((route, index) => classified.indexOf(route) !== index),
      'classified more than once'
    ).toEqual([]);
    const known = new Set(classified);
    expect(
      routes.filter((route) => !known.has(route)),
      'a route with no decision: add it to tests/fixtures/support-session-rest-routes.ts'
    ).toEqual([]);
    const real = new Set(routes);
    expect(
      classified.filter((route) => !real.has(route)).sort(),
      'classified, but no such route'
    ).toEqual([]);
  });

  it('acts as the member only through the tenant actor, carrying the support identity', () => {
    for (const route of tenantActor) {
      const text = source(route);
      expect(RESOLVES_MEMBER.test(text), route).toBe(true);
      // A context built by hand from the actor must hand the support identity on, or the
      // central rule would not see it. (`createTRPCContext({ req })` resolves it itself.)
      if (/\bresolveTenantActor\(/.test(text) && /\bcreateTRPCContext\(/.test(text)) {
        expect(text, route).toContain('support: actor.support');
      }
    }
  });

  it('refuses a support session where the listing says so', () => {
    for (const [route, { via }] of Object.entries(REST_REFUSES_SUPPORT)) {
      const text = source(route);
      if (!via) {
        expect(CHECKS_SUPPORT.test(text), route).toBe(true);
        continue;
      }
      // The route hands the request to a module that makes the check.
      const handler = `@/${via.replace(/^src\//, '').replace(/\.ts$/, '')}`;
      expect(text, route).toContain(`from '${handler}'`);
      expect(CHECKS_SUPPORT.test(readFileSync(path.join(root, via), 'utf8')), via).toBe(true);
    }
  });

  it('gives the two central refusals the shared message', () => {
    for (const route of ['password-reset', 'restaurant/devices/browser-enroll']) {
      const text = source(route);
      expect(text, route).toContain('SUPPORT_SESSION_REFUSED_MESSAGE');
      expect(text, route).toContain('recordSupportSessionRefusal(');
      expect(text, route).not.toMatch(/Support sessions cannot/);
    }
  });

  it('never lists a route that resolves a member session as "not a member session"', () => {
    expect(notMember.filter((route) => RESOLVES_MEMBER.test(source(route)))).toEqual([]);
    // And every route that does resolve one is under one of the first two headings.
    const decided = new Set([...tenantActor, ...refuses]);
    expect(
      routes.filter((route) => RESOLVES_MEMBER.test(source(route)) && !decided.has(route))
    ).toEqual([]);
  });
});
