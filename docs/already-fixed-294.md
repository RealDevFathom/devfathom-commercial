# GitHub issue #294: already fixed

Verified against the current code on 2026-10-22. No implementation change is
needed:

- `src/lib/pharmacy/whatsapp/provider.ts:72-89` reads the template language and
  Khata reminder template name from server environment configuration. This
  supplies the previously missing configuration path without adding a
  tenant-controlled UI or API setting.
- `src/lib/pharmacy/whatsapp/provider.ts:193-209` passes that configured language
  code and template name to the Meta template request.
- `src/lib/pharmacy/whatsapp/khata-reminders.ts:102-116` reports the job as
  unconfigured when the template, sender ownership, phone-number ID, or Meta
  access token is absent; a configured Meta selection is no longer rejected
  merely because it is Meta.
- `src/lib/pharmacy/whatsapp/khata-reminders.ts:140-224` preserves organization,
  active-branch, pharmacy lifecycle, entitlement, customer, and explicit
  WhatsApp reminder-consent gates before a message is claimed.
- `src/lib/pharmacy/whatsapp/provider.ts:278-297` retains the code-level block on
  live Meta sends pending owner sender/template approval. Configuration alone
  therefore cannot cause a real reminder to leave the application.
- `src/lib/pharmacy/whatsapp/khata-reminders.test.ts:249-299` contains focused
  coverage for missing Meta credentials and for the configured job path using
  an injected, non-network provider double.
- `src/lib/pharmacy/whatsapp/provider.test.ts:198-208` verifies that the
  production provider factory continues to refuse live Meta sends.

The repository still does not claim that an Urdu template has been approved in
Meta or that Meta credentials have been provisioned. Those are deployment and
provider-account prerequisites, not missing application behavior. No archive
branch recovery was requested by this issue, so there were no archive-only
changes to port or skip.

## Attempt 2 review scope

The security-review findings supplied with attempt 2 concern follow-up branches
for issues #339, #299, #289, #284, and #238. None is part of issue #294, and all
five branches are explicitly marked `HOLD`; consequently, no code from them was
ported. In particular, this verification does not alter authorization, pharmacy
finance postings, khata settlement, prescription permissions, or migrations.
