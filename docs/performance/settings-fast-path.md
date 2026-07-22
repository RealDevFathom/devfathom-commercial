# Settings fast path

## Outcome

Settings now renders its primary profile, UI preferences, and notification preferences from `GET /api/settings/bootstrap`. The browser-session path decodes the signed session and selects the authenticated member's safe projection in one database query on one connection.

| Measure | Before | After |
| --- | --- | --- |
| Blocking Settings datasets | 7 sequential requests | 1 bootstrap request |
| First Settings shell | Navigation timed out after 10,000 ms | 18–38 ms |
| First primary Settings content | More than 10,000 ms | 1,579–1,803 ms (1,600 ms median) |
| Hydration bootstrap duplicates | Not controlled | 0 |
| Navigation timeout | Exceeded | Never exceeded; maximum measured 1,803 ms |

The before result is the measured baseline supplied for commit `8c8ae5397a817ef0dfb70a9530a1e0061b958d67`. The after result is three production-mode, authenticated desktop navigations against the connected database. Each run started from a settled Dashboard route and measured until the primary Profile card was visible. Every run emitted exactly one browser `GET /api/settings/bootstrap`; the endpoint itself measured 1,296–1,485 ms over three direct authenticated requests.

## Request sequence

Before:

1. Profile
2. Preferences
3. Sessions
4. Two-factor status
5. Resignations
6. API-token metadata
7. Webhook metadata

After:

1. `GET /api/settings/bootstrap`

The shared authenticated shell can still perform its own authorization and notification work. Those requests are not Settings datasets and are unchanged by this route-scoped change.

## Deferred data

The route uses visibility observers to start only the section that the member reaches:

- Security: sessions and two-factor status.
- Employment: the current member's resignation records.
- API tokens: administrator only.
- Webhooks: administrator only.

Each section is cached for 30 seconds in the current browser. The administrator loaders reject non-administrator calls before invoking the request client, so their endpoints are never fetched for another role. Deferred requests use the existing endpoints and therefore retain their existing authorization dependencies.

## Mutation isolation

| Mutation | Local behavior | Refresh scope |
| --- | --- | --- |
| Profile | Merge the returned profile | Profile only |
| UI preference | Update immediately, then persist | None |
| Notification preference | Update immediately, then persist | None |
| Session revoke | Preserve terminal sign-out flow | No unrelated data |
| Two-factor confirm/disable | Persist action | Two-factor status only |
| Resignation submit/withdraw | Persist action | Resignations only |
| API token create/revoke | Show a new secret once when applicable | API tokens only |
| Webhook create/remove | Show a new secret once when applicable | Webhooks only |

## Security evidence

- Bootstrap top-level keys are exactly `profile`, `preferences`, and `notificationPreferences`.
- The profile query is bound only to the signed session subject; the endpoint has no user-id input.
- Active status and token-version revocation checks are performed before serialization.
- UI preference names and values plus notification categories/channels are allowlisted; `_security` and any malformed or credential-shaped stored preference fields are discarded.
- API-token metadata and webhook metadata are absent for both administrator and non-administrator bootstrap responses.
- Runtime audits found no session token and no `tokenHash`, `passwordHash`, `twoFactorSecret`, `sessionToken`, `webhookSecret`, credentials, bearer, or `_security` marker in the bootstrap JSON or SSR HTML.
- A production SSR load made one server bootstrap request and zero client hydration bootstrap requests.

## Visual evidence

- Desktop: `/Users/Saad/.codex/visualizations/2026/07/22/019f891b-6c9f-7423-9ec4-0dd42bf1aaff/settings-desktop-1440x900.png`
- Mobile: `/Users/Saad/.codex/visualizations/2026/07/22/019f891b-6c9f-7423-9ec4-0dd42bf1aaff/settings-mobile-390x844.png`
