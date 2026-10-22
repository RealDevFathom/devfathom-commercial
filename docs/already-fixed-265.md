# GitHub issue #265: already fixed in the current tree

Issue #265 does not reproduce at the current `work` branch HEAD (`16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca`). No corrective migration is needed.

## File and line evidence

- [`src/lib/pharmacy/whatsapp/messages.ts` lines 64–72](../src/lib/pharmacy/whatsapp/messages.ts#L64-L72) defines the complete allowlist for re-subscription. It contains the whole-message values `start` and `شروع` (as well as the already-supported explicit subscribe phrases), but does not contain `yes`, `haan`, or `ہاں`.
- [`src/lib/pharmacy/whatsapp/messages.ts` lines 74–78](../src/lib/pharmacy/whatsapp/messages.ts#L74-L78) returns `START` only when the normalized whole message is a member of that allowlist. Consequently, `شروع` maps to `START`, while `yes`, `haan`, and `ہاں` map to `null`.
- [`prisma/migrations/20260929120000_pharmacy_whatsapp_channel/migration.sql` lines 1–5](../prisma/migrations/20260929120000_pharmacy_whatsapp_channel/migration.sql#L1-L5) adds the WhatsApp consent state, and [lines 7–42](../prisma/migrations/20260929120000_pharmacy_whatsapp_channel/migration.sql#L7-L42) creates its message log without rewriting or classifying consent keywords.
- [`prisma/migrations/20260929120000_pharmacy_whatsapp_channel/migration.sql` lines 48–58](../prisma/migrations/20260929120000_pharmacy_whatsapp_channel/migration.sql#L48-L58) enables and forces row-level security on that log and retains the tenant-isolation policy.

The reported `prisma/migrations/20261022000000_minimize_wa_consent` migration is not present in this tree. This was verified with:

```sh
find prisma/migrations -maxdepth 2 -type f -path '*20261022*' -print
rg -n "minimize_wa_consent|'yes'|'haan'|'ہاں'|'شروع'" prisma/migrations src/lib/pharmacy/whatsapp
```

The first command returns no files. The second finds `شروع` only in the runtime `START` allowlist and finds none of the reported affirmative words in migration logic. Adding another migration would therefore introduce data-changing behavior where the reported contradictory archive operation does not exist. No authorization behavior, dispensing scope, or migration was changed.

As a security-review follow-up, [`src/lib/pharmacy/whatsapp/provider.ts` lines 156–168](../src/lib/pharmacy/whatsapp/provider.ts#L156-L168) also enforces the existing live-send block at the Meta provider's network boundary. This is separate from the already-fixed consent classification, and prevents direct provider construction from bypassing the factory-level block.
