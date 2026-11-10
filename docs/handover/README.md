# Handover (CTO-owned)

> These documents are owned and maintained by the CTO. They were written for investors doing technical due diligence and for a new CTO taking over. Repo copies were added 10 Nov 2026 (PKT) and sanitized before commit: identifiers such as account IDs, instance IDs, IP addresses, IAM names, secret names and contact emails were removed. Unverified items stay marked **TO CONFIRM**.

| Document | What it covers |
|---|---|
| [Infrastructure and access](01-infrastructure-and-access.md) | Environments map, AWS regions and stacks, other services and who owns them, the secrets inventory (categories only), IAM principals by purpose, and the access checklist for a new CTO |
| [Running costs](02-running-costs.md) | Verified AWS spend (Aug–Nov 2026), non-AWS costs, and an **ESTIMATE** per-pharmacy cost model |
| [Security summary](03-security-summary.md) | Tenant isolation, roles and separation of duties, MFA, encryption and backups, network hardening, AI and WhatsApp controls, reviews done, open security issues (including **no branch protection on `develop`**), and the Punjab/DRAP compliance position |

Developer-facing material is in the [developer handbook](../dev/README.md).

**Never add secret values, passwords, tokens, account IDs or login details to these files.** They live in AWS Secrets Manager and the password manager.
