import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import type { EnvironmentConfig } from './config';
import { resourceNames } from './names';

/**
 * cdk-nag AwsSolutions findings we accept, with a reason on the resource.
 * Staging-only findings (single-AZ, no deletion protection) are skipped in production.
 */
export function suppressAcceptedFindings(
  environment: cdk.Stack,
  cicd: cdk.Stack,
  config: EnvironmentConfig
): void {
  const postgres = mustFind(environment, 'Data/Postgres/Resource');
  if (!config.dbMultiAz) {
    NagSuppressions.addResourceSuppressions(postgres, [
      {
        id: 'AwsSolutions-RDS3',
        reason:
          'Staging uses one db.t4g.micro to keep cost down. Production sets multiAz and is not suppressed.',
      },
    ]);
  }
  if (!config.dbDeletionProtection) {
    NagSuppressions.addResourceSuppressions(postgres, [
      {
        id: 'AwsSolutions-RDS10',
        reason:
          'Staging can be replaced. Removal policy is SNAPSHOT. Production enables deletion protection.',
      },
    ]);
  }
  NagSuppressions.addResourceSuppressions(postgres, [
    {
      id: 'AwsSolutions-RDS11',
      reason:
        'Postgres stays on 5432. The instance is in isolated subnets and the security group allows only the web, migration, and Evolution tasks.',
    },
  ]);

  const secretReason =
    'Automatic rotation is deferred. Rotating AUTH_SECRET, the encryption key, or the database password recycles sessions and tasks. Operators replace the secret and roll the services.';
  for (const suffix of [
    'Data/AuthSecret/Resource',
    'Data/PlatformEncryptionSecret/Resource',
    'Data/CronSecret/Resource',
    'Data/EvolutionApiKey/Resource',
    'Data/Postgres/Secret/Resource',
  ]) {
    NagSuppressions.addResourceSuppressions(mustFind(environment, suffix), [
      { id: 'AwsSolutions-SMG4', reason: secretReason },
    ]);
  }

  const envReason =
    'These environment values are not secrets: ports, hostnames, and feature flags. Credentials come from Secrets Manager via the task secrets field.';
  for (const suffix of [
    'Compute/MigrateTask/Resource',
    'Compute/WebTask/Resource',
    'Compute/EvolutionTask/Resource',
  ]) {
    NagSuppressions.addResourceSuppressions(mustFind(environment, suffix), [
      { id: 'AwsSolutions-ECS2', reason: envReason },
    ]);
  }

  NagSuppressions.addResourceSuppressions(mustFind(environment, 'Compute/Alb/SecurityGroup/Resource'), [
    {
      id: 'AwsSolutions-EC23',
      reason:
        'The load balancer is the public entry point. It accepts 80 and 443 from the internet and forwards only to the web target group.',
    },
  ]);

  const logRole = findByPathIncludes(environment, '/LogRetention', '/ServiceRole/Resource');
  const logPolicy = findByPathIncludes(environment, '/LogRetention', '/ServiceRole/DefaultPolicy/Resource');
  NagSuppressions.addResourceSuppressions(logRole, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'The RDS log-retention custom resource is a CDK singleton. It uses AWSLambdaBasicExecutionRole so the function can write its own logs.',
      appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
    },
  ]);
  NagSuppressions.addResourceSuppressions(logPolicy, [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'The log-retention function updates the retention of the log groups it creates. CDK scopes that custom resource with a log-group wildcard.',
      appliesTo: ['Resource::*'],
    },
  ]);

  NagSuppressions.addResourceSuppressions(
    mustFind(environment, 'Compute/ExecutionRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'ecr:GetAuthorizationToken does not support a resource ARN. Image pulls and secret reads are limited to this stack’s repositories and secrets.',
        appliesTo: ['Resource::*'],
      },
    ]
  );

  NagSuppressions.addResourceSuppressions(
    mustFind(environment, 'Compute/WebTaskRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'The web task reads and writes objects in the private uploads bucket. grantReadWrite uses the bucket’s object actions and prefix wildcard; the bucket blocks public access and denies non-TLS requests.',
        appliesTo: [
          'Action::s3:Abort*',
          'Action::s3:DeleteObject*',
          'Action::s3:GetBucket*',
          'Action::s3:GetObject*',
          'Action::s3:List*',
          uploadsObjectArn(environment),
        ],
      },
    ]
  );

  const names = resourceNames(config.stage);
  const region = cicd.region;
  const account = cicd.account;
  NagSuppressions.addResourceSuppressions(mustFind(cicd, 'GithubDeployRole/DefaultPolicy/Resource'), [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'GetAuthorizationToken and RegisterTaskDefinition cannot be resource-scoped. Task, task-definition revision, stack, and log-group wildcards stay inside this stage’s cluster, families, stack, and log prefix.',
      appliesTo: [
        'Resource::*',
        `Resource::arn:aws:ecs:${region}:${account}:task/${names.cluster}/*`,
        `Resource::arn:aws:ecs:${region}:${account}:task-definition/${names.webFamily}:*`,
        `Resource::arn:aws:ecs:${region}:${account}:task-definition/${names.migrateFamily}:*`,
        `Resource::arn:aws:ecs:${region}:${account}:task-definition/${names.evolutionFamily}:*`,
        `Resource::arn:aws:cloudformation:${region}:${account}:stack/DevFathom-${config.stage}/*`,
        `Resource::arn:aws:logs:${region}:${account}:log-group:/devfathom/${names.short}/*`,
      ],
    },
  ]);
}

function uploadsObjectArn(stack: cdk.Stack): string {
  const bucket = mustFind(stack, 'Data/Uploads');
  const child = bucket.node.defaultChild;
  if (!child || !cdk.CfnResource.isCfnResource(child)) {
    throw new Error('Uploads bucket is missing its CloudFormation resource.');
  }
  return `Resource::<${stack.getLogicalId(child)}.Arn>/*`;
}

function mustFind(stack: cdk.Stack, suffix: string): IConstruct {
  const matches = stack.node.findAll().filter((construct) => construct.node.path.endsWith(`/${suffix}`));
  if (matches.length !== 1) {
    const found = matches.map((construct) => construct.node.path).join(', ') || '(none)';
    throw new Error(`Expected one construct ending with /${suffix} in ${stack.node.path}, found ${found}.`);
  }
  return matches[0];
}

function findByPathIncludes(stack: cdk.Stack, includes: string, suffix: string): IConstruct {
  const matches = stack.node
    .findAll()
    .filter(
      (construct) => construct.node.path.includes(includes) && construct.node.path.endsWith(suffix)
    );
  if (matches.length !== 1) {
    const found = matches.map((construct) => construct.node.path).join(', ') || '(none)';
    throw new Error(
      `Expected one ${includes} construct ending with ${suffix} in ${stack.node.path}, found ${found}.`
    );
  }
  return matches[0];
}
