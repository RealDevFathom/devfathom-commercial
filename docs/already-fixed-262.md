# GitHub issue #262 — already fixed

Verified against the current code at commit
`16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca`.

No production or test code change is required:

- The webhook calls `handleInboundWhatsAppMessage` directly rather than passing a restricted
  `growthStore` adapter (`src/app/api/pharmacy/whatsapp/webhook/route.ts`, lines 163–171).
- The handler claims the inbound provider message and updates consent in the same tenant-scoped
  transaction (`src/lib/pharmacy/whatsapp/inbound.ts`, lines 155–196). The claim is keyed by the
  provider message ID (lines 159–168), and the opt-out update is constrained by both
  `organizationId` and customer ID (lines 175–187).
- A duplicate inbound claim returns `DUPLICATE` before any acknowledgement can be sent
  (`src/lib/pharmacy/whatsapp/inbound.ts`, lines 197–198). The outbound acknowledgement has its own
  deterministic dedupe key and is sent only after the consent transaction commits (lines 206–229).
- The outbound helper commits its dedupe claim before calling the provider, providing at-most-once
  sending even when the provider outcome is ambiguous (`src/lib/pharmacy/whatsapp/message-log.ts`,
  lines 71–100).
- Focused unit coverage already verifies that STOP persists opt-out and blocks later orders
  (`src/lib/pharmacy/whatsapp/inbound.test.ts`, lines 226–237), transaction failures do not call the
  provider and remain retryable (lines 258–274), and an ambiguous acknowledgement is neither rolled
  back nor resent on webhook retry (lines 276–284).
- Consent ordering is fail-closed: STOP wins equal provider timestamps, with focused coverage for
  either delivery order (`src/lib/pharmacy/whatsapp/inbound.ts`, lines 179–186;
  `src/lib/pharmacy/whatsapp/inbound.test.ts`, lines 286–319).

This implementation preserves tenant isolation, does not touch pharmacy dispensing behavior, and
persists only a fixed error classification rather than arbitrary transport errors
(`src/lib/pharmacy/whatsapp/message-log.ts`, lines 93–100).
