import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';

export type StageName = 'staging' | 'production';

export interface EnvironmentConfig {
  readonly stage: StageName;
  readonly natGateways: number;
  readonly dbInstanceSize: ec2.InstanceSize;
  readonly dbMultiAz: boolean;
  readonly dbBackupRetentionDays: number;
  readonly dbAllocatedStorageGb: number;
  readonly dbMaxAllocatedStorageGb: number;
  readonly dbDeletionProtection: boolean;
  readonly dbRemovalPolicy: cdk.RemovalPolicy;
  readonly dbPerformanceInsights: boolean;
  readonly destroyEphemeralResources: boolean;
  readonly logRetention: logs.RetentionDays;
  readonly logRemovalPolicy: cdk.RemovalPolicy;
  readonly webCpu: number;
  readonly webMemoryMiB: number;
  readonly webDesiredCount: number;
  readonly webMinCapacity: number;
  readonly webMaxCapacity: number;
  readonly evolutionCpu: number;
  readonly evolutionMemoryMiB: number;
  readonly domainName: string;
  readonly additionalDomains: readonly string[];
  readonly baseDomain: string;
  readonly appUrl: string;
  readonly accessLogExpirationDays: number;
  readonly rdsFreeStorageAlarmBytes: number;
  readonly rdsConnectionAlarm: number;
}

export interface DeploySettings {
  readonly githubRepo: string;
  readonly enableTls: boolean;
  readonly createOidcProvider: boolean;
  readonly alarmEmail?: string;
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
}

export function environmentConfig(stage: StageName): EnvironmentConfig {
  if (stage === 'production') {
    return {
      stage,
      natGateways: 2,
      dbInstanceSize: ec2.InstanceSize.SMALL,
      dbMultiAz: true,
      dbBackupRetentionDays: 14,
      dbAllocatedStorageGb: 50,
      dbMaxAllocatedStorageGb: 200,
      dbDeletionProtection: true,
      dbRemovalPolicy: cdk.RemovalPolicy.RETAIN,
      dbPerformanceInsights: true,
      destroyEphemeralResources: false,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      logRemovalPolicy: cdk.RemovalPolicy.RETAIN,
      webCpu: 1024,
      webMemoryMiB: 2048,
      webDesiredCount: 2,
      webMinCapacity: 2,
      webMaxCapacity: 4,
      evolutionCpu: 512,
      evolutionMemoryMiB: 2048,
      domainName: 'www.devfathom.com',
      additionalDomains: ['admin.devfathom.com'],
      baseDomain: 'devfathom.com',
      appUrl: 'https://www.devfathom.com',
      accessLogExpirationDays: 90,
      rdsFreeStorageAlarmBytes: 5 * 1024 * 1024 * 1024,
      rdsConnectionAlarm: 120,
    };
  }

  return {
    stage: 'staging',
    natGateways: 1,
    dbInstanceSize: ec2.InstanceSize.MICRO,
    dbMultiAz: false,
    dbBackupRetentionDays: 7,
    dbAllocatedStorageGb: 20,
    dbMaxAllocatedStorageGb: 100,
    dbDeletionProtection: false,
    dbRemovalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    dbPerformanceInsights: false,
    destroyEphemeralResources: true,
    logRetention: logs.RetentionDays.ONE_MONTH,
    logRemovalPolicy: cdk.RemovalPolicy.DESTROY,
    webCpu: 512,
    webMemoryMiB: 1024,
    webDesiredCount: 1,
    webMinCapacity: 1,
    webMaxCapacity: 2,
    evolutionCpu: 512,
    evolutionMemoryMiB: 2048,
    domainName: 'staging.devfathom.com',
    additionalDomains: ['admin.staging.devfathom.com'],
    baseDomain: 'staging.devfathom.com',
    appUrl: 'https://staging.devfathom.com',
    accessLogExpirationDays: 30,
    rdsFreeStorageAlarmBytes: 2 * 1024 * 1024 * 1024,
    rdsConnectionAlarm: 60,
  };
}

export function readStage(app: cdk.App): StageName {
  const value: unknown = app.node.tryGetContext('stage') ?? 'staging';
  if (value !== 'staging' && value !== 'production') {
    throw new Error('Context "stage" must be "staging" or "production".');
  }
  return value;
}

export function readSettings(app: cdk.App, stage: StageName): DeploySettings {
  const githubRepo = readString(app, 'githubRepo') ?? 'WhatTheStack1/devfathom-commercial';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    throw new Error('Context "githubRepo" must look like owner/name.');
  }

  const hostedZoneId = readString(app, 'hostedZoneId');
  const hostedZoneName = readString(app, 'hostedZoneName');
  if (Boolean(hostedZoneId) !== Boolean(hostedZoneName)) {
    throw new Error('Set both hostedZoneId and hostedZoneName, or neither.');
  }

  const alarmEmail = readString(app, 'alarmEmail');
  if (alarmEmail && !alarmEmail.includes('@')) {
    throw new Error('Context "alarmEmail" must be an email address.');
  }

  return {
    githubRepo,
    enableTls: readFlag(app, 'enableTls', true),
    // A second stack in the same account must not create the GitHub OIDC provider again.
    createOidcProvider: readFlag(app, 'createOidcProvider', stage === 'staging'),
    alarmEmail,
    hostedZoneId,
    hostedZoneName,
  };
}

function readFlag(app: cdk.App, key: string, fallback: boolean): boolean {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Context "${key}" must be true or false.`);
}

function readString(app: cdk.App, key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Context "${key}" must be a string.`);
  }
  return value;
}
