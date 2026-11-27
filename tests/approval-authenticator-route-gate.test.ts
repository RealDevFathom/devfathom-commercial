import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  calledNames,
  directDatabaseUse,
  functionsOf,
  gatedFunctionNames,
  moduleClosure,
  routeHandlers,
  sameModuleClosure,
  sourceModules,
  sourceOf,
  SRC,
} from './approval-authenticator-route-gate.helpers';

/**
 * DEV-961 — the forced authenticator set-up cannot be bypassed by a route handler.
 *
 * Every signed-in member is resolved in one place, `resolveTenantActor`
 * (`src/lib/tenancy/tenant-actor.ts`), or, for an API token, in `authenticateApiRequest`
 * (`src/lib/api-auth.ts`). Both refuse a member who must set up an approval authenticator
 * for every request that is not a page render: route handlers under `/api` and outside it
 * (exports, downloads), and server actions. This suite enumerates every `route.ts` and every
 * server action so that a new one cannot be added ungated:
 *
 *  - a route handler either loads one of those two resolvers, or is listed below as having
 *    no member session at all, with the reason;
 *  - nothing a route handler loads resolves the member without passing the request (which is
 *    how the resolver knows it is not a page render);
 *  - nothing else reads the Auth.js session.
 */

const TENANT_ACTOR = join(SRC, 'lib/tenancy/tenant-actor.ts');
const API_TOKEN = join(SRC, 'lib/api-auth.ts');

const SIGN_IN = 'signs a member in, out or up: there is no signed-in member yet';
const PLATFORM = 'DevFathom operator console: its own platform session, never a member session';
const MACHINE = 'a machine caller (webhook, cron, sensor, bridge or IdP token), not a member';
const PUBLIC = 'public or customer-facing: no member session';

/** Route handlers that never resolve a signed-in member, relative to `src/app`. */
const NO_MEMBER_SESSION: Record<string, string> = {
  'api/auth/[...nextauth]/route.ts': SIGN_IN,
  'api/login/route.ts': SIGN_IN,
  'login/submit/route.ts': SIGN_IN,
  'api/workspace-requests/route.ts': SIGN_IN,
  'api/sso/oidc/[connectionId]/callback/route.ts': SIGN_IN,
  'api/sso/oidc/[connectionId]/start/route.ts': SIGN_IN,
  'api/sso/saml/[connectionId]/callback/route.ts': SIGN_IN,
  'api/sso/saml/[connectionId]/metadata/route.ts': SIGN_IN,
  'api/sso/saml/[connectionId]/start/route.ts': SIGN_IN,
  'demo/restaurants/access/route.ts': SIGN_IN,
  'demo/restaurants/seats/route.ts': SIGN_IN,
  'api/platform/control/route.ts': PLATFORM,
  'api/platform/jobs/process/route.ts': PLATFORM,
  'api/platform/mfa/route.ts': PLATFORM,
  'api/platform/session/route.ts': PLATFORM,
  'api/platform/support/route.ts': PLATFORM,
  'api/platform/workspace-requests/[id]/route.ts': PLATFORM,
  'api/support-session/launch/route.ts': PLATFORM,
  'api/support-session/route.ts': PLATFORM,
  'api/cron/outbound-effects/route.ts': MACHINE,
  'api/meetings/webhooks/livekit/route.ts': MACHINE,
  'api/pharmacy/cold-chain/readings/route.ts': MACHINE,
  'api/pharmacy/print-bridge/route.ts': MACHINE,
  'api/restaurant/print-bridge/enroll/route.ts': MACHINE,
  'api/pharmacy/sms/webhook/route.ts': MACHINE,
  'api/pharmacy/whatsapp/back-in-stock/route.ts': MACHINE,
  'api/pharmacy/whatsapp/khata-reminders/route.ts': MACHINE,
  'api/pharmacy/whatsapp/reminders/route.ts': MACHINE,
  'api/pharmacy/whatsapp/webhook/route.ts': MACHINE,
  'api/scim/v2/Groups/[id]/route.ts': MACHINE,
  'api/scim/v2/Groups/route.ts': MACHINE,
  'api/scim/v2/ResourceTypes/route.ts': MACHINE,
  'api/scim/v2/Schemas/route.ts': MACHINE,
  'api/scim/v2/ServiceProviderConfig/route.ts': MACHINE,
  'api/scim/v2/Users/[id]/route.ts': MACHINE,
  'api/scim/v2/Users/route.ts': MACHINE,
  '(public)/my-pharmacy/manifest.webmanifest/route.ts': PUBLIC,
  'api/health/route.ts': PUBLIC,
  'api/live/route.ts': PUBLIC,
  'api/ready/route.ts': PUBLIC,
  'api/pharmacy/portal/[action]/route.ts': PUBLIC,
  'api/pharmacy/portal/prescription-upload/route.ts':
    'Uses the patient portal session, not a workspace member session',
  'api/restaurant/checkout/comp/route.ts': PUBLIC,
  'api/wallet/apple/v1/devices/[deviceLibraryIdentifier]/registrations/[passTypeIdentifier]/[serialNumber]/route.ts':
    PUBLIC,
  'api/wallet/apple/v1/devices/[deviceLibraryIdentifier]/registrations/[passTypeIdentifier]/route.ts':
    PUBLIC,
  'api/wallet/apple/v1/log/route.ts': PUBLIC,
  'api/wallet/apple/v1/passes/[passTypeIdentifier]/[serialNumber]/route.ts': PUBLIC,
  'api/wallet/enroll/start/route.ts': PUBLIC,
  'api/wallet/enroll/verify/route.ts': PUBLIC,
};

/** A member resolved with no request cannot be told apart from a page render. */
const RESOLVED_WITHOUT_REQUEST = /\b(resolveTenantActor|createTRPCContext)\(\s*(\{\s*\})?\s*\)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const routes = routeHandlers();
const closures = new Map(routes.map((route) => [route, moduleClosure(route)]));
const memberRoute = (route: string) => {
  const closure = closures.get(route)!;
  return closure.has(TENANT_ACTOR) || closure.has(API_TOKEN);
};

describe('DEV-961 every route handler passes the approval-authenticator gate', () => {
  it('finds the route handlers', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes).toContain('(app)/pharmacy/accounts/fiscal-exceptions/csv/route.ts');
    expect(routes).toContain('(app)/pharmacy/accounts/tax-profile-review/export/route.ts');
  });

  it('resolves the member of every route handler through the gated resolver, or lists why not', () => {
    const unclassified = routes.filter((route) => !memberRoute(route) && !NO_MEMBER_SESSION[route]);
    expect(
      unclassified,
      'A new route handler must resolve its member with resolveTenantActor({ request }) ' +
        '(or createTRPCContext({ req })), or be added to NO_MEMBER_SESSION with the reason'
    ).toEqual([]);
  });

  it('lists only route handlers that really have no member session', () => {
    const stale = Object.keys(NO_MEMBER_SESSION).filter(
      (route) => !closures.has(route) || memberRoute(route)
    );
    expect(stale).toEqual([]);
  });

  it('gates the exports and downloads outside /api', () => {
    for (const route of routes.filter((route) => !route.startsWith('api/'))) {
      if (NO_MEMBER_SESSION[route]) continue;
      expect(closures.get(route)!.has(TENANT_ACTOR), route).toBe(true);
    }
  });

  it('never resolves a route handler’s member without the request', () => {
    const offenders = new Set<string>();
    for (const route of routes)
      for (const file of closures.get(route)!)
        if (RESOLVED_WITHOUT_REQUEST.test(sourceOf(file))) offenders.add(relative(SRC, file));
    expect([...offenders]).toEqual([]);
  });

  it('reads the signed-in member only in the gated resolver', () => {
    // Auth.js's session (`auth()`), the raw session token (`getToken`, `next-auth/jwt`) and the
    // support session are read only where the gate runs.
    const reader = /(^|[^.\w])(auth\(\s*\)|getToken\(|getSupportSession\()|['"]next-auth\/jwt['"]/;
    const allowed = new Set([
      TENANT_ACTOR,
      join(SRC, 'lib/auth.ts'),
      join(SRC, 'lib/tenancy/support-session.ts'),
      // The platform's own support-session endpoint (listed above as PLATFORM).
      join(SRC, 'app/api/support-session/route.ts'),
      // Compares two encodings of the same token to throttle cookie refresh; resolves no one.
      join(SRC, 'lib/auth/session-cookie-throttle.ts'),
    ]);
    const readers = sourceFiles(SRC)
      .filter(
        (file) =>
          !allowed.has(file) &&
          !file.endsWith('.d.ts') &&
          !file.startsWith(join(SRC, 'app/platform/'))
      )
      .filter((file) =>
        sourceOf(file)
          .split('\n')
          .some((line) => !/^\s*(\/\/|\*)/.test(line) && reader.test(line))
      )
      .map((file) => relative(SRC, file));
    expect(readers).toEqual([]);
  });
});

/**
 * DEV-961 — every server action, one function at a time. A server action can be posted as a
 * plain form with no `Next-Action` header, so each action must itself go through the gated
 * resolver (`resolveTenantActor` or `createTRPCContext`, directly or through a helper that does)
 * and must not open the database around it: no `withTenantDb`, `withPlatformDb`,
 * `createTenantDb`, raw SQL or the raw Prisma client, in the action or in any function of its
 * module it calls. Database work goes through a tRPC caller or the gated context's `db`.
 */
describe('DEV-961 every server action passes the approval-authenticator gate', () => {
  // The DevFathom operator console's actions run on the platform session, never a member's.
  const memberModules = sourceModules().filter(
    (file) => !file.startsWith(join(SRC, 'app/platform/'))
  );
  const all = memberModules.flatMap(functionsOf);
  const actions = all.filter((fn) => fn.action);
  const gated = gatedFunctionNames(all);
  const label = (fn: (typeof all)[number]) => `${relative(SRC, fn.file)} ${fn.name}`;

  it('finds the server actions, module-level and inline', () => {
    expect(actions.length).toBeGreaterThan(50);
    expect(actions.map(label)).toContain(
      'app/(app)/pharmacy/accounts/ap-aging/ap-entry-actions.ts payApInvoiceFromForm'
    );
    expect(actions.map(label)).toContain('app/(app)/restaurant/inventory/page.tsx createCount');
  });

  it('resolves the member of every server action through the gated resolver', () => {
    const ungated = actions
      .filter((action) =>
        sameModuleClosure(action, all).every(
          (fn) => ![...calledNames(fn.body, true)].some((name) => gated.has(name))
        )
      )
      .map(label);
    expect(
      ungated,
      'A server action must call resolveTenantActor or createTRPCContext (directly or through a helper)'
    ).toEqual([]);
  });

  it('never opens the database around the gate in a server action', () => {
    const direct = actions.flatMap((action) =>
      sameModuleClosure(action, all).flatMap((fn) =>
        directDatabaseUse(fn).map(
          (use) => `${label(action)}: ${use}${fn === action ? '' : ` (in ${fn.name})`}`
        )
      )
    );
    expect(
      direct,
      'Database work in a server action goes through a tRPC caller or the gated context db'
    ).toEqual([]);
  });
});
