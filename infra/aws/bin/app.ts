#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { environmentConfig, readSettings, readStage } from '../lib/config';
import { CicdStack } from '../lib/cicd-stack';
import { EnvironmentStack } from '../lib/environment-stack';
import { suppressAcceptedFindings } from '../lib/nag';

const app = new cdk.App();
const stage = readStage(app);
const config = environmentConfig(stage);
const settings = readSettings(app, stage);
const account = resolveAccount(app);
const region = resolveRegion(app);

pinOfflineAvailabilityZones(app, account, region);

const env = { account, region };
const description = `DevFathom ${stage} on ECS Fargate. Do not deploy from an unbootstrapped account.`;

const environment = new EnvironmentStack(app, `DevFathom-${stage}`, {
  env,
  config,
  settings,
  description,
  terminationProtection: stage === 'production',
});
const cicd = new CicdStack(app, `DevFathom-${stage}-cicd`, {
  env,
  config,
  settings,
  description,
  terminationProtection: stage === 'production',
});

cdk.Tags.of(app).add('Project', 'devfathom');
cdk.Tags.of(app).add('Stage', stage);
cdk.Tags.of(app).add('ManagedBy', 'cdk');

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
suppressAcceptedFindings(environment, cicd, config);

// VPC reads stack.availabilityZones, which looks up AZs when account and region
// are both concrete. The placeholder account used by `cdk synth` has no credentials.
function pinOfflineAvailabilityZones(app: cdk.App, account: string, region: string): void {
  if (account !== '000000000000') return;
  const key = `availability-zones:account=${account}:region=${region}`;
  if (app.node.tryGetContext(key) === undefined) {
    app.node.setContext(key, [`${region}a`, `${region}b`, `${region}c`]);
  }
}

function resolveAccount(app: cdk.App): string {
  const fromContext: unknown = app.node.tryGetContext('account');
  if (typeof fromContext === 'string' && /^\d{12}$/.test(fromContext)) return fromContext;
  const fromEnv = process.env.DEVFATHOM_AWS_ACCOUNT ?? '';
  if (/^\d{12}$/.test(fromEnv)) return fromEnv;
  // Placeholder keeps `cdk synth` offline. A real deploy must pass `-c account=123456789012`.
  return '000000000000';
}

function resolveRegion(app: cdk.App): string {
  const fromContext: unknown = app.node.tryGetContext('region');
  const requested =
    typeof fromContext === 'string' && fromContext.length > 0
      ? fromContext
      : (process.env.DEVFATHOM_AWS_REGION ?? 'ap-south-1');
  if (requested !== 'ap-south-1' && requested !== 'me-central-1') {
    throw new Error(
      `Region ${requested} is not supported. Use ap-south-1 (Mumbai) or me-central-1 (UAE).`
    );
  }
  return requested;
}
