/**
 * The allowlist is the whole security boundary of the anonymous transport: if a
 * procedure appears here it can run with no session, and if it does not, it
 * cannot. These tests pin the exact membership and the batch rule.
 */
import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_HOST_PROCEDURES,
  ANONYMOUS_PROCEDURES,
  ANONYMOUS_TOKEN_PROCEDURES,
  anonymousToken,
  classifyAnonymousRequest,
  requestedProcedures,
  tokenFromInput,
} from './anonymous-access';

const url = (path: string, query = '') => `http://acme.example.com/api/trpc/${path}${query}`;
const get = (path: string, query = '') => new Request(url(path, query));
const post = (path: string, body: unknown) =>
  new Request(url(path, '?batch=1'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the anonymous allowlist', () => {
  it('is exactly these seven procedures and nothing else', () => {
    // SUP-01 supplier PO action links are anonymous by design: their signed,
    // expiring token names exactly one supplier relationship and purchase order.
    expect([...ANONYMOUS_PROCEDURES].sort()).toEqual([
      'invitations.accept',
      'invitations.get',
      'passwordReset.request',
      'passwordReset.reset',
      'passwordReset.validate',
      'pharmacySupplierLinks.get',
      'pharmacySupplierLinks.submit',
    ]);
  });

  it('routes the token-bearing six by token and the email-bearing one by host', () => {
    expect([...ANONYMOUS_TOKEN_PROCEDURES].sort()).toEqual([
      'invitations.accept',
      'invitations.get',
      'passwordReset.reset',
      'passwordReset.validate',
      'pharmacySupplierLinks.get',
      'pharmacySupplierLinks.submit',
    ]);
    // `passwordReset.request` takes an email and no token, so a token cannot
    // name its tenant. Allowlisting it alongside the others without a separate
    // host-routed path would leave it permanently unroutable — a 401 forever.
    expect([...ANONYMOUS_HOST_PROCEDURES]).toEqual(['passwordReset.request']);
  });

  it.each([
    'clients.getAll',
    'team.list',
    'passwordReset.requestSomethingElse',
    'invitations',
    'invitations.getAll',
    'auth.signIn',
    'pharmacySupplierLinks.uploadDocument',
  ])('does not admit %s', (procedure) => {
    expect(ANONYMOUS_PROCEDURES.has(procedure)).toBe(false);
    expect(classifyAnonymousRequest(get(procedure))).toEqual({ kind: 'denied' });
  });
});

describe('classifyAnonymousRequest', () => {
  it('admits a single allowlisted token procedure', () => {
    expect(classifyAnonymousRequest(get('invitations.get'))).toEqual({
      kind: 'token',
      procedures: ['invitations.get'],
    });
  });

  it('admits a batch whose members are all token-routed', () => {
    expect(classifyAnonymousRequest(get('invitations.get,passwordReset.validate'))).toEqual({
      kind: 'token',
      procedures: ['invitations.get', 'passwordReset.validate'],
    });
  });

  it('admits the host-routed procedure', () => {
    expect(classifyAnonymousRequest(get('passwordReset.request'))).toEqual({
      kind: 'host',
      procedures: ['passwordReset.request'],
    });
  });

  // The batch rule that matters: tRPC runs a batch as one request, so admitting
  // it because SOME member is public would run a protected procedure without a
  // session. The whole batch is rejected instead.
  it.each([
    ['allowlisted first', 'invitations.get,clients.getAll'],
    ['allowlisted last', 'clients.getAll,invitations.get'],
    ['allowlisted on both sides', 'invitations.get,clients.getAll,passwordReset.validate'],
    ['host-routed with a protected procedure', 'passwordReset.request,clients.getAll'],
  ])('rejects a whole batch that mixes %s', (_label, path) => {
    expect(classifyAnonymousRequest(get(path))).toEqual({ kind: 'denied' });
  });

  // The two strategies derive the tenant from different evidence; a batch
  // claiming both would have to silently pick one.
  it('rejects a batch that mixes token-routed and host-routed procedures', () => {
    expect(classifyAnonymousRequest(get('invitations.get,passwordReset.request'))).toEqual({
      kind: 'denied',
    });
  });

  it('rejects a request that names no procedure at all', () => {
    expect(classifyAnonymousRequest(get(''))).toEqual({ kind: 'denied' });
  });

  it('is not fooled by URL encoding of the separator', () => {
    // %2C is a comma. Decoding before splitting means an encoded batch is
    // classified as the batch it actually is, not as one unknown procedure name.
    expect(requestedProcedures(get('invitations.get%2Cclients.getAll'))).toEqual([
      'invitations.get',
      'clients.getAll',
    ]);
    expect(classifyAnonymousRequest(get('invitations.get%2Cclients.getAll'))).toEqual({
      kind: 'denied',
    });
  });
});

describe('token extraction', () => {
  it('reads a token from a superjson-wrapped batch entry', () => {
    expect(tokenFromInput({ '0': { json: { token: 'abc' } } })).toBe('abc');
  });

  it('reads a token from a bare entry', () => {
    expect(tokenFromInput({ '0': { token: 'abc' } })).toBe('abc');
  });

  it.each([
    ['no token field', { '0': { json: { email: 'a@b.c' } } }],
    ['an empty token', { '0': { json: { token: '' } } }],
    ['a non-string token', { '0': { json: { token: 42 } } }],
    ['a non-object payload', 'nonsense'],
    ['null', null],
  ])('returns null for %s', (_label, payload) => {
    expect(tokenFromInput(payload)).toBeNull();
  });

  it('reads the token from the query string of a batched GET', async () => {
    const input = encodeURIComponent(JSON.stringify({ '0': { json: { token: 'query-token' } } }));
    await expect(anonymousToken(get('invitations.get', `?batch=1&input=${input}`))).resolves.toBe(
      'query-token'
    );
  });

  it('reads the token from a POST body', async () => {
    await expect(
      anonymousToken(post('invitations.accept', { '0': { json: { token: 'body-token' } } }))
    ).resolves.toBe('body-token');
  });

  it('leaves the POST body readable for the tRPC adapter', async () => {
    const request = post('invitations.accept', { '0': { json: { token: 'body-token' } } });
    await anonymousToken(request);
    // The handler clones the request; consuming the clone must not consume this.
    await expect(request.json()).resolves.toEqual({ '0': { json: { token: 'body-token' } } });
  });

  it('returns null rather than throwing on an unparseable input', async () => {
    await expect(anonymousToken(get('invitations.get', '?input=not-json'))).resolves.toBeNull();
    await expect(
      anonymousToken(
        new Request(url('invitations.accept', '?batch=1'), { method: 'POST', body: 'not-json' })
      )
    ).resolves.toBeNull();
  });
});
