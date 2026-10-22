# GitHub issue #62: already fixed

Issue #62 (WHA-1271), **Platform login must redirect valid sessions server-side**, is
already satisfied by the current code. No runtime code or tests were changed.

## Evidence

- `src/proxy.ts:78-86` handles platform routes on the server. For
  `/platform/login`, it permits a request with no platform-session cookie to render,
  passes a cookie-bearing request to `getPlatformSession(request)`, redirects only a
  verified identity, and uses the fixed destination `/platform`.
- `src/lib/platform/auth.ts:218-277` shows that `getPlatformSession` is not a
  cookie-presence check: it validates token length, looks up the token hash, and
  rejects an unknown, revoked, expired, inactive-user, enrollment-only, or
  MFA-incomplete session.
- `src/app/platform/(auth)/login/page.tsx:12-13` independently performs the same
  server-side verification and fixed redirect while rendering the login page,
  providing defense in depth if the request reaches the page.
- `tests/proxy.test.ts:61-68` verifies that a server-verified platform session is
  redirected from `/platform/login` to `/platform` and that the verifier receives
  the request.
- `tests/proxy.test.ts:70-84` verifies that forged and expired cookie values render
  the login page rather than redirecting, and that both are checked with the
  server-side verifier.
- `src/proxy.ts:133-161` keeps admin-host handling and tenant-session routing in
  separate branches, so the platform-login behavior does not alter tenant-route
  behavior.

## Conclusion

The current implementation meets the requested redirect, validation, fixed-target,
and tenant-isolation behavior. Because the existing focused tests already cover the
valid, forged, and expired cases, this issue requires documentation only.
