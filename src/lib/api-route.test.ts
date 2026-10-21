import { describe, expect, it, vi } from 'vitest';
import { withApiRoute } from './api-route';
import { PasswordChangeRequiredError } from './auth/session-state';

describe('withApiRoute', () => {
  it('maps a password policy error before the route fallback', async () => {
    const fallback = vi.fn();
    const route = withApiRoute(async () => {
      throw new PasswordChangeRequiredError();
    }, fallback);
    expect((await route()).status).toBe(403);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('passes other errors unchanged to the existing handler and preserves its response', async () => {
    const failure = new Error('storage unavailable');
    const response = new Response('Unavailable', { status: 503 });
    const fallback = vi.fn(() => response);
    const route = withApiRoute(async () => {
      throw failure;
    }, fallback);
    expect(await route()).toBe(response);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('preserves successful responses and route arguments', async () => {
    const response = new Response('ok');
    const handler = vi.fn(async (_request: Request, _context: { id: string }) => response);
    const request = new Request('http://acme.localhost/api/example');
    const context = { id: 'file' };
    expect(await withApiRoute(handler)(request, context)).toBe(response);
    expect(handler).toHaveBeenCalledExactlyOnceWith(request, context);
  });
});
