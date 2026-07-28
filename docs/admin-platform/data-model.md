# Domain and Data Model

## Baseline entities

`prisma/schema.prisma` includes users, clients, projects, tasks/boards, meetings, notes, chat, invoices, transactions, API tokens and audit-related application data. Examples: `Client` at lines 368–391, `Project` at 439–466, `Invoice` at 708–734, and `ApiToken` at 1220–1236. Treat the schema as authoritative for exact fields and relations.

## Planned platform entities

| Entity                     | Responsibility                                      |
| -------------------------- | --------------------------------------------------- |
| Agency                     | control-plane owner and billing authority           |
| Organization               | tenant, lifecycle state and default locale/timezone |
| Membership                 | user-to-organization role/capability binding        |
| Plan / CapabilityGrant     | sellable plan and effective entitlement source      |
| Subscription / LedgerEntry | commercial state and immutable accounting events    |
| IdentityConnection         | OIDC/SAML configuration and lifecycle               |
| Domain / BrandProfile      | host verification and tenant presentation           |
| UsageEvent                 | append-only metering input                          |
| ExportJob / PurgeJob       | lifecycle-controlled data operations                |

All tenant-owned baseline records require an organization association during migration. Exact field names and migrations remain planned until source lands.
