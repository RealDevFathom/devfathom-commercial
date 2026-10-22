# Azure deployment (retired)

Azure deployments are retired. **Do not run the Bicep templates or Azure deployment scripts in
`infra/`.** They remain only as historical implementation evidence and are not a supported staging
or production path.

The active staging platform is AWS in `ap-southeast-1`:

- CloudFormation templates under `infra/aws/` are the infrastructure source of truth.
- The `devfathom-staging` CloudFormation stack owns the staging VPC, RDS database, ECS services,
  load balancer, secrets, and jobs schedule.
- Image migrations and application rollouts run as ECS tasks and services. Preserve the documented
  migration-before-web-service order and all tenant-isolation controls; DENY remains authoritative
  over ALLOW.

Use the [AWS deployment runbook](deploy/aws.md) for the staging stack inventory, image build,
CloudFormation update, ECS migration task, service rollout, readiness check, and rollback procedure.
The legacy `infra/deploy-staging.sh` command now exits before making any Azure request.
