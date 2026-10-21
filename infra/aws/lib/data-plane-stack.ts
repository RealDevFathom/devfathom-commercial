import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from './config';
import { resourceNames } from './names';

export interface DataPlaneProps {
  readonly config: EnvironmentConfig;
}

export class DataPlane extends Construct {
  readonly vpc: ec2.Vpc;
  readonly database: rds.DatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly uploadsBucket: s3.Bucket;
  readonly accessLogsBucket: s3.Bucket;
  readonly authSecret: secretsmanager.Secret;
  readonly platformEncryptionSecret: secretsmanager.Secret;
  readonly cronSecret: secretsmanager.Secret;
  readonly evolutionApiKeySecret: secretsmanager.Secret;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly evolutionSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DataPlaneProps) {
    super(scope, id);
    const { config } = props;
    const names = resourceNames(config.stage);
    const ephemeral = config.destroyEphemeralResources
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    const region = cdk.Stack.of(this).region;
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: [`${region}a`, `${region}b`],
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.vpc.addGatewayEndpoint('S3', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const flowLogs = new logs.LogGroup(this, 'VpcFlowLogs', {
      logGroupName: `/devfathom/${names.short}/vpc-flow`,
      retention: config.logRetention,
      removalPolicy: config.logRemovalPolicy,
    });
    this.vpc.addFlowLog('RejectFlow', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: ephemeral,
      autoDeleteObjects: config.destroyEphemeralResources,
      lifecycleRules: [
        {
          id: 'expire-access-logs',
          enabled: true,
          expiration: cdk.Duration.days(config.accessLogExpirationDays),
        },
      ],
    });

    this.uploadsBucket = new s3.Bucket(this, 'Uploads', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: ephemeral,
      autoDeleteObjects: config.destroyEphemeralResources,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 's3/uploads/',
      lifecycleRules: [
        {
          id: 'expire-old-versions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16_13,
    });
    const parameterGroup = new rds.ParameterGroup(this, 'PostgresParameters', {
      engine,
      description: 'Require TLS for DevFathom Postgres connections.',
      parameters: { 'rds.force_ssl': '1' },
    });

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, config.dbInstanceSize),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: config.dbMultiAz,
      allocatedStorage: config.dbAllocatedStorageGb,
      maxAllocatedStorage: config.dbMaxAllocatedStorageGb,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(config.dbBackupRetentionDays),
      preferredBackupWindow: '19:30-20:30',
      preferredMaintenanceWindow: 'sun:21:00-sun:22:00',
      deletionProtection: config.dbDeletionProtection,
      removalPolicy: config.dbRemovalPolicy,
      publiclyAccessible: false,
      databaseName: 'devfathom',
      credentials: rds.Credentials.fromGeneratedSecret('devfathomadmin'),
      parameterGroup,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: config.logRetention,
      copyTagsToSnapshot: true,
      autoMinorVersionUpgrade: true,
      iamAuthentication: false,
      enablePerformanceInsights: config.dbPerformanceInsights,
      performanceInsightRetention: config.dbPerformanceInsights
        ? rds.PerformanceInsightRetention.DEFAULT
        : undefined,
    });

    const secret = this.database.secret;
    if (!secret) {
      throw new Error('RDS credentials secret was not created.');
    }
    this.databaseSecret = secret;

    this.appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc: this.vpc,
      description: 'DevFathom web and migration tasks',
      allowAllOutbound: true,
    });
    this.evolutionSecurityGroup = new ec2.SecurityGroup(this, 'EvolutionSecurityGroup', {
      vpc: this.vpc,
      description: 'Evolution API tasks',
      allowAllOutbound: true,
    });
    this.evolutionSecurityGroup.addIngressRule(
      this.appSecurityGroup,
      ec2.Port.tcp(8080),
      'Web tasks call Evolution'
    );
    this.database.connections.allowDefaultPortFrom(
      this.appSecurityGroup,
      'Web and migration tasks'
    );
    this.database.connections.allowDefaultPortFrom(
      this.evolutionSecurityGroup,
      'Evolution API'
    );

    this.authSecret = this.generatedSecret(
      'AuthSecret',
      `devfathom/${names.short}/auth-secret`,
      'Auth.js AUTH_SECRET. Generated in AWS; do not copy it into git.',
      ephemeral
    );
    this.platformEncryptionSecret = this.generatedSecret(
      'PlatformEncryptionSecret',
      `devfathom/${names.short}/platform-encryption-key`,
      'PLATFORM_ENCRYPTION_KEY. Any long random value is hashed to 32 bytes by the app.',
      ephemeral
    );
    this.cronSecret = this.generatedSecret(
      'CronSecret',
      `devfathom/${names.short}/cron-secret`,
      'Bearer token for POST /api/platform/jobs/process.',
      ephemeral
    );
    this.evolutionApiKeySecret = this.generatedSecret(
      'EvolutionApiKey',
      `devfathom/${names.short}/evolution-api-key`,
      'Evolution API AUTHENTICATION_API_KEY.',
      ephemeral
    );

    }

  private generatedSecret(
    id: string,
    secretName: string,
    description: string,
    removalPolicy: cdk.RemovalPolicy
  ): secretsmanager.Secret {
    return new secretsmanager.Secret(this, id, {
      secretName,
      description,
      removalPolicy,
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
  }
}
