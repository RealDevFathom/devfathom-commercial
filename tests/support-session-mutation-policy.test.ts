/**
 * @vitest-environment node
 *
 * DEV-1053: a platform support session cannot create lasting access.
 *
 * 1. Every tRPC mutation in the application is classified in
 *    `tests/fixtures/support-session-mutation-policy.ts` as "support may" or "support may
 *    not". A new mutation fails here until it is added to one side.
 * 2. The classification is what the code enforces: a "may not" mutation carries the central
 *    rule's meta, a "may" mutation does not, and every procedure runs the rule.
 * 3. Calling a "may not" mutation as a support session is refused with the plain message
 *    before anything else runs, and the refusal is audited with the operator's identity.
 * 4. Queries are open to a support session except the ones listed as refused (a member's
 *    mailbox). A query under the rule that is not listed, or listed and not under the rule,
 *    fails here, and each listed query is called and refused like a mutation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUPPORT_MAY,
  SUPPORT_MAY_NOT,
  SUPPORT_MAY_NOT_BY_ROUTER,
  SUPPORT_MAY_NOT_QUERIES,
  SUPPORT_MAY_NOTES,
} from './fixtures/support-session-mutation-policy';

const audited = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn((args: Record<string, unknown>) => {
    audited.calls.push(args);
  }),
}));

type Procedure = {
  _def: {
    type: 'query' | 'mutation' | 'subscription';
    meta?: { supportSession?: 'refuse' };
    middlewares: readonly unknown[];
  };
};
type RouterLike = {
  _def: { procedures: Record<string, Procedure> };
  createCaller: (ctx: unknown) => unknown;
};

/**
 * Routers that are served outside `appRouter` (server components and server actions call
 * them directly). Each is enumerated here under `standalone:<name>.`; the source scan below
 * fails when a router file is neither mounted in the app router nor listed.
 */
const STANDALONE: Readonly<Record<string, { file: string; load: () => Promise<RouterLike> }>> = {
  pharmacyPrepaid: {
    file: 'src/app/(app)/pharmacy/loyalty/prepaid-router.ts',
    load: async () =>
      (await import('@/app/(app)/pharmacy/loyalty/prepaid-router'))
        .pharmacyPrepaidRouter as unknown as RouterLike,
  },
  pharmacyLoyalty: {
    file: 'src/app/(app)/pharmacy/loyalty/loyalty-router.ts',
    load: async () =>
      (await import('@/app/(app)/pharmacy/loyalty/loyalty-router'))
        .pharmacyLoyaltyRouter as unknown as RouterLike,
  },
  pharmacyKhata: {
    file: 'src/app/(app)/pharmacy/khata/khata-router.ts',
    load: async () =>
      (await import('@/app/(app)/pharmacy/khata/khata-router'))
        .pharmacyKhataRouter as unknown as RouterLike,
  },
  cameraPrivacy: {
    file: 'src/lib/cameras/privacy.ts',
    load: async () =>
      (await import('@/lib/cameras/privacy')).cameraPrivacyRouter as unknown as RouterLike,
  },
  journalEntryLookup: {
    file: 'src/lib/pharmacy/accounts/journal-entry-lookup.ts',
    load: async () =>
      (await import('@/lib/pharmacy/accounts/journal-entry-lookup'))
        .journalEntryLookupRouter as unknown as RouterLike,
  },
  pharmacyStagedReview: {
    file: 'src/server/routers/pharmacy-staged-review.ts',
    load: async () =>
      (await import('@/server/routers/pharmacy-staged-review'))
        .pharmacyStagedReviewRouter as unknown as RouterLike,
  },
};

/**
 * Router files that define no reachable session procedure of their own.
 * `anonymous-fallback.ts` answers unroutable anonymous requests with fixed replies from its
 * own tRPC instance: it has no session, no tenant and no writes.
 */
const NOT_A_SESSION_ROUTER: ReadonlySet<string> = new Set([
  // The app router itself, enumerated in full above.
  'src/server/routers/_app.ts',
  'src/server/trpc.ts',
  'src/server/routers/anonymous-fallback.ts',
]);

const MESSAGE =
  'A support session cannot do this. It would create or change sign-in details, staff access, a device or a key, or export the whole business. Ask the business owner to do it from their own account.';

const mayNot = SUPPORT_MAY_NOT.flatMap((group) => group.mutations);
const mayNotByRouter = SUPPORT_MAY_NOT_BY_ROUTER.flatMap((group) => group.mutations);
const mayNotQueries = SUPPORT_MAY_NOT_QUERIES.flatMap((group) => group.queries);
/** Everything the central rule refuses: mutations and queries. */
const refused = [...mayNot, ...mayNotQueries];
const may = Object.entries(SUPPORT_MAY).flatMap(([namespace, names]) =>
  names.split(' ').map((name) => `${namespace}.${name}`)
);

const procedures = new Map<string, { procedure: Procedure; router: RouterLike; local: string }>();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'generated' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** A context whose database refuses every use: a refused call must never reach it. */
function supportContext(kind: 'support' | 'session-flag' | 'member') {
  const db = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'then') return undefined;
        throw new Error(`database touched: ${String(property)}`);
      },
    }
  );
  const support =
    kind === 'support'
      ? {
          supportSessionId: 'support_session_1',
          organizationId: 'org_1',
          platformUserId: 'platform_operator_1',
          tenantUserId: 'owner_1',
          tenantUserRole: 'ADMIN',
          expiresAt: new Date(Date.now() + 60_000),
          reason: 'Ticket 4821: receipt printer',
        }
      : null;
  return {
    db,
    entitlements: { organizationId: 'org_1', enabledModules: [], modules: [], limits: {} },
    session: {
      expires: 'later',
      user: {
        id: 'owner_1',
        organizationId: 'org_1',
        name: 'Owner',
        email: 'owner@test.invalid',
        role: 'ADMIN',
        status: 'ACTIVE',
        ...(kind === 'session-flag'
          ? {
              isSupportSession: true,
              supportSessionId: 'support_session_1',
              platformUserId: 'platform_operator_1',
            }
          : {}),
      },
    },
    organization: { id: 'org_1', isDemo: false },
    support,
    requestMeta: { ip: '203.0.113.9', userAgent: 'vitest' },
    audit: { detail: {} },
  };
}

async function call(name: string, kind: 'support' | 'session-flag' | 'member') {
  const entry = procedures.get(name)!;
  let target = entry.router.createCaller(supportContext(kind)) as Record<string, unknown>;
  const segments = entry.local.split('.');
  for (const segment of segments.slice(0, -1)) target = target[segment] as Record<string, unknown>;
  const run = target[segments.at(-1)!] as (input: unknown) => Promise<unknown>;
  // No input at all: the rule answers before validation, permissions or the resolver.
  return run(undefined).then(
    () => ({ code: 'OK', message: '' }),
    (error: { code?: string; message?: string }) => ({
      code: String(error.code),
      message: String(error.message),
    })
  );
}

let procedureRefusesSupportSession: typeof import('@/server/trpc').procedureRefusesSupportSession;
let procedureRunsSupportSessionRule: typeof import('@/server/trpc').procedureRunsSupportSessionRule;

beforeAll(async () => {
  ({ procedureRefusesSupportSession, procedureRunsSupportSessionRule } =
    await import('@/server/trpc'));
  const { appRouter } = await import('@/server/routers/_app');
  const app = appRouter as unknown as RouterLike;
  for (const [name, procedure] of Object.entries(app._def.procedures)) {
    procedures.set(name, { procedure, router: app, local: name });
  }
  for (const [key, { load }] of Object.entries(STANDALONE)) {
    const router = await load();
    for (const [name, procedure] of Object.entries(router._def.procedures)) {
      procedures.set(`standalone:${key}.${name}`, { procedure, router, local: name });
    }
  }
}, 300_000);

beforeEach(() => {
  audited.calls.length = 0;
});

const mutations = () =>
  [...procedures].filter(([, entry]) => entry.procedure._def.type === 'mutation');

describe('DEV-1053 every mutation has a support-session decision', () => {
  it('finds the application', () => {
    expect(mutations().length).toBeGreaterThan(700);
    expect(mayNot.length).toBeGreaterThan(80);
  });

  it('classifies every mutation exactly once, with no stale entry', () => {
    const classified = [...mayNot, ...mayNotByRouter, ...may];
    const twice = classified.filter((name, index) => classified.indexOf(name) !== index);
    expect(twice, 'classified more than once').toEqual([]);
    const names = mutations().map(([name]) => name);
    const known = new Set(classified);
    expect(
      names.filter((name) => !known.has(name)).sort(),
      'a mutation with no decision: add it to tests/fixtures/support-session-mutation-policy.ts as "support may" or "support may not"'
    ).toEqual([]);
    const real = new Set(names);
    expect(
      classified.filter((name) => !real.has(name)).sort(),
      'classified, but no such mutation'
    ).toEqual([]);
    for (const note of Object.keys(SUPPORT_MAY_NOTES)) {
      expect(may, `note for ${note}`).toContain(note);
    }
  });

  it('runs the central rule on every procedure, queries included', () => {
    const without = [...procedures]
      .filter(([, entry]) => !procedureRunsSupportSessionRule(entry.procedure))
      .map(([name]) => name);
    expect(without).toEqual([]);
  });

  it('enforces exactly the classification, refused queries included', () => {
    const enforced = [...procedures].filter(([, entry]) =>
      procedureRefusesSupportSession(entry.procedure)
    );
    const ofType = (type: 'query' | 'mutation') =>
      enforced
        .filter(([, entry]) => entry.procedure._def.type === type)
        .map(([name]) => name)
        .sort();
    // Every procedure under the rule is a mutation or a query, and each is decided by name.
    expect(ofType('mutation')).toEqual([...mayNot].sort());
    expect(ofType('query')).toEqual([...mayNotQueries].sort());
    expect(enforced.map(([name]) => name).sort()).toEqual([...refused].sort());
  });

  it('classifies each refused query once, and only real queries', () => {
    expect(mayNotQueries.length).toBeGreaterThan(0);
    expect(new Set(mayNotQueries).size).toBe(mayNotQueries.length);
    for (const name of mayNotQueries) {
      expect(procedures.get(name)?.procedure._def.type, name).toBe('query');
    }
    // The mailbox is refused whole: every email procedure except the provider list.
    const email = [...procedures.keys()].filter((name) => name.startsWith('email.'));
    expect(email.filter((name) => !refused.includes(name))).toEqual(['email.providers']);
  });

  it('covers every router file: mounted in the app router or listed as standalone', () => {
    const root = path.resolve(__dirname, '..');
    const routerFiles = sourceFiles(path.join(root, 'src'))
      .filter((file) => /\brouter\(\{/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).split(path.sep).join('/'));
    const routersDir = 'src/server/routers/';
    const mountedSources = sourceFiles(path.join(root, routersDir)).map((file) =>
      readFileSync(file, 'utf8')
    );
    const standaloneFiles = new Set(Object.values(STANDALONE).map((entry) => entry.file));
    const uncovered = routerFiles.filter((file) => {
      if (standaloneFiles.has(file) || NOT_A_SESSION_ROUTER.has(file)) return false;
      if (!file.startsWith(routersDir)) return true;
      // Mounted: another router file imports it (the app router, or a parent router).
      const base = path.basename(file).replace(/\.ts$/, '');
      return !mountedSources.some((source) => source.includes(`from './${base}'`));
    });
    expect(uncovered, 'a router no test enumerates').toEqual([]);
  });
});

describe('DEV-1053 a refused mutation or query, called as a support session', () => {
  it.each(['support', 'session-flag'] as const)(
    'is refused with the plain message and audited with the operator (%s)',
    async (kind) => {
      for (const name of refused) {
        audited.calls.length = 0;
        const result = await call(name, kind);
        expect(result, name).toEqual({ code: 'FORBIDDEN', message: MESSAGE });
        expect(audited.calls, name).toHaveLength(1);
        const entry = audited.calls[0] as {
          path: string;
          type: string;
          outcome: string;
          input: unknown;
          error: { code: string };
          ctx: {
            session: { user: Record<string, unknown> };
            audit: { detail: { skipInput?: boolean; metadata?: Record<string, unknown> } };
          };
        };
        expect(entry.path, name).toBe(procedures.get(name)!.local);
        expect(entry.type, name).toBe(procedures.get(name)!.procedure._def.type);
        expect(entry.outcome, name).toBe('FAILURE');
        expect(entry.error.code, name).toBe('FORBIDDEN');
        expect(entry.input, name).toBeUndefined();
        expect(entry.ctx.audit.detail.skipInput, name).toBe(true);
        expect(entry.ctx.audit.detail.metadata, name).toEqual({ supportSessionRefused: true });
        expect(entry.ctx.session.user, name).toMatchObject({
          id: 'owner_1',
          organizationId: 'org_1',
          isSupportSession: true,
          supportSessionId: 'support_session_1',
          platformUserId: 'platform_operator_1',
        });
      }
    },
    120_000
  );

  it('is not refused by the rule for the member themselves', async () => {
    for (const name of refused) {
      const result = await call(name, 'member');
      expect(result.message, name).not.toBe(MESSAGE);
    }
  }, 120_000);

  it('never answers a "may" mutation with the rule', async () => {
    for (const name of [...may, ...mayNotByRouter]) {
      const result = await call(name, 'support');
      expect(result.message, name).not.toBe(MESSAGE);
    }
    expect(
      audited.calls.filter(
        (entry) =>
          (entry.ctx as { audit?: { detail?: { metadata?: Record<string, unknown> } } }).audit
            ?.detail?.metadata?.supportSessionRefused === true
      )
    ).toEqual([]);
  }, 300_000);
});
