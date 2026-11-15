# Brand, Custom Domains, and Email

## Organization brand

`OrganizationBrand` stores:

- primary and accent colors;
- logo, mark, and favicon URLs;
- support email;
- sender name;
- update actor/time.

The tenant layout reads brand state inside the tenant transaction and applies CSS variables and workspace identity at runtime. Missing values fall back to DevFathom defaults. The brand preview page uses a safe entitlement context so it can render outside a tenant layout.

Applying a brand enqueues or executes `APPLY_BRAND`, which records a deterministic brand version in deployment health metadata.

## Custom domains

Domains have a purpose, primary flag, generated verification token, verification state, last check, failure reason, and verified timestamp.

Verification workflow:

1. tenant or platform operator adds the normalized host;
2. DevFathom shows `_devfathom-verification.<host>` and its exact TXT value;
3. the worker resolves TXT records;
4. mismatches remain `FAILED` with an actionable reason;
5. a verified record is attached to the approved AWS deployment;
6. only `VERIFIED` domains resolve to the tenant.

Retry is explicit and auditable. Manual status control exists for operational recovery. Unverified domains never route tenant traffic.

The shared canonical slug host remains available while customer DNS is pending.

Standard customers sign in at the shared application host, which carries no slug
at all; their per-tenant slug host keeps resolving for existing bookmarks but is
no longer the canonical entry point. The reserved labels `www`, `admin`, `app`,
`api` and `staging` cannot be assigned as organization slugs, because they would
shadow the control plane or the shared application.

## Dedicated domains

Support and host resolution use the ready deployment URL when available. Dedicated AWS domain attachment is **BLOCKED** until that deployment path is implemented and verified; it must use the same DNS proof.

## Email delivery

Organization email settings include provider name, sender name/address, reply-to, encrypted API key, verification time, and provider configuration JSON.

Tenant administrators can update presentation/configuration, but existing secrets are never returned. Omitting the API key retains the stored credential. Platform settings show whether optional global email integrations are configured.

The repository retains existing provider adapters (platform email, Brevo/SMTP-style settings, Gmail/Microsoft integrations where configured). Production must select and provision the real provider. UI presence is not proof of sender-domain verification.

## Email DNS and abuse controls

Before customer-branded sending:

- verify the provider’s required domain records;
- configure SPF and DKIM;
- publish an appropriate DMARC policy;
- constrain `fromAddress` to approved domains;
- separate transactional and marketing use;
- rotate provider API keys;
- monitor bounce/complaint/reputation signals;
- document fallback sender behavior.

## Asset handling

Brand fields currently accept HTTPS URLs; they do not upload image assets. Use a trusted object store/CDN and restrict operationally who can update these values. Private organization data must never be embedded in public brand assets.
