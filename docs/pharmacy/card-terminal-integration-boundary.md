# Pharmacy card terminal integration boundary (DEV-743)

Status: **design and adapter seam only. No provider is bound.** All integrated card payments still
fail closed with `UNCERTIFIED_PROVIDER`.

Code: `src/lib/pharmacy/card-terminal/`. Tests: the `*.test.ts` files beside it, including
`card-terminal.mocked-e2e.test.ts`.

## What this is, and what it is not

| | Manual card tender (DEV-713, PR #1363) | Integrated terminal (this seam, DEV-743) |
| --- | --- | --- |
| Who takes the card | A standalone terminal, outside DevFathom | A terminal DevFathom drives through a provider adapter |
| Who knows the outcome | The cashier, who types the reference and approval code | The provider, through a response or a status query |
| Tender `provider` | `MANUAL_TERMINAL` | The admitted provider's name |
| Refund | Recorded manually | VOID or REFUND through the provider, then `refundPharmacyTender` |

This seam does not change the DEV-713 flow and does not touch `settlement.ts`. It plugs into the
existing `PharmacyPaymentAdapter` hand-off that `applyPharmacyTender` and `refundPharmacyTender`
already use for `CARD` with an adapter.

## Blocked until explicitly authorized

The following are **not done** and need written authorization before anyone starts them:

- choosing or binding a provider, SDK, device protocol or cloud terminal API;
- handling provider credentials, merchant keys or terminal pairing secrets;
- connecting to a real device or a provider sandbox over the network;
- any live financial transaction, including small test charges;
- claiming certification, PCI scope reduction or device compatibility;
- network or security changes, such as firewall rules, certificates or a local device bridge.

The production admission list (`PRODUCTION_TERMINAL_ADMISSION` in `contract.ts`) is empty and
frozen. Adding a provider name to it is the binding step. That change must be made separately and
reviewed, with the certification evidence linked.

## Reuse of existing infrastructure

- **Restaurant `payment-adapter.ts`**: reused the C6 cardholder-data key list. It is now exported,
  and the pharmacy guard extends it so there is one list. The restaurant `execute` contract is
  synchronous and pure, which does not fit a terminal that can hang or answer later, so it is not
  reused as the provider interface.
- **Pharmacy `settlement.ts`**: reused unchanged. `requireReleaseSafeAdapter` is still the final
  gate. The seam's `settlementAdapter()` reports `certified: true` only for an admitted provider.
- **Pharmacy `payment-sandbox.ts`**: same model of an UNKNOWN outcome that blocks the sale until it
  is reconciled. The seam generalizes it to a real provider contract with status queries.

## Provider contract (`contract.ts`)

A provider adapter implements `CardTerminalProvider`:

- `startSale`, `queryStatus`, and optionally `voidSale`, `refundSale` and `settlementReport`;
- every call receives an `AbortSignal` and the seam enforces a timeout;
- `operationRef` is the seam's intent reference. **The provider must treat it as its idempotency
  key and must be able to look an operation up by it.** A provider that cannot do this is not
  suitable;
- responses are `APPROVED`, `DECLINED`, `PENDING`, `NOT_FOUND` (status only) or `ERROR`.
  `ERROR` with `reachedTerminal: false` is the only way to report "definitely not charged";
- only opaque references, the approval code, the brand and the last four digits cross the
  boundary. Anything malformed is treated as an UNKNOWN outcome.

## Intent state machine (`intent.ts`)

```
CREATED ─dispatch─▶ SENT ─▶ PENDING ─▶ APPROVED ─ledger─▶ SETTLED
   │                 │ └──▶ DECLINED      └─ amount mismatch ─▶ MANUAL_REVIEW
   │                 └──▶ UNKNOWN ─status─▶ APPROVED | DECLINED | FAILED
   └─abandon─▶ FAILED      └─ attempts exhausted ─▶ MANUAL_REVIEW ─operator─▶ APPROVED | FAILED
```

- **Write-ahead**: `SENT` is persisted, through a compare-and-set, before the provider is called.
  Only the writer that wins this compare-and-set may dispatch.
- **FAILED** means positively not charged. **UNKNOWN** means not known, and it is never retried as
  a new charge.
- `NOT_FOUND` counts as not charged only from a status query, and only after `notFoundGraceMs`
  since dispatch.
- A partial or over approval goes to `MANUAL_REVIEW` and is never settled automatically.
- A manual resolution requires a reason, records the actor, and must match the intent amount.

## Duplicate-charge protection (`service.ts`, `store.ts`)

1. The same attempt key gives the same intent. A replay of a dispatched attempt returns it without
   calling the provider. The same key with a different amount or terminal is
   `IDEMPOTENCY_CONFLICT`.
2. A sale has at most one open money operation. Another attempt is refused while one is
   unresolved (`ACTIVE_OPERATION_EXISTS`) or approved but not yet a tender (`APPROVED_NOT_SETTLED`).
   Split tenders are allowed once the earlier one is settled; settlement's `OVER_TENDER` still caps
   the total.
3. Settlement binds the tender to `${intentRef}:tender`. The hand-off adapter replays the approved
   outcome only for that key, the exact amount and the right capability, and never calls the
   provider.

## Recovery

`recover(intentRef)` is safe to call repeatedly, from the counter after a reload or from a
background sweep. `unresolved(org, branch)` lists what is still open. The day-close gate should
refuse to close while this list is not empty. That gate is not wired yet; see the follow-ups.

## Refund and void (`reversal.ts`)

- **VOID**: the full amount, nothing reversed yet, the batch still open, and the provider supports
  void.
- **REFUND**: any amount within the remaining captured value, if the provider supports refunds.
- **BLOCKED** otherwise. The reason is one of `SALE_NOT_SETTLED`, `PRIOR_REVERSAL_UNRESOLVED`,
  `EXCEEDS_REMAINING`, `REVERSAL_UNSUPPORTED`, and so on. The seam never falls back to cash.
- An approved reversal is recorded through `refundPharmacyTender` with
  `${intentRef}:refund` and the original sale's provider reference as `priorRef`.

## Reconciliation (`reconciliation.ts`)

A pure, deterministic three-way comparison of intents, ledger rows and the provider settlement
report. Each issue maps to a recommended action:

| Issue | Action |
| --- | --- |
| `APPROVED_NOT_SETTLED` (including a late charge after FAILED) | `REVIEW_VOID_OR_REFUND` |
| `UNRESOLVED_INTENT` | `RECOVER_STATUS` |
| `MISSING_FROM_PROVIDER_REPORT` | `RECHECK_AFTER_BATCH` |
| `PROVIDER_RECORD_WITHOUT_INTENT`, `LEDGER_ROW_WITHOUT_INTENT`, `AMOUNT_MISMATCH`, `DUPLICATE_PROVIDER_REF` | `INVESTIGATE` |

Manual `MANUAL_TERMINAL` tenders are excluded by provider name.

## Card data and secrets (`cardholder-data.ts`)

- Fields that mean PAN, CVV, track, PIN, expiry or EMV data, or secrets such as API keys and
  tokens, are refused before any intent is written.
- Any string with a Luhn-valid run of 13 to 19 digits is refused, including in provider references
  and operator notes.
- Logs are structured and pass through `redactForLog`.
- The seam's own hashes are rendered as letters (a to p), so the PAN scan cannot fire on them.
- Known limitation: a provider whose genuine references are Luhn-valid 13 to 19 digit numbers would
  see those approvals go to recovery and then manual review. Revisit this once a provider's
  reference format is known.

## Proposed persistence (not migrated)

The seam ships the `TerminalIntentStore` port and an in-memory reference store. A real table needs
its own migration and review. Proposed shape:

```
pharmacy_terminal_intents(
  id, "organizationId", "branchId", "saleId", kind, "attemptKey", "intentRef", "payloadHash",
  "terminalId", provider, "amountMinor", currency, "reversesIntentRef", state, version,
  "recoveryAttempts", "providerRef", "approvalCode", "cardBrand", last4, "declineCode",
  "failureCode", "reviewReason", "ledgerRef", history jsonb, "createdBy", "createdAt",
  "updatedAt", "sentAt")
UNIQUE ("organizationId", "intentRef")
-- one open money operation per sale:
UNIQUE ("organizationId", "saleId") WHERE state IN
  ('CREATED','SENT','PENDING','UNKNOWN','MANUAL_REVIEW','APPROVED')
-- RLS on organizationId, as for other pharmacy money tables; compare-and-set on version.
```

## Provider selection checklist (for the authorization decision)

Before binding a provider, someone must confirm and document:

1. The provider and device are certified for the target market and acquirer, with evidence links.
   Do not infer this from marketing material.
2. Operations are idempotent on a caller key, and status can be looked up by that key.
3. Void and refund semantics, batch close timing, and how partial approvals behave.
4. Where card data is handled (semi-integrated or P2PE), so DevFathom stays out of PAN scope.
5. Credential storage and rotation, with no secrets in the repository or logs.
6. Network path from the counter to the terminal or cloud, and the security review it needs.
7. The physical acceptance matrix (DEV-744).

## Follow-ups (not in this change)

- Database table, migration and RLS for intents, plus a store implementation.
- A router or command that wires the counter to `startSale` and `recover`, and a counter UI for
  pending, unknown and manual-review states (DevFathom Studio rules apply).
- A day-close gate on `unresolved()` and reconciliation lines.
- A background recovery sweep.
- The actual provider adapter, after authorization.

## Verification limits

Everything here is checked with mocked, in-process tests only. Not verified: any real provider,
SDK, device, network path, certification, settlement file format, or physical acceptance.
