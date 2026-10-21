import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import type { DeploySettings, EnvironmentConfig } from './config';
import { resourceNames } from './names';

export interface CicdStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly settings: DeploySettings;
}

/**
 * GitHub Actions OIDC deploy role. The role can push images and roll ECS tasks.
 * It cannot change the data stack. Infrastructure changes stay with a human
 * `cdk deploy` using the account's admin or bootstrap deploy role.
 */
export class CicdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);
    const { config, settings } = props;
    const names = resourceNames(config.stage);
    const region = this.region;
    const account = this.account;
    const repo = settings.githubRepo;

    const provider = settings.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          thumbprints: [
            '6938fd4d98bab03faadb97b34396831e3780aea1',
            '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
          ],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidc',
          `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`
        );

    const staging = config.stage === 'staging';
    const subjects = staging
      ? [
          `repo:${repo}:ref:refs/heads/infra/aws`,
          `repo:${repo}:ref:refs/heads/staging`,
          `repo:${repo}:environment:staging`,
        ]
      : [`repo:${repo}:environment:production`];
    const refs = staging ? ['refs/heads/infra/aws', 'refs/heads/staging'] : ['refs/heads/main'];
    const workflows = staging
      ? [
          `${repo}/.github/workflows/aws-staging.yml@refs/heads/infra/aws`,
          `${repo}/.github/workflows/aws-staging.yml@refs/heads/staging`,
        ]
      : [`${repo}/.github/workflows/aws-production.yml@refs/heads/main`];

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: names.deployRole,
      description: `GitHub Actions image rollout for DevFathom ${config.stage}. No static access keys.`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:job_workflow_ref': workflows,
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': subjects,
          'token.actions.githubusercontent.com:ref': refs,
        },
      }),
    });

    const ecrRepos = [names.webRepo, names.migrateRepo, names.evolutionRepo].map(
      (name) => `arn:aws:ecr:${region}:${account}:repository/${name}`
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuth',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPush',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImages',
          'ecr:DescribeRepositories',
          'ecr:GetDownloadUrlForLayer',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        resources: ecrRepos,
      })
    );
    if (!staging) {
      deployRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'EcrReadStagingImages',
          actions: ['ecr:BatchGetImage', 'ecr:DescribeImages', 'ecr:GetDownloadUrlForLayer'],
          resources: ['web', 'migrate', 'evolution'].map(
            (name) => `arn:aws:ecr:${region}:${account}:repository/devfathom-stg-${name}`
          ),
        })
      );
    }

    const clusterArn = `arn:aws:ecs:${region}:${account}:cluster/${names.cluster}`;
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsReadCluster',
        actions: ['ecs:DescribeClusters'],
        resources: [clusterArn],
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsServices',
        actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
        resources: [names.webService, names.evolutionService].map(
          (serviceName) => `arn:aws:ecs:${region}:${account}:service/${names.cluster}/${serviceName}`
        ),
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsTasks',
        actions: ['ecs:DescribeTasks', 'ecs:ListTasks'],
        resources: [`arn:aws:ecs:${region}:${account}:task/${names.cluster}/*`],
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsRunMigration',
        actions: ['ecs:RunTask'],
        resources: [
          `arn:aws:ecs:${region}:${account}:task-definition/${names.migrateFamily}:*`,
          `arn:aws:ecs:${region}:${account}:task-definition/${names.webFamily}:*`,
          `arn:aws:ecs:${region}:${account}:task-definition/${names.evolutionFamily}:*`,
        ],
        conditions: {
          ArnEquals: { 'ecs:cluster': clusterArn },
        },
      })
    );
    // DescribeTaskDefinition and RegisterTaskDefinition do not support resource-level restrictions.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsTaskDefinitions',
        actions: ['ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition', 'ecs:TagResource'],
        resources: ['*'],
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassTaskRoles',
        actions: ['iam:PassRole'],
        resources: [
          names.executionRole,
          names.webTaskRole,
          names.evolutionTaskRole,
          names.migrateTaskRole,
        ].map((roleName) => `arn:aws:iam::${account}:role/${roleName}`),
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          `arn:aws:cloudformation:${region}:${account}:stack/DevFathom-${config.stage}/*`,
        ],
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MigrationLogs',
        actions: ['logs:GetLogEvents', 'logs:DescribeLogStreams'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:/devfathom/${names.short}/*`],
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RecordDeployedTag',
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [`arn:aws:ssm:${region}:${account}:parameter${names.imageTagParameter}`],
      })
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Set this as the GitHub Actions role ARN variable for this stage.',
    });
  }
}
