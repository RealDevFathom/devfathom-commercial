# Growth G1 blocked — 2026-10-21

Stopped under the explicit instruction to stop when the same problem fails twice.
`prisma format` and `prisma migrate diff` both reported P1012: CustomerMetrics has
an organization-scoped one-to-one customer relation but lacks the explicit
`@@unique([organizationId, customerId])` required by Prisma. No fix attempts or
further validation were run after recognizing the repeated failure.

## Partial work

- Added draft growth schema models and PharmacyCustomer consent fields,
  PharmacySale.discountCode, and extensions to the existing PharmacyMessageLog.
- Schema is NOT valid. No migration was produced, no database was changed,
  and seed implementation is pending. Do not merge this branch.
- Prisma format also reformatted existing schema alignment; review/minimize that
  incidental diff when resuming.

## Repository findings

- Tenant: Organization / organizationId.
- Retail customer: PharmacyCustomer; full phone and dateOfBirth are on its
  organization-scoped PharmacyPatient relation. Reuse dateOfBirth, not a duplicate
  birthday. Existing nullable whatsappOptIn and whatsappOptInChangedAt must retain
  their audit semantics. Backfill only valid full Pakistani mobile numbers from
  the linked patient; never derive from phoneLast4 or grant consent.
- Sale: PharmacySale, pharmacy_sales; discountCode was absent.
- Settings/flag: OrganizationModule entitlements; growth_ai already uses
  resolveOrganizationEntitlements / hasModule. No new flag system needed.
- AI: src/lib/ai/provider.ts, createGroq / existing provider abstraction.
- WhatsApp: existing PharmacyMessageLog and Meta/mock providers in
  src/lib/pharmacy/whatsapp. No production Prisma cast stub was found in growth
  or WhatsApp files inspected. Preserve existing providerMessageId/dedupeKey
  behavior when adding the required organizationId,direction,waMessageId key.
- No nested AGENTS.md found under prisma or src. Read root AGENTS.md, both
  /workspace plans, and installed Next installation documentation. No UI work.

## Remaining G1 work

Repair the relation; generate one migration with ENABLE and FORCE RLS and
organization isolation policies for every new table; ensure composite tenant
foreign keys; safe phone backfill and false defaults without data loss; seed
GrowthSettings and eight safe templates for existing demo pharmacies only.
No medicine/drug/Rx promotions; refill messages must remain utility only.
Generate Prisma and validate migration on fresh and demo databases and seed.
Run relevant/full tests, typecheck, lint and build. No install was repeated.

## Validation limitations

Prisma format and schema diff failed with the same P1012 relation error.
Generation, migration application, seed, typecheck, tests, lint and build were
not run after the mandatory stop. No DATABASE_URL or SHADOW_DATABASE_URL was
present in the shell environment; no local postgres/psql/docker executable was
found. Database validation would require an available isolated database.
