# Pharmacy loyalty: Apple and Google Wallet passes (DEV-747)

Status: **test passes only**. Live passes need a separate approval (see "Before live passes").

## What a wallet pass is

A wallet pass is the customer's loyalty card in another form. It is not a new account and not a
second balance.

- **Same card.** When an owner or branch manager issues or replaces a card on
  `/pharmacy/loyalty`, the panel offers the printed card and, with it, an Apple Wallet and a
  Google Wallet test pass. All three carry the same opaque card code in their QR
  (`src/lib/pharmacy/loyalty-card-code.ts`), so the counter scan links the same customer at any
  branch of the organization.
- **Same balance.** Points belong to the customer, across every branch
  (`customerPointsBalance`). The ledger is the only source of truth. The pass shows the balance
  as of issue, and the point value the owner set (1 point = PKR 1 unless changed).
- **Same revocation.** Replacing or revoking the card stops the printed card and both passes at
  once, because they share the code. A lost phone is handled as a lost card: replace it. Points
  are unaffected.
- **Shown once.** The card code is never stored, only its hash. The passes are built in the
  issuing transaction and handed to staff once, like the code itself.

## Privacy

A pass carries only the card code, the points balance and the point value. It never carries the
customer's name, phone, purchases, medicines, prescriptions or any health data, and no internal
id: the serial number is random. Google's `accountName` and `accountId` are never set, because
Google renders them on the pass face. `src/lib/pharmacy/loyalty-wallet-pass.test.ts` holds both
passes to an exact field allowlist.

## Test mode

`src/lib/pharmacy/loyalty-wallet-pass.ts` builds:

- an Apple `pass.json` for a store card, with no signature, manifest, web service URL or
  authentication token;
- a Google Wallet `LoyaltyObject`, never signed into a save JWT and never sent to Google.

Both use placeholder issuer identifiers (`pass.test.devfathom.pharmacy-loyalty`,
`test-issuer`), say "TEST" on their face, and need no credential. A phone Wallet will not accept
them. Staff can download each as JSON to check the content; the QR on screen and in the pass
content works at the counter today.

## Khata earning

Unchanged by this work and already in place (DEV-746, DEV-764): when the owner's "Khata
purchases earn points once the customer pays them off" switch is on, points are earned on the
money collected, including each partial repayment (`src/lib/pharmacy/loyalty-khata-earn.ts`).
Off means khata purchases earn nothing. A wallet pass shows whatever the ledger holds.

## Before live passes

Each item needs its own approval. None is done by this change.

1. **Eligibility.** Confirm in writing that Apple Wallet pass issuance and the Google Wallet API
   are available to an issuer operating in Pakistan, for loyalty passes. Do not assume it.
2. **Issuer accounts and agreements.** Company-owned Apple Developer Program membership (Pass
   Type ID, pass certificate, WWDR certificate, APNs key) and Google Wallet issuer account
   (issuer id, service account), with their terms accepted by the company.
3. **Secure credentials.** Stored only as encrypted platform settings, the same way the
   restaurant wallet stores them (`src/lib/restaurant/wallet/apple-config.ts`,
   `google-config.ts`); never in code, tests, logs or tickets.
4. **Signing.** Reuse the restaurant signer (`buildPkpass`, `signManifest`) and Google save-JWT
   adapter. A live pass needs a code the server can re-render for updates, so live issuance must
   add a wallet credential the server can read back (encrypted, or a separate opaque alias the
   counter scan also resolves). Decide this with the security review.
5. **Balance updates.** Asynchronous and retryable, from the ledger: after each points entry,
   queue an update per live pass; a worker pushes it (APNs for Apple, object PATCH for Google)
   with backoff. A failed push never blocks a sale. Reuse the restaurant outbox pattern
   (`src/lib/restaurant/wallet/balance-updates.ts`).
6. **Revocation.** Revoking or replacing a card marks its passes void and pushes that state.
7. **Real-device pass.** One Apple and one Google pass added to real phones, scanned at a real
   counter scanner, balance updated after a sale and a khata repayment, then revoked.

## Device compatibility and local acceptance

QR first; NFC is optional and out of scope until the issuers allow it.

| Check                                                            | Test pass | Live pass  |
| ---------------------------------------------------------------- | --------- | ---------- |
| Counter USB/keyboard scanner reads the QR from a phone screen    | Yes       | Yes        |
| Counter camera scan reads the QR from a phone screen             | Yes       | Yes        |
| Manual entry of the code printed under the QR                    | Yes       | Yes        |
| QR resolves the same customer at another branch of the same org  | Yes       | Yes        |
| QR from another organization is refused                          | Yes       | Yes        |
| Revoked or replaced card's QR is refused                         | Yes       | Yes        |
| iPhone Wallet adds the pass                                      | No        | Required   |
| Android Google Wallet adds the pass                              | No        | Required   |
| Balance on the pass updates after a sale, refund, khata payment  | No        | Required   |
| Screen brightness, cracked screen and low-light scans at counter | Advisory  | Required   |

Record scanner models in `docs/pharmacy/hardware-acceptance-matrix.md`.
