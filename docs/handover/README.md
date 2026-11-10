# Handover (CTO-owned)

> These documents are owned and maintained by the CTO. They were written for investors doing technical due diligence and for a new CTO taking over. Repo copies were added 10 Nov 2026 (PKT) and sanitized before commit: identifiers such as account IDs, instance IDs, IP addresses, IAM names, secret names and contact emails were removed. A second pass after the CTO's review (10 Nov 2026) also removed stack, database and server names, the image digest, secret name prefixes and notes on where credentials are kept, and corrected facts against develop `1906b530`. Unverified items stay marked **TO CONFIRM**.

| Document | What it covers |
|---|---|
| [Infrastructure and access](01-infrastructure-and-access.md) | Environments map, AWS regions and stacks, CI/CD and branch protection, other services and who owns them, the secrets inventory (categories only), IAM principals by purpose, and the access checklist for a new CTO |
| [Running costs](02-running-costs.md) | Verified AWS spend (Aug–Nov 2026), non-AWS costs, and an **ESTIMATE** per-pharmacy cost model |
| [Security summary](03-security-summary.md) | Tenant isolation, roles and separation of duties, MFA, encryption and backups, network hardening, AI and WhatsApp controls, reviews done, open security issues, branch protection (`main` protected with two required checks; `develop` protection planned in two steps per Saad's decision of 10 Nov 2026), and the Punjab/DRAP compliance position |

Azure: **Azure code still exists on develop** (an AI provider, a storage adapter, three packages, and the Azure-only staging and production deploy workflows). **Saad ordered Azure removed from all code on 10 Nov 2026.** The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437).

Developer-facing material is in the [developer handbook](../dev/README.md).

**Never add secret values, passwords, tokens, account IDs or login details to these files.** The CTO hands the credential inventory over in person.
