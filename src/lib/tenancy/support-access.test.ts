import { describe, expect, it } from 'vitest';
import type { Session } from 'next-auth';
import type { SupportIdentity } from './support-session';
import { supportAccessDenial, supportRequestAllowed } from './support-access';

const session = (expires: string, isSupportSession = true) =>
  ({ expires, user: { isSupportSession } }) as Session;
const live = () => new Date(Date.now() + 60_000).toISOString();

describe('support authority cannot outlive its session or gain writes', () => {
  it.each(['mutation', 'subscription'] as const)(
    'denies %s even for a live support session',
    (type) => {
      expect(supportAccessDenial({ session: session(live()), support: null }, type)).toBe(
        'Support sessions have read-only access.'
      );
    }
  );
  it.each(['', 'later', new Date(0).toISOString()])(
    'fails closed on expiry %j, including reads',
    (expires) => {
      expect(supportAccessDenial({ session: session(expires), support: null }, 'query')).toBe(
        'Support access has ended. Open a new support session.'
      );
    }
  );
  it('uses the earlier of the identity and session expiry', () => {
    const support = { expiresAt: new Date(0) } as SupportIdentity;
    expect(supportAccessDenial({ session: session(live(), false), support }, 'query')).toBeTruthy();
    support.expiresAt = new Date(live());
    expect(
      supportAccessDenial({ session: session(new Date(0).toISOString(), false), support }, 'query')
    ).toBeTruthy();
  });
  it('does not alter normal tenant session policy', () => {
    expect(
      supportAccessDenial({ session: session('later', false), support: null }, 'mutation')
    ).toBeNull();
    expect(supportAccessDenial({ session: null, support: null }, 'mutation')).toBeNull();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('denies arbitrary HTTP %s adapters', (method) => {
    expect(
      supportRequestAllowed(
        new Request('http://tenant.localhost/api/future-admin-route', { method })
      )
    ).toBe(false);
  });
  it('allows HTTP reads and POST tRPC queries but denies standalone realtime credentials', () => {
    expect(supportRequestAllowed(new Request('http://tenant.localhost/api/files/document'))).toBe(
      true
    );
    expect(
      supportRequestAllowed(
        new Request('http://tenant.localhost/api/trpc/organizationAdmin.overview', {
          method: 'POST',
        })
      )
    ).toBe(true);
    expect(supportRequestAllowed(new Request('http://tenant.localhost/api/ably-token/'))).toBe(
      false
    );
  });
});
