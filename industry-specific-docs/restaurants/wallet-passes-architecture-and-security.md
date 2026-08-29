# DevFathom Restaurant Wallet Passes — Architecture and Security Specification

| Field                         | Value                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Document version              | `1.1`                                                                                                                                          |
| Document status               | `ACCEPTED — PROVISIONAL (board delivery-acceptance 2026-08-28, WHA-267; no independent review; defects are raised as WHA-267 comments, not worked around silently)` |
| Spec level                    | `L3 — full specification with testable contracts`                                                                                              |
| Industry                      | Restaurants, cafes, cloud kitchens, and food-service operators                                                                                 |
| Product                       | DevFathom Commercial — restaurant vertical, loyalty module                                                                                     |
| Parent context                | WHA-242 M9 feature integration; restaurant plan v1.3; BUILD-ASSUMPTIONS D-register                                                             |
| Exact base                    | Repository commit `8a46543565ed` ("test(integration): restore M9 union grants"); every fact in §3 was verified against this snapshot            |
| Baseline suite                | 8 failed / 2139 passed / 159 skipped at the exact base                                                                                         |
| Last updated                  | 2026-08-28                                                                                                                                     |
| Authority                     | Governs wallet-pass architecture, identity, security, and contracts until an accepted ADR explicitly supersedes it (plan §1.1 precedence rules) |

## 1. Purpose and scope

One sentence: give restaurant customers an Apple Wallet / Google Wallet loyalty pass, issued and updated by **DevFathom as the sole platform issuer**, that a terminal can scan to identify the customer and their loyalty account **without exposing any PII**, and that a customer can obtain by scanning a **public enrollment QR** at a branch.

Business outcome: loyalty programs (M8) become usable at physical speed — customers stop reciting phone numbers at the counter, enrollment becomes self-service at the table, and the pass in the customer's wallet displays a live points balance, which is the retention surface the loyalty module currently lacks.

In scope: identity alias design, the two barcode contracts, pass issuance for both platforms, the Apple pass web service, the Google JWT save link, public branch enrollment with rate limits, ledger-driven balance updates plus reconciliation, entitlement gating, the POS offline decision, secret handling, migration/rollback strategy, threat model, rejected alternatives, acceptance criteria, and the implementation dependency DAG.

Out of scope (explicitly): coupons/offers passes, gift cards, NFC/VAS contactless protocols, per-tenant issuer accounts, native mobile apps, SMS-based enrollment (deferred, §9.8), physical printed cards, and any agency-vertical use.

This document specifies; it does not implement. No source, schema, migration, test, or credential is created by this revision.

## 2. Product decision summary

1. **DevFathom is the sole issuer on both platforms.** One Apple Developer team + one `passTypeIdentifier`, one Google Wallet issuer account. Tenants never hold or see issuer credentials. Tenant branding is carried in pass content (logo, colors, program name), not in issuer identity.
2. **The pass identifies a customer through a new opaque, tenant-scoped `CustomerIdentifier` kind (`WALLET`)** whose value is a random 128-bit alias. The alias is the only identifying content in the pass barcode. Raw primary keys, emails, and phone numbers never appear in any pass field or barcode.
3. **Two distinct barcodes exist and are never interchangeable**: the *enrollment QR* (a public URL printed at the branch) and the *pass barcode* (the alias envelope inside the wallet pass). Scanning one where the other is expected fails closed (§5.3).
4. **The terminal scan result is zero-PII**: ids, flags, and numeric balance only — strictly narrower than the existing customer search result, which returns `displayName` and masked identifiers.
5. **Pass balances are ledger-driven**: every loyalty ledger append enqueues a pass update in the same transaction; a reconciliation sweep repairs drift. The ledger remains the sole source of truth (`balance = SUM(points)`, unchanged).
6. **Entitlement depth**: wallet passes require the `restaurant-loyalty` module, which the catalog includes only in the `restaurant-operations` and `restaurant-enterprise` packages. No new depth ordinal is introduced (§12).
7. **Wallet operations are connected-only at the POS.** The offline queue's operation classifier is unchanged (§13).

## 3. Current-state grounding (verified at `8a46543565ed`)

Every design element below builds on these verified facts; implementers must re-verify at their own base.

| # | Fact | Evidence |
|---|------|----------|
| G1 | `CustomerIdentifier` is tenant-scoped with `@@unique([organizationId, kind, normalizedValue])`; `enum CustomerIdentifierKind { EMAIL, PHONE }` | `prisma/schema.prisma` (`restaurant_customer_identifiers`, enum at ~5703) |
| G2 | Loyalty ledger `LoyaltyPointsEntry` is append-only, `@@unique([organizationId, idempotencyKey])`, balance is always `SUM(points)` | `src/lib/restaurant/loyalty.ts:129` (`loyaltyBalance`); schema `restaurant_loyalty_points_entries` |
| G3 | Ledger write paths are exactly: earn at order close (`orders.ts:1123`), redeem (`loyalty.ts`), reversal on refund (`refunds.ts:231`), release on comp/void-recut (`bills.ts:717,872`), expiry (`loyalty-expiry.ts`), adjustment | call-site audit |
| G4 | Terminal auth is device secret (`rdk_…` → `deviceSecretHash`) + session token (`rts_…` → `tokenHash`), org resolved platform-scope then all work under `withTenantDb` (RLS); revalidated every request | `src/lib/restaurant/terminal-auth.ts` |
| G5 | The terminal loyalty snapshot is already PII-free (ids + numbers only); the customer *search* endpoint returns `displayName` and masked identifiers | `src/lib/restaurant/terminal-loyalty.ts`; `src/app/api/restaurant/orders/customer/search/route.ts` |
| G6 | There is **no** terminal endpoint that resolves a customer from a scanned credential — only free-text search and bill-scoped snapshot | route inventory under `src/app/api/restaurant/` |
| G7 | Package depth exists only as module bundles: `restaurant-essentials` excludes `restaurant-loyalty`; `restaurant-operations` and `restaurant-enterprise` include it. There is no depth ordinal or `depth >= X` helper; the gate primitive is `hasModule(entitlements, moduleKey)` | `src/lib/vertical-catalog.ts`; `src/lib/entitlements.ts` |
| G8 | Rate limiting is an in-process fixed-window `rateLimit(key, limit, windowMs)`; anonymous flows use `admitAnonymousRequest` with token/IP/global tiers (20 per 10 min / 60 per 10 min / 600 per min); terminal uses IP 120 per min + device 240 per min | `src/lib/rate-limit.ts`; `src/lib/auth/anonymous-rate-limit.ts` |
| G9 | Secrets: AES-256-GCM envelope `v1.<iv>.<tag>.<ct>` via `encryptSecret`/`decryptSecret` keyed by `PLATFORM_ENCRYPTION_KEY`; sensitive `PlatformSetting` rows store `{ encrypted: … }` and audit `'[REDACTED]'` | `src/lib/secret-crypto.ts`; `src/lib/platform/commands.ts:2386` |
| G10 | Host routing: `RESERVED_HOST_LABELS` frozen list; edge `proxy.ts` `publicPaths` allowlist; **no public unauthenticated tenant surface exists today** | `src/lib/tenancy/host-routing.ts`; `src/proxy.ts` |
| G11 | POS offline queue accepts only `OPEN_ORDER | ADD_ITEM | FIRE`; "customer/loyalty … are connected-only and never enter this queue" (module header, verbatim); IndexedDB store has a forbidden-persist-key guard (`assertPersistSafe`) | `src/lib/restaurant/pos-command-queue.ts`; `src/lib/restaurant/pos-client-store.ts` |
| G12 | `RestaurantBranch` has no slug; branch is transport-derived from the bound device, never a URL segment | schema ~2234; `src/app/api/restaurant/orders/open/route.ts` comment |
| G13 | Platform background work runs through `POST /api/platform/jobs/process` guarded by Bearer `CRON_SECRET` with constant-time compare | `src/app/api/platform/jobs/process/route.ts` |
| G14 | Idempotency patterns: device-scoped key tables (`@@unique([deviceId, key])`) for orders/money; org-scoped inline `idempotencyKey` columns for append-only rows; loyalty namespaces client keys (`loyalty:redeem:${key}` etc.) | schema; `src/lib/restaurant/loyalty.ts` |
| G15 | A new ABAC action requires two files: `ALL_ACTIONS`/`POLICIES` in `src/lib/abac/policies.ts` and `RESTAURANT_CAPABILITIES` in `src/lib/vertical-catalog.ts` | explorer audit of both files |

## 4. Identity: the opaque wallet alias

### 4.1 Alias definition

- A wallet alias is a `CustomerIdentifier` row with a new enum value `WALLET` added to `CustomerIdentifierKind`.
- `normalizedValue` holds the alias string: `wla_` followed by 26 Crockford-base32 characters encoding 128 bits from a CSPRNG (`crypto.randomBytes(16)`). Example shape: `wla_3g7v9k2m5q8r1t4w6y0zb3d5f7`.
- Tenant scoping and uniqueness come for free from the existing `@@unique([organizationId, kind, normalizedValue])`. The same alias value in two organizations is two unrelated rows; cross-tenant resolution is structurally impossible under RLS.
- `verifiedAt` is set at issuance time (the alias is platform-minted, not user-asserted).
- One **active** alias per customer per organization. Re-issue (lost phone, suspected leak) mints a new alias and revokes the prior pass (§7.6, §8.5); the old `CustomerIdentifier` row is deleted in the same transaction so the unique slot reflects only the live alias.

### 4.2 Properties (testable)

- A1 — entropy: 128 bits from CSPRNG; no timestamp, sequence, hash-of-PII, or PK-derived component.
- A2 — format: `^wla_[0-9a-hjkmnp-tv-z]{26}$` (Crockford alphabet, lowercase, no `i l o u`).
- A3 — the alias never appears in logs, audit payloads, or error messages; log sites carry a fingerprint only (first 8 hex chars of `sha256(alias)`), mirroring `tokenFingerprint` in `anonymous-rate-limit.ts`.
- A4 — the alias is not a bearer credential for anything except *identification at an authenticated terminal* (§10). It cannot authenticate an HTTP request, cannot redeem points by itself, and resolves only under an established terminal session with the required capability.

## 5. The two barcodes

### 5.1 Enrollment QR (public, printed)

- Content: a URL — `https://<tenant-host>/wallet/join/<enrollmentToken>` where `enrollmentToken` is an opaque per-branch token `wel_` + 26 Crockford-base32 chars (128-bit CSPRNG), stored hashed (`sha256`) on the branch enrollment link row (§6, `WalletEnrollmentLink`).
- Branch addressing deliberately does **not** use `branchId` (G12: branches have no slug and cuids are PKs — printing them violates the no-raw-PK rule and makes links non-revocable). The token is revocable and re-printable per branch from the loyalty console.
- The tenant host in the URL resolves the organization via the existing `resolveOrganizationByHost` path (G10); the token resolves the branch inside that organization. A token presented on the wrong tenant host fails closed with the generic enrollment message.
- Printed at the branch (table tents, receipt footer). It is public by design; possession grants only the ability to *start* enrollment, which is rate-limited and identity-verified (§9).

### 5.2 Pass barcode (inside the wallet pass)

- Format: QR (`PKBarcodeFormatQR` on Apple; `QR_CODE` on Google), message `DFW1:<alias>` — a versioned envelope whose only payload is the alias. `altText` shows the last 4 alias characters for manual keying fallback.
- The barcode is static for the life of the alias (Apple passes are static documents between pushes; a per-scan rotating code is rejected in §17-R7).
- Contains no URL, no PII, no org/branch/customer id, no JWT.

### 5.3 Mutual exclusion (testable)

- The terminal scan endpoint (§10) accepts only `DFW1:`-enveloped payloads matching A2 after the prefix; an enrollment URL scanned at the terminal returns the generic `NOT_FOUND` shape, indistinguishable from an unknown alias.
- The public enrollment page never accepts an alias; a `DFW1:` payload pasted into the join flow is a validation error before any lookup.
- Version prefixes (`DFW1`, future `DFW2`) let barcode semantics evolve without re-issuing all passes at once.

## 6. Data model (specification — implemented by lane L1, not by this document)

All new tables are org-scoped with the standard RLS pattern: `organizationId` defaulting to `current_setting('app.current_organization_id', true)`, `FORCE ROW LEVEL SECURITY`, org-scoped policies matching the existing restaurant tables, and `@@unique([organizationId, id])` composite where FK pairing is needed. Column-level notes below are contracts; exact Prisma syntax is the implementer's.

**`CustomerIdentifierKind`** — add value `WALLET` (enum extension; rollback implications in §16).

**`WalletPass`** (`restaurant_wallet_passes`) — one row per issued pass instance.
- `id`, `organizationId`, `customerId` (FK → `RestaurantCustomer`), `loyaltyAccountId` (FK → `LoyaltyAccount`), `platform` (`enum WalletPassPlatform { APPLE, GOOGLE }`), `serialNumber` (opaque, `wps_` + 26 Crockford chars, globally unique — Apple requires serial uniqueness within a pass type; global uniqueness also lets the Apple web service resolve the organization platform-scope, mirroring the device-secret pattern G4), `status` (`enum WalletPassStatus { ACTIVE, REVOKED }`), `appleAuthTokenHash` (`sha256` hex; null for Google), `lastPushedBalance Int?`, `lastPushedAt DateTime?`, `contentRevision Int @default(1)`, `issuedAt`, `revokedAt?`, `createdAt`, `updatedAt`.
- Uniques: `serialNumber` global; `@@unique([organizationId, customerId, platform])` where `status = ACTIVE` is enforced in code + partial index in SQL (one live pass per customer per platform).
- PII rule: this table stores **no** PII — ids, hashes, counters, timestamps only.

**`WalletPassRegistration`** (`restaurant_wallet_pass_registrations`) — Apple device registrations (Google needs none; Google hosts the object).
- `id`, `organizationId`, `passId` (FK → `WalletPass`), `deviceLibraryIdentifier`, `pushToken`, `createdAt`, `updatedAt`; `@@unique([passId, deviceLibraryIdentifier])`.
- `pushToken` is an APNs routing handle, not a secret; stored plaintext like `WebhookSubscription.secret` precedent but with no signing role.

**`WalletPassUpdate`** (`restaurant_wallet_pass_updates`) — the transactional outbox (§11).
- `id`, `organizationId`, `passId`, `reason` (`enum WalletPassUpdateReason { LEDGER, PROGRAM, REVOKE, RECONCILE }`), `status` (`enum WalletPassUpdateStatus { PENDING, SENT, FAILED }`), `attempts Int @default(0)`, `nextAttemptAt`, `lastError String?`, `createdAt`, `updatedAt`.
- Coalescing: at most one `PENDING` row per pass (`@@unique([passId])` partial on `status = PENDING` in SQL; code upserts).

**`WalletEnrollmentLink`** (`restaurant_wallet_enrollment_links`) — the public QR behind §5.1.
- `id`, `organizationId`, `branchId` (FK → `RestaurantBranch`), `tokenHash` (`sha256` hex, globally unique — resolved pre-auth platform-scope by hash, never by token value), `active Boolean @default(true)`, `createdAt`, `revokedAt?`.
- One active link per branch (code-enforced + partial unique). Revoke-and-reissue invalidates printed material.

**`WalletEnrollmentAttempt`** (`restaurant_wallet_enrollment_attempts`) — short-lived OTP state for §9.
- `id`, `organizationId`, `branchId`, `identifierKind` (`EMAIL` only at v1), `normalizedValue`, `otpHash` (`sha256` of 6-digit code + per-attempt salt), `expiresAt` (10 min), `consumedAt?`, `failedAttempts Int @default(0)`, `createdAt`.
- This is the only wallet table containing PII (the email being verified); rows are deleted on consumption and swept after expiry (§11.4). It is never read by any terminal or pass endpoint.

**`WalletTenantConfig`** (`restaurant_wallet_tenant_config`) — per-org pass presentation + Google class linkage.
- `id`, `organizationId @unique`, `programDisplayName`, `logoFileId?`, `backgroundColor?`, `foregroundColor?`, `googleClassSuffix` (opaque `wgc_` + 26 chars, minted at first issuance; the Google classId is `<issuerId>.<googleClassSuffix>` so no tenant PK reaches Google), `createdAt`, `updatedAt`.

Explicitly rejected at the model level: storing a balance on `WalletPass` as truth (only `lastPushedBalance` as a push watermark), storing alias values anywhere except `CustomerIdentifier.normalizedValue`, and any per-tenant credential column.

## 7. Apple: storeCard pass and web service

### 7.1 Pass structure

- Style: `storeCard`. `passTypeIdentifier`: single platform-owned identifier (e.g. `pass.com.devfathom.loyalty`), Team ID: DevFathom's. Signed with the platform pass-type certificate + WWDR intermediate (§14).
- `serialNumber`: the pass row's `serialNumber` (§6). `authenticationToken`: `wpa_` + 26 Crockford chars (128-bit CSPRNG), ≥16 chars as Apple requires; delivered inside the `.pkpass` only; stored as `appleAuthTokenHash`.
- `webServiceURL`: `https://wallet.<PLATFORM_BASE_DOMAIN>/api/wallet/apple` — a **platform** host, not a tenant host: passes outlive tenant host reconfiguration, and the callback carries no tenant context until the serial resolves one. `wallet` is added to `RESERVED_HOST_LABELS` and `SHARED_HOST_LABELS` handling in `host-routing.ts`, and the pass web-service paths join `proxy.ts` routing (lane L2).
- Fields: program display name, points balance (primary field), tenant logo/colors from `WalletTenantConfig`. **Forbidden in any pass field: customer name, email, phone, customerId, organizationId, branchId.** The pass is intentionally impersonal — it identifies via the alias only.
- Barcode: §5.2.

### 7.2 Web service contract (Apple-fixed paths, DevFathom semantics)

Base: `…/api/wallet/apple/v1`. All endpoints resolve the pass **platform-scope by `serialNumber`**, verify `Authorization: ApplePass <token>` by comparing `sha256(token)` to `appleAuthTokenHash` with a constant-time compare, then enter `withTenantDb(organizationId)` for all tenant reads — the same two-phase shape as terminal auth (G4).

| Endpoint | Semantics |
|---|---|
| `POST /devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}/{serialNumber}` | Auth as above; upsert `WalletPassRegistration`; 201 new / 200 existing |
| `DELETE /devices/{dlid}/registrations/{ptid}/{serialNumber}` | Auth; delete registration; 200 |
| `GET /devices/{dlid}/registrations/{ptid}?passesUpdatedSince=<tag>` | **No auth token on this Apple call**: returns serials for this device's registrations with `contentRevision` newer than the tag; response contains serials only (already-known to the device) |
| `GET /passes/{ptid}/{serialNumber}` | Auth; rebuild and return the current `.pkpass` (balance read live via `loyaltyBalance`); supports `If-Modified-Since`/304 |
| `POST /log` | Accept and platform-log (no tenant data); always 200 |

Failure semantics (testable): unknown serial and bad token are byte-identical `401` responses with empty bodies — no existence oracle, no org leak. Revoked passes return `401` on `GET /passes` (Apple then stops updating; the pass visually persists until removed, which is acceptable — the alias is already dead, §8.5).

### 7.3 Push pipeline

- APNs token-based auth (`.p8` signing key, key ID, team ID — platform secrets, §14). Topic = `passTypeIdentifier`. Payload = empty (Apple contract: push is only a "fetch me" signal).
- Trigger: outbox worker (§11.2) sends one push per registration of the target pass; the device then calls `GET /passes/…` which reads the live ledger balance. This means **the push carries no data** — a lost push is repaired by reconciliation, and a compromised APNs channel reveals nothing.
- `contentRevision` increments whenever pushed content would change (balance watermark change, program rename, revocation); it backs `passesUpdatedSince`.

### 7.4 `.pkpass` build

- Server-side signing (manifest of SHA-1 file digests, PKCS#7 detached signature) inside lane L2's `src/lib/restaurant/wallet/apple-pass.ts`; no third-party pass SaaS (§17-R2). The certificate/key never leave the secret store at rest (§14).

### 7.5 Distribution

- Enrollment completion (§9) returns a one-time download URL for the `.pkpass` (`Content-Type: application/vnd.apple.pkpass`), valid 15 minutes, single use, bound to the enrollment attempt — not a durable authenticated surface.

### 7.6 Revocation

- Re-issue or admin revoke sets `status = REVOKED`, deletes the alias row, enqueues a `REVOKE` update; subsequent web-service fetches 401 and registrations are dropped on next contact.

## 8. Google: Wallet API and JWT save link

### 8.1 Issuer and class model

- One platform issuer account. Per organization, one `LoyaltyClass` with id `<issuerId>.<googleClassSuffix>` (§6 — opaque suffix, no tenant PK crosses the boundary). Class carries program name, logo, colors from `WalletTenantConfig`; created lazily at first Google issuance via the Wallet REST API.

### 8.2 Object model

- Per pass, one `LoyaltyObject` with id `<issuerId>.<serialNumber>` (opaque serial, satisfying the no-raw-PK rule at the Google boundary too). Fields: `loyaltyPoints.balance` (int), `barcode` = §5.2, `accountId`/`accountName` **omitted** (they render PII on the pass face; we issue impersonal passes — same rule as Apple §7.1).

### 8.3 Save link (the "Google JWT link")

- The enrollment completion screen renders an "Add to Google Wallet" button whose href is `https://pay.google.com/gp/v/save/<jwt>`.
- JWT: RS256, signed by the platform service-account private key (§14). Claims: `iss` = service-account email, `aud: "google"`, `typ: "savetowallet"`, `iat`, and `payload.loyaltyObjects` = the full object (create-on-save). TTL enforced by us: the signed link is minted at enrollment completion and the containing page expires with the enrollment attempt (15 min); the JWT embeds `iat` and we mint per-request, never cache signed JWTs.
- The JWT contains the object (serial, class ref, balance, barcode alias envelope) and **no PII** — testable claim allowlist in §18/AC9.

### 8.4 Updates

- Outbox worker PATCHes the `LoyaltyObject` balance via the Wallet REST API using short-lived OAuth2 access tokens derived from the service account. `lastPushedBalance`/`lastPushedAt` watermark the successful write.

### 8.5 Revocation

- Re-issue/revoke PATCHes `state: EXPIRED` on the object and proceeds as §7.6. A revoked object's barcode still renders in the user's app, but the alias row is gone, so terminal resolution returns the generic `NOT_FOUND` (fail closed at the only place the alias has meaning).

## 9. Public branch enrollment

### 9.1 Surface

- New public route group `src/app/(public)/wallet/join/[token]/page.tsx` plus REST endpoints under `src/app/api/wallet/enroll/*`. `'/wallet'` joins `proxy.ts` `publicPaths` (G10 — this is the platform's first public tenant surface; the proxy change is a named lane deliverable, not a side effect).
- Served on tenant hosts only; on platform/shared hosts the route 404s.

### 9.2 Flow (email-first, v1)

1. `GET /wallet/join/<token>` — resolve `sha256(token)` → `WalletEnrollmentLink` (active) → org + branch. Render program name + email form. Invalid/revoked token: generic "this link is no longer active" (no existence oracle).
2. `POST /api/wallet/enroll/start` `{ token, email }` — validate + normalize email (`normalizeCustomerIdentifier`), create `WalletEnrollmentAttempt`, send 6-digit OTP via the existing email provider (Resend/Brevo). **Always** respond `202` with the same body whether or not the email maps to an existing customer (no membership oracle; mirrors `RESET_GENERIC_MESSAGE` discipline).
3. `POST /api/wallet/enroll/verify` `{ token, attemptId, otp }` — constant-time OTP compare; ≥5 failures voids the attempt. On success, in one transaction: find-or-create `RestaurantCustomer` + `EMAIL` identifier (`verifiedAt` stamped — the OTP *is* verification), enroll `LoyaltyAccount` if absent via `enrollLoyaltyAccount` (existing `ACTIVE_CUSTOMER_LIMIT_REACHED` entitlement limit applies unchanged), mint alias (§4), create `WalletPass` row(s), append `CustomerInteraction` (kind: wallet enrollment, branch-attributed — G14 idempotency) and `CustomerConsent` (channel `EMAIL`, granted, source: wallet enrollment), delete the attempt row.
4. Completion screen offers both: Apple `.pkpass` one-time URL (§7.5) + Google save link (§8.3). Choosing both platforms yields two pass rows sharing the customer's single alias.

### 9.3 Anonymous execution context

- Steps 1–3 run unauthenticated. Org resolution is by tenant host + token hash (platform scope), then all tenant writes run under `withTenantDb(organizationId)` exactly like terminal routes (G4). No session, no cookie, no CSRF surface beyond strict same-origin POSTs with strict zod bodies.

### 9.4 Rate limits (concrete, testable)

Reusing `rateLimit()` (G8), keys namespaced `wallet-enroll:`:

| Key | Limit / window | Guards against |
|---|---|---|
| `wallet-enroll:ip:<ip>` | 30 / 10 min | broad scripted abuse (matches anonymous-flow order of magnitude) |
| `wallet-enroll:token:<fingerprint>` | 300 / 10 min | one branch's printed QR being farmed |
| `wallet-enroll:email:<sha256(email)>` | 5 / 15 min | OTP spam to one inbox (matches `pwreset:email:`) |
| `wallet-enroll:global` | 600 / 60 s | platform-wide flood (matches `GLOBAL_LIMIT`) |
| `wallet-otp:attempt:<attemptId>` | 5 lifetime | OTP brute force (also enforced by `failedAttempts`) |

Exceeded limits return `429` with `Retry-After`, identical body across causes. The in-process store's per-instance nature (G8) is accepted at v1 with the same caveat the codebase already carries; the swap-to-shared-store note applies platform-wide, not to this feature alone.

### 9.5 Apple/Google callback rate limits

- Apple web service: `wallet-apple:ip:` 120/60s + `wallet-apple:serial:<fingerprint>` 60/60s. Google callbacks: none inbound (we call Google, not vice versa).

### 9.6 Terminal scan rate limit

- Covered by existing terminal IP/device limits (G8); no new tier.

### 9.7 Enrollment from the loyalty console (staff-assisted)

- The existing loyalty console (authenticated, `customers:read`/`restaurant:configure`) gains "issue wallet pass" for an existing customer — same issuance core, no OTP (staff vouches; the customer's email was verified at customer creation or is not required). This is lane L7 UI over lane L1/L2/L3 primitives.

### 9.8 Deferred: phone/SMS enrollment

- No SMS provider exists in the stack (env audit G-secrets). Phone-kind enrollment is deferred; a `D-register` entry (BUILD-ASSUMPTIONS format) records: *deferred SMS OTP · conservative because no provider + spam-cost risk · revisited when an SMS provider lands for any module*.

## 10. Terminal scan contract (zero-PII)

### 10.1 Endpoint

- `GET /api/restaurant/orders/customer/by-wallet?code=<scanned>` — built with the existing `connectedReadRoute` factory, capability `customers:read`, standard terminal auth + entitlement gates (G4), plus `hasModule('restaurant-loyalty')` (§12).
- Input: strict zod — `code` must match `^DFW1:wla_[0-9a-hjkmnp-tv-z]{26}$`; anything else (including enrollment URLs, §5.3) is a `400` before any lookup.
- Resolution: alias → `CustomerIdentifier(kind: WALLET)` under the terminal's tenant scope → customer (excluding `anonymizedAt != null`) → loyalty account + `loyaltyBalance`.

### 10.2 Response (the zero-PII result — exact and exhaustive)

```ts
type WalletScanResult = {
  customerId: string
  loyalty: {
    accountId: string | null
    accountActive: boolean
    balance: number          // SUM(points), read live
  }
}
```

- **Forbidden by contract test (AC4): any other key.** No `displayName`, no masked identifiers, no name fields — strictly narrower than `TerminalCustomerMatch` (G5). The operator sees "customer identified · ★ 240 points", not who the customer is. If the operator needs the name (order pickup), that is a different, deliberate action through the existing search flow with its own capability trail.
- Unknown alias, revoked pass alias, anonymized customer, wrong tenant: identical `404` generic shape — the scanner cannot distinguish "no such alias" from "not your tenant's alias".
- The result feeds the existing attach flow (`POST /orders/customer/attach`) and loyalty snapshot/redeem endpoints unchanged — scan-to-identify composes with, and does not replace, the M8/M9 money paths.

## 11. Ledger-driven updates and reconciliation

### 11.1 Outbox enqueue (same-transaction)

- Every ledger append path (G3: earn, redeem, reversal, release, expiry, adjustment) gains one call: upsert the pass's `PENDING` `WalletPassUpdate` (reason `LEDGER`) **inside the ledger transaction**. No pass ⇒ no-op. This is the transactional-outbox pattern: the ledger commit and the update intent are atomic; delivery is asynchronous.
- Program presentation changes (`WalletTenantConfig`) and revocations enqueue with reasons `PROGRAM`/`REVOKE`.

### 11.2 Delivery worker

- Runs inside the existing platform job runner (`/api/platform/jobs/process`, `CRON_SECRET`, G13) — no new daemon. Each tick: claim due `PENDING` rows (bounded batch, `nextAttemptAt <= now`), per row: Apple → APNs push per registration (§7.3); Google → object PATCH (§8.4); success → `SENT` + watermark; failure → `attempts++`, exponential backoff into `nextAttemptAt`, after 8 attempts → `FAILED` (reconciliation re-covers it).
- Idempotent by design: Apple pushes are data-free fetch signals; Google PATCH is last-writer-wins on an absolute balance. Duplicate delivery is harmless — this is why the outbox needs no exactly-once machinery.

### 11.3 Reconciliation sweep

- Daily job (same runner): for every `ACTIVE` pass, compare `loyaltyBalance(accountId)` to `lastPushedBalance`; drifted or `FAILED`-stuck passes get a fresh `RECONCILE` update enqueued. Also: drop Apple registrations that 410'd on push, expire `WalletEnrollmentAttempt` leftovers (§11.4), and emit one platform-log line of counts (repaired / failed / swept) for observability.
- Invariant (AC12): after a reconciliation pass with both provider APIs healthy, no `ACTIVE` pass has `lastPushedBalance ≠ SUM(points)` older than one sweep interval. The ledger is never written by any wallet component — reconciliation repairs *outbound projection*, never "fixes" the ledger.

### 11.4 Data hygiene

- Consumed attempts are deleted transactionally at verify; expired attempts are swept daily. Attempt PII (email) therefore has a bounded lifetime of ≤ 24h + 10min worst case.

## 12. Entitlement gating (Operations-or-Enterprise)

- The verified catalog (G7) has no depth ordinal, and this spec does not add one (§17-R6). "Operations-or-Enterprise depth" is expressed as the module fact it already is: **`restaurant-loyalty` ∈ enabled modules**, which is true exactly for `restaurant-operations` and `restaurant-enterprise` package holders (plus any contract/override grant, which is the platform's existing and intended escape hatch).
- Enforcement points (each testable, AC10): enrollment link management + issuance (console, tRPC `requireLicensedModule` via the loyalty router's existing module mapping), the public enrollment start/verify endpoints (`hasModule` check after org resolution — an Essentials org's printed QR yields the generic "link no longer active"), the terminal `by-wallet` endpoint (§10.1), and the outbox worker (skip + revoke-enqueue for orgs whose loyalty module lapsed; passes go stale-then-revoked rather than leaking service).
- Existing limit `loyalty.activeCustomers.max` continues to bound enrollment through `enrollLoyaltyAccount` (§9.2/3). No new limit key at v1; `loyalty.walletPasses.max` is noted as a future contract lever, not implemented.
- New ABAC action: none. Scan uses `customers:read`; redeem keeps `loyalty:redeem`; console management uses `restaurant:configure`. Avoiding a new action avoids the two-file capability-string drift trap (G15).

## 13. POS offline decision

**Decision: wallet scanning is connected-only. The offline queue is unchanged.**

- The offline classifier (G11) already declares customer/loyalty operations connected-only; the queueable union `OPEN_ORDER | ADD_ITEM | FIRE` does not grow, `pos-command-queue.ts` and `pos-client-store.ts` are untouched, and no wallet data enters IndexedDB. The forbidden-persist-key guard (`assertPersistSafe`) gains `walletAlias`/`wallet` stems to its forbidden list as a belt-and-braces addition — the only offline-core edit, additive and test-covered.
- Rationale: offline scan would require a local alias→customer map on the device — a cached cross-reference of every enrolled customer, exactly the PII-adjacent dataset the terminal is designed never to hold (G5, G11). Loyalty redemption is already connected-only under row locks; identifying a customer offline has no redeemable follow-up anyway. An offline scan shows the operator a clear "requires connection" state (existing `TerminalFailureKind = 'network'` handling).

## 14. Secret-store handling

Platform-issuer credentials (all platform-scope; **no per-tenant issuer credentials anywhere**, matching the issue's hard constraint):

| Secret | Storage | Notes |
|---|---|---|
| Apple pass-type certificate + private key | Sensitive `PlatformSetting` rows via `encryptSecret` (G9), keys `wallet.apple.passCert` / `wallet.apple.passKey` | PEM; decrypted only inside the signing call path; audit shows `'[REDACTED]'` |
| Apple WWDR intermediate | Non-sensitive `PlatformSetting` (public cert) | |
| APNs auth key (`.p8`) + keyId + teamId | Sensitive `PlatformSetting` `wallet.apple.apns*` | token-based APNs; no cert renewal churn |
| Google service-account JSON (incl. private key) | Sensitive `PlatformSetting` `wallet.google.serviceAccount` | signs save-link JWTs (§8.3) and mints OAuth2 tokens (§8.4) |
| Google issuer ID | Non-sensitive `PlatformSetting` | not a secret |

- Per-pass secrets: Apple `authenticationToken` stored **hashed** (§7.1) — same discipline as `deviceSecretHash`. Enrollment link tokens stored **hashed** (§6). OTPs stored **salted-hashed** with 10-min TTL (§6). Nothing bearer-shaped is persisted in recoverable form except the platform credentials above, which must be recoverable to sign.
- Rotation: pass-signing cert rotation is a re-sign-on-next-fetch event (passes re-fetch via §7.2 `GET /passes`; push a `PROGRAM` update wave after rotation). APNs key and Google SA key rotate by writing the new `PlatformSetting` value; both are stateless signers. Alias/link/token rotation is per-row re-issue (§7.6). A rotation runbook entry joins `docs/meetings/013-secrets-and-rotation.md`'s register (doc edit, lane L2/L3).
- Environment: `PLATFORM_ENCRYPTION_KEY` must be configured in any environment issuing passes; `encryptionConfigured()` is the existing guard. No new env vars are introduced for issuer material (settings-store, not env, so ops can rotate without redeploys); `CRON_SECRET` (existing) guards the worker.

## 15. Threat model (condensed)

| # | Threat | Mitigation |
|---|---|---|
| T1 | Alias guessing / enumeration | 128-bit CSPRNG (A1), tenant-scoped resolution only under authenticated terminal session, uniform 404 (§10.2), terminal rate limits |
| T2 | Barcode screenshot replay (alias theft) | Alias identifies, never authenticates (A4); redemption still requires operator capability + bill context; victim remedy = re-issue (§7.6); accepted residual: points could be earned to, or attached as, the victim at a terminal — equivalent to today's "give someone else's phone number" risk, now with re-issue as a kill switch |
| T3 | Enrollment QR farming (mass fake enrollment) | OTP-verified identity (§9.2), per-email/token/IP/global limits (§9.4), `loyalty.activeCustomers.max` cap, revocable per-branch links |
| T4 | Enrollment as membership oracle | Uniform 202 on start, generic failures throughout (§9.2, §9.4) |
| T5 | Apple web service as cross-tenant oracle | Serial+token auth before any tenant work, byte-identical 401s, platform-scope serial lookup then RLS-scoped reads (§7.2) |
| T6 | PII leak via pass content or Google claims | Impersonal passes (§7.1, §8.2), claim/field allowlist tests (AC3, AC9) |
| T7 | Issuer credential theft | AES-256-GCM at rest keyed by `PLATFORM_ENCRYPTION_KEY` (G9), decrypt only in signing paths, `'[REDACTED]'` audit, rotation runbook (§14) |
| T8 | Outbox/worker abuse | `CRON_SECRET` constant-time gate (G13), bounded batches, backoff, entitlement re-check per delivery (§12) |
| T9 | Terminal device compromise | Unchanged terminal trust model (G4); scan result is zero-PII so a hostile device harvests ids and balances only — ids are RLS-meaningless off-tenant |
| T10 | Log/audit PII bleed | Alias fingerprinting (A3), attempt-row TTL (§11.4), no alias in error messages |

## 16. Migrations and rollback

- **One additive migration** (lane L1), standard layout `prisma/migrations/<ts>_restaurant_wallet_passes/migration.sql`: `ALTER TYPE "CustomerIdentifierKind" ADD VALUE 'WALLET'`; `CREATE TABLE` × 6 (§6) with RLS enable + FORCE + org policies matching sibling restaurant tables; partial unique indexes (`WalletPass` active-per-customer-platform, `WalletPassUpdate` pending-per-pass, `WalletEnrollmentLink` active-per-branch).
- Enum caveat: `ADD VALUE` cannot run inside a transaction block with uses in the same migration on older Postgres semantics — the migration orders the `ALTER TYPE` first and does not reference the new value in the same file (no seed rows). Prisma executes migration files as scripts; the implementer must verify the generated SQL honors this ordering (named check in the L1 gate).
- Forward gates (AC13): `migrate-empty→target` and `migrate-<base-tip>→target` both clean; `test:rls` green including the six new tables in the battery allowlist.
- **Rollback**: dropping the six tables is a clean reverse script (data loss = pass/enrollment state only; the loyalty ledger and customers are untouched — passes are a projection and can be re-issued). The enum value `WALLET` **cannot be dropped** from a Postgres enum in place; rollback strategy is: code rollback stops minting `WALLET` rows, a cleanup statement deletes existing `WALLET` identifier rows, and the orphan enum value remains — inert and harmless, documented in the migration's header comment. A full enum rebuild (rename-type dance) is available but explicitly not required for rollback acceptance.
- No RLS policy on any existing table is touched (hard constraint: no weakened RLS). No existing table gains or loses a column at v1.

## 17. Rejected alternatives

| # | Alternative | Rejected because |
|---|---|---|
| R1 | Per-tenant Apple/Google issuer accounts | Forbidden by mandate; also: per-tenant Apple Developer enrollment cost + review latency, credential sprawl across hundreds of orgs, offboarding revocation burden. Sole-issuer with content-level branding is the industry-standard multi-tenant shape |
| R2 | Third-party pass SaaS (PassKit, Walletpasses, etc.) | Sends customer identifiers and balance streams to a subprocessor, adds per-pass pricing, and outsources exactly the security boundary this spec exists to own |
| R3 | Raw `customerId`/`accountId` (or hashed PII) in the barcode | PKs are permanent (no rotation on compromise), enumerable in bulk if any oracle appears, and hashed-PII variants are dictionary-attackable; violates the no-raw-PK mandate |
| R4 | Email/phone in the barcode | PII on a static, screenshot-able artifact; violates zero-PII terminal design |
| R5 | Reusing `EMAIL`/`PHONE` identifier kinds with a synthetic value instead of a `WALLET` kind | Corrupts the semantics of existing normalization, consent, and privacy-export code paths that assume those kinds are contactable PII |
| R6 | Adding a package-depth ordinal (`depth >= OPERATIONS`) to the entitlement system | The catalog's tier semantics are module bundles (G7); an ordinal is a second source of truth that drifts from `moduleKeys` and breaks the existing override/contract escape hatches |
| R7 | Rotating/TOTP-style pass barcodes or Apple VAS / Google Smart Tap NFC | Requires certified contactless readers and merchant-crypto provisioning the POS fleet doesn't have; rotating QR on Apple requires constant pass refreshes (push-per-scan). Static alias + server-side authorization gives equivalent protection for a loyalty (non-payment) credential |
| R8 | Offline alias cache on the terminal for offline scanning | A device-resident directory of all enrolled customers contradicts the offline core's storage-minimization design (G11) and creates a theft target; rejected in §13 |
| R9 | Google "hosted enrollment" via Smart Tap / Google-managed sign-up | Couples enrollment identity to Google accounts, unavailable on Apple side, and bypasses our OTP-verified `CustomerIdentifier` model — two identity systems instead of one |
| R10 | Storing pass balance as a column of truth on `WalletPass` | Second ledger; violates the append-only `SUM(points)` invariant (G2). Only the `lastPushedBalance` watermark is stored |
| R11 | Tenant-host Apple `webServiceURL` | Passes are long-lived; tenant hosts are reconfigurable and lifecycle-gated. A platform `wallet.` host keeps callbacks resolvable for the pass's lifetime |

## 18. Acceptance criteria (all objectively checkable; raw command output required — not-run is not pass)

| AC | Criterion |
|---|---|
| AC1 | Alias format/entropy: unit tests assert A1/A2 (regex, CSPRNG source, 128-bit length); grep-gate: no code path logs a raw alias (A3 fingerprint helper used at every log site) |
| AC2 | Tenant scoping: RLS battery covers all six new tables; cross-org alias resolution returns 0 rows under a foreign `app.current_organization_id`; `test:rls` green |
| AC3 | Apple pass build: snapshot test of `pass.json` asserts the exact field allowlist — presence of program name/balance/barcode `DFW1:` envelope, absence of any of {customer name fields, email, phone, customerId, organizationId, branchId} |
| AC4 | Terminal scan contract: contract test asserts `WalletScanResult` has exactly the keys in §10.2 (deep key enumeration, not shape-compatibility); unknown/revoked/anonymized/foreign aliases all yield the identical 404 body |
| AC5 | Barcode mutual exclusion: enrollment URL scanned at `by-wallet` → 400/404 per §5.3; `DFW1:` payload posted to enroll endpoints → validation error before lookup |
| AC6 | Apple web service: all five endpoints implemented; unknown-serial vs bad-token responses byte-identical 401; `passesUpdatedSince` honors `contentRevision`; registration upsert idempotent |
| AC7 | Enrollment flow: start→verify→issue happy path creates customer, verified EMAIL identifier, consent event, interaction event, loyalty account, alias, pass row(s) in one transaction; OTP failure ×5 voids the attempt; attempt row deleted on success |
| AC8 | Rate limits: each key in §9.4's table has a test driving it to 429 with `Retry-After`, and a uniform-body assertion across limit causes |
| AC9 | Google JWT: decoded save-link JWT claims match an exact allowlist (RS256, `aud: google`, `typ: savetowallet`, object with opaque serial-based id, no PII keys); object PATCH path covered by a mocked-transport test |
| AC10 | Entitlement: Essentials-package org (no `restaurant-loyalty`) gets — console management `FORBIDDEN`, public enrollment generic-inactive, terminal `by-wallet` 403 module-gate, worker skip; Operations and Enterprise orgs pass all four |
| AC11 | Outbox: each of the six ledger write paths (G3) enqueues exactly one coalesced `PENDING` update inside the ledger transaction (tx-rollback test proves atomicity: aborted ledger append leaves no outbox row) |
| AC12 | Reconciliation: seeded drift (`lastPushedBalance ≠ SUM(points)`) and a `FAILED` row are both repaired in one sweep; sweep is idempotent (second run is a no-op); ledger rows are never written by any wallet component (write-path audit) |
| AC13 | Migrations: `migrate empty→target` and `migrate base-tip→target` clean; rollback script drops the six tables clean; enum-ordering check per §16 |
| AC14 | Offline: `pos-command-queue.ts` union unchanged (type-level test), `assertPersistSafe` rejects wallet-stem keys, no wallet module imports IndexedDB store |
| AC15 | Baseline integrity: full suite at the implementation base shows no new failures vs the measured baseline (8F/2139P/159S at `8a46543565ed`, re-measured at the actual implementation base) and 0 new skips; no test deleted, no `.skip` added |
| AC16 | Secrets: at-rest audit shows issuer material only in sensitive `PlatformSetting` envelopes (`v1.` prefix); per-pass tokens/links/OTPs present only as hashes; `scripts/audit-secret-inventory.ts` reports no new plaintext findings |

## 19. Implementation dependency DAG and lanes

Non-overlapping file lanes, one owner each. This DAG is the routing input for the follow-on milestone. Acceptance gate satisfied: the board accepted delivery on 2026-08-28 (provisional, no independent review) — lanes may start, treating this document as the governing contract; a lane that finds a defect raises it as a WHA-267 comment rather than working around it silently.

```
L1 ──┬── L2 ──┬── L6
     ├── L3 ──┤
     ├── L4   │
     ├── L5   │
     └── L7 (after L2+L3 for issuance UI)
                └── L8 (verification rollup, after all)
```

| Lane | Scope (owned files) | Depends on |
|---|---|---|
| L1 | Schema + migration (§6, §16), alias primitive `src/lib/restaurant/wallet/alias.ts`, RLS battery additions, D-register entry (§9.8) | — |
| L2 | Apple: `src/lib/restaurant/wallet/apple-pass.ts` (+signing), web service routes `src/app/api/wallet/apple/**`, APNs client, `host-routing.ts` `wallet` label + `proxy.ts` wiring, secret-setting keys + rotation-doc entry | L1 |
| L3 | Google: `src/lib/restaurant/wallet/google.ts` (class/object/JWT/OAuth2), mocked-transport tests | L1 |
| L4 | Public enrollment: `(public)/wallet/**` pages, `src/app/api/wallet/enroll/**`, OTP + rate limits, `proxy.ts` `publicPaths` `'/wallet'` entry | L1 |
| L5 | Terminal scan: `by-wallet` route + `terminal-customers.ts` additions, zero-PII contract tests | L1 |
| L6 | Outbox + delivery worker + reconciliation job in the platform job runner | L2, L3 |
| L7 | Console UI: enrollment-link management, staff-assisted issuance, pass status/re-issue in the loyalty console (Studio design contract + §12 QA matrix apply) | L2, L3 (and L1) |
| L8 | Verification rollup: full gate matrix, AC1–AC16 with raw output, baseline diff | all |

File-conflict notes for the router: `proxy.ts` is touched by L2 and L4 — sequence them or split the constant into a shared file in L1; `docs/meetings/013-secrets-and-rotation.md` edit lives in L2 only.

## 20. Exclusions, risks, and genuine human decisions

- **Risks accepted**: in-process rate limiting is per-instance (platform-wide caveat, G8); Apple pass visual persistence after revocation (§7.2); T2 residual (screenshot ≈ borrowed phone number, mitigated by re-issue).
- **Risk to watch**: APNs/Google API availability creates `FAILED` backlogs — reconciliation bounds staleness to one sweep interval; alerting on the sweep's counts line is the L6 owner's deliverable.
- **Human decisions required before L2/L3 start (not blocking acceptance of this spec)**: (D1) purchase/registration of the Apple pass-type ID and Google issuer account under DevFathom's legal entity — an ops action producing the §14 secrets; (D2) confirmation of the public `wallet.<PLATFORM_BASE_DOMAIN>` DNS record. Both are environment provisioning, not architecture.
- **Excluded** (restated): offers/coupons, gift cards, NFC, SMS enrollment, per-tenant issuers, physical cards, agency vertical.

## 21. Document lifecycle

Version 1.0 was published for acceptance (WHA-267) and accepted by the board on 2026-08-28 as a provisional delivery-acceptance (no independent review; version 1.1 records that status). The follow-on milestone routes lanes L1–L8 through the Chief of Staff with this document as the governing contract; any deviation requires an accepted ADR linking the affected section (§1.1 precedence of the restaurant plan applies to this document identically). Defects found during implementation are raised as WHA-267 comments, not worked around silently.
