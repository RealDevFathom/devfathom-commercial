# Issue #26: already fixed by the staging platform migration

Issue #26 asked for the pre-existing Azure staging what-if drift to be reconciled
before the next full deployment of `infra/environment.bicep`. That deployment is
no longer on the staging release path:

- `.github/workflows/deploy-staging.yml:3-9` records that Azure staging is retired,
  points operators to the AWS runbook, and restricts the legacy workflow to manual
  dispatch rather than running it for changes merged to `main`.
- `docs/deploy/aws.md:1-5` states that the AWS environments replace the Azure Bicep
  environments and that CloudFormation under `infra/aws/` is now the infrastructure
  source of truth.
- `docs/deploy/aws.md:23-30` identifies the active staging environment as the
  `devfathom-staging` CloudFormation stack in `ap-southeast-1`.

Consequently there is no upcoming Azure staging `az deployment group create` in
the supported deployment flow for the old drift to block. Reintroducing an Azure
staging environment would be a new infrastructure decision: it must begin with a
fresh what-if review against the then-current subscription, not with the
2026-08-05 snapshot described in the issue.

No archived branch was involved in this issue, and no infrastructure, deployment,
DNS, or secret value was changed while verifying its status.
