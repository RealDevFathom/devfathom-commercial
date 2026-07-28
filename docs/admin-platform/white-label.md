# Custom Domains, White-label, and Email

## Planned contract

Each organization may have verified custom domains and a brand profile (name, mark, colors, support contacts, legal links). Host resolution must occur before authentication and must reject unverified, suspended, or ambiguous domains. Domain proof uses DNS/HTTP verification, renewal monitoring and safe takeover prevention.

Email branding and sender domains require separate DNS verification (SPF, DKIM, DMARC) and clear transactional-versus-marketing classifications. Tenant email configuration must not permit arbitrary sender spoofing. Existing email abstractions live in `src/lib/email/`; provider enablement must be verified from deployment configuration.
