/**
 * The fallback router exists so that a request which could not be routed to any
 * tenant is answered INDISTINGUISHABLY from one that reached the real router and
 * was refused there. That only holds if both tRPC instances serialize an error
 * the same way.
 *
 * `@/server/trpc` and `anonymous-fallback` each call `initTRPC.create` with their
 * OWN copy of the same `errorFormatter` — repeated rather than shared, because the
 * fallback is deliberately standalone (no context, no database handle). Two
 * `initTRPC.create` calls holding duplicated options are exactly the kind of thing
 * that drifts silently: nothing fails, the bodies just stop matching, and the
 * difference is a signal an anonymous caller can read. These tests compare the two
 * byte for byte so the drift is caught here rather than by someone diffing
 * responses in the wild.
 */
import { TRPCError, type AnyRouter } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { describe, expect, it, vi } from 'vitest';

// `@/server/trpc` is imported for its REAL tRPC instance, so only its unrelated
// server-side dependencies are stubbed. The `errorFormatter` under test is
// untouched.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { INVITATION_GENERIC_MESSAGE, RESET_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';
import { publicProcedure, router } from '@/server/trpc';

import { anonymousFallbackRouter } from './anonymous-fallback';
import { invitationsRouter } from './invitations';
import { passwordResetRouter } from './password-reset';
import { pharmacySupplierLinksRouter } from './pharmacy-supplier-links';

const TRPC_ENDPOINT = '/api/trpc';

/**
 * The real routers' rejections, raised through the REAL tRPC instance and at the
 * same procedure paths the fallback serves. Same code, same message, same path,
 * so anything that differs in the response is the formatter and nothing else.
 */
const realRouter = router({
  invitations: router({
    get: publicProcedure.query(() => {
      throw new TRPCError({ code: 'NOT_FOUND', message: INVITATION_GENERIC_MESSAGE });
    }),
  }),
  passwordReset: router({
    reset: publicProcedure.mutation(() => {
      throw new TRPCError({ code: 'BAD_REQUEST', message: RESET_GENERIC_MESSAGE });
    }),
  }),
});

const productionAnonymousRouter = router({
  invitations: invitationsRouter,
  passwordReset: passwordResetRouter,
  pharmacySupplierLinks: pharmacySupplierLinksRouter,
});

type ServedResponse = {
  status: number;
  contentType: string | null;
  body: unknown;
  hasStack: boolean;
};

/**
 * `data.stack` is a per-call file/line trace that cannot match across two
 * different modules, and tRPC omits it in production. Parity is asserted on
 * everything else, plus on stack PRESENCE, which is the part an anonymous caller
 * could actually use to tell the two paths apart.
 */
function stripStacks(value: unknown): { body: unknown; hasStack: boolean } {
  let hasStack = false;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'stack') {
          hasStack = true;
          continue;
        }
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  };

  return { body: walk(value), hasStack };
}

async function serve(router_: AnyRouter, request: Request): Promise<ServedResponse> {
  const response = await fetchRequestHandler({
    endpoint: TRPC_ENDPOINT,
    req: request,
    router: router_ as never,
    // Both routers are erased to `never` above so one helper can serve either;
    // the context factory has to follow.
    createContext: (() => ({})) as never,
  });
  const parsed = stripStacks(await response.json());
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: parsed.body,
    hasStack: parsed.hasStack,
  };
}

const query = (path: string) =>
  new Request(`http://acme.example.test${TRPC_ENDPOINT}/${path}?batch=1`, { method: 'GET' });

const queryWithInput = (path: string, input: unknown) => {
  const encoded = encodeURIComponent(JSON.stringify({ '0': { json: input } }));
  return new Request(`http://acme.example.test${TRPC_ENDPOINT}/${path}?batch=1&input=${encoded}`, {
    method: 'GET',
  });
};

const mutation = (path: string, input: unknown) =>
  new Request(`http://acme.example.test${TRPC_ENDPOINT}/${path}?batch=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ '0': { json: input } }),
  });

describe('fallback and real routers serialize refusals identically', () => {
  it.each([
    ['invitations.get', 'query', { token: '' }],
    ['invitations.get', 'query', { token: 42 }],
    [
      'invitations.accept',
      'mutation',
      { token: 'token', password: 'short', phone: '+15555550123' },
    ],
    ['invitations.accept', 'mutation', { token: 'token' }],
    ['passwordReset.request', 'mutation', { email: '' }],
    ['passwordReset.request', 'mutation', { email: 42 }],
    ['passwordReset.validate', 'query', { token: '' }],
    ['passwordReset.validate', 'query', {}],
    ['passwordReset.reset', 'mutation', { token: 'token', newPassword: 'short' }],
    ['passwordReset.reset', 'mutation', { token: [], newPassword: 'Valid-password-123' }],
    ['pharmacySupplierLinks.get', 'query', { token: '   ' }],
    ['pharmacySupplierLinks.get', 'query', { token: 'token', unexpected: true }],
    [
      'pharmacySupplierLinks.submit',
      'mutation',
      { token: 'token', kind: 'UNKNOWN', idempotencyKey: 'key', payload: {} },
    ],
    [
      'pharmacySupplierLinks.submit',
      'mutation',
      {
        token: 'token',
        kind: 'ACKNOWLEDGEMENT',
        idempotencyKey: 'x'.repeat(201),
        payload: {},
      },
    ],
    [
      'pharmacySupplierLinks.uploadDocument',
      'mutation',
      {
        token: 'token',
        idempotencyKey: 'key',
        fileName: 'evidence.txt',
        declaredMimeType: 'text/plain',
        contentBase64: 'dGVzdA==',
      },
    ],
    [
      'pharmacySupplierLinks.uploadDocument',
      'mutation',
      {
        token: 'token',
        idempotencyKey: 'key',
        fileName: 'evidence.pdf',
        declaredMimeType: 'application/pdf',
        contentBase64: '',
      },
    ],
  ] as const)('matches production validation for malformed %s input', async (path, kind, input) => {
    const request = () => (kind === 'query' ? queryWithInput(path, input) : mutation(path, input));

    const real = await serve(productionAnonymousRouter, request());
    const fallback = await serve(anonymousFallbackRouter, request());

    expect(real.status).toBe(400);
    expect(fallback.status).toBe(real.status);
    expect(fallback.contentType).toBe(real.contentType);
    expect(fallback.hasStack).toBe(real.hasStack);
    expect(fallback.body).toEqual(real.body);
  });

  it('matches on a NOT_FOUND from invitations.get', async () => {
    const request = () => query('invitations.get');

    const real = await serve(realRouter, request());
    const fallback = await serve(anonymousFallbackRouter, request());

    expect(fallback.status).toBe(real.status);
    expect(fallback.contentType).toBe(real.contentType);
    expect(fallback.hasStack).toBe(real.hasStack);
    expect(fallback.body).toEqual(real.body);
  });

  it('matches on a BAD_REQUEST from passwordReset.reset', async () => {
    const input = { token: 'anything', newPassword: 'Sufficiently-Long-1!' };

    const real = await serve(realRouter, mutation('passwordReset.reset', input));
    const fallback = await serve(anonymousFallbackRouter, mutation('passwordReset.reset', input));

    expect(fallback.status).toBe(real.status);
    expect(fallback.contentType).toBe(real.contentType);
    expect(fallback.hasStack).toBe(real.hasStack);
    expect(fallback.body).toEqual(real.body);
  });

  /**
   * The batched envelope is part of the observable shape: a caller that batches
   * two calls must not be able to tell the paths apart by how the array comes
   * back, only by the errors inside it.
   */
  it('matches on the batched-response envelope', async () => {
    const request = () => query('invitations.get,invitations.get');

    const real = await serve(realRouter, request());
    const fallback = await serve(anonymousFallbackRouter, request());

    expect(Array.isArray(fallback.body)).toBe(true);
    expect((fallback.body as unknown[]).length).toBe((real.body as unknown[]).length);
    expect(fallback.body).toEqual(real.body);
  });
});
