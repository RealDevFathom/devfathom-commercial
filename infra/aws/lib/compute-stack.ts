import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import type { DeploySettings, EnvironmentConfig } from './config';
import { databaseSecrets } from './database-secrets';
import type { DataPlane } from './data-plane-stack';
import { resourceNames } from './names';

export interface ComputeProps {
  readonly config: EnvironmentConfig;
  readonly settings: DeploySettings;
  readonly data: DataPlane;
}

const REDIS_IMAGE = 'public.ecr.aws/docker/library/redis:7.4-alpine';

export class Compute extends Construct {
  readonly clusterName: string;
  readonly migrateTaskFamily: string;
  readonly webTaskFamily: string;
  readonly evolutionTaskFamily: string;
  readonly webServiceName: string;
  readonly evolutionServiceName: string;
  readonly appSecurityGroupId: string;
  readonly privateSubnetIds: string;
  readonly webRepositoryUri: string;
  readonly migrateRepositoryUri: string;
  readonly evolutionRepositoryUri: string;
  readonly migrateLogGroupName: string;
  readonly albDnsName: string;
  readonly albUrl: string;
  readonly certificateArn?: string;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);
    const { config, settings, data } = props;
    const names = resourceNames(config.stage);
    const removal = config.destroyEphemeralResources
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    const imageTag = new cdk.CfnParameter(this, 'ImageTag', {
      type: 'String',
      default: 'bootstrap',
      allowedPattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$',
      description:
        'Immutable ECR tag for web, migrate, and evolution. Pass the live tag on every cdk deploy of this stack or the service image resets. infra/aws/scripts/deploy-compute.sh reads the SSM tag CI publishes.',
    });
    imageTag.overrideLogicalId('ImageTag');

    const webRepo = this.repository('WebRepo', names.webRepo, removal, config.destroyEphemeralResources);
    const migrateRepo = this.repository(
      'MigrateRepo',
      names.migrateRepo,
      removal,
      config.destroyEphemeralResources
    );
    const evolutionRepo = this.repository(
      'EvolutionRepo',
      names.evolutionRepo,
      removal,
      config.destroyEphemeralResources
    );

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: names.cluster,
      vpc: data.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: names.executionRole,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pulls ECR images, writes CloudWatch logs, and reads task secrets.',
    });
    for (const secret of [
      data.databaseSecret,
      data.authSecret,
      data.platformEncryptionSecret,
      data.cronSecret,
      data.evolutionApiKeySecret,
    ]) {
      secret.grantRead(executionRole);
    }

    const webTaskRole = new iam.Role(this, 'WebTaskRole', {
      roleName: names.webTaskRole,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Lets the web task read and write the private uploads bucket.',
    });
    data.uploadsBucket.grantReadWrite(webTaskRole);

    const evolutionTaskRole = new iam.Role(this, 'EvolutionTaskRole', {
      roleName: names.evolutionTaskRole,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Evolution task role. No AWS API access until a feature needs it.',
    });
    const migrateTaskRole = new iam.Role(this, 'MigrateTaskRole', {
      roleName: names.migrateTaskRole,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Migration task role. Database access is via the injected secret, not AWS APIs.',
    });

    const appSecurityGroup = data.appSecurityGroup;
    const evolutionSecurityGroup = data.evolutionSecurityGroup;

    const webLogs = this.taskLogGroup('WebLogs', `/devfathom/${names.short}/web`, config);
    const migrateLogs = this.taskLogGroup('MigrateLogs', `/devfathom/${names.short}/migrate`, config);
    const evolutionLogs = this.taskLogGroup(
      'EvolutionLogs',
      `/devfathom/${names.short}/evolution`,
      config
    );

    const runtimePlatform: ecs.RuntimePlatform = {
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    const migrateTask = new ecs.FargateTaskDefinition(this, 'MigrateTask', {
      family: names.migrateFamily,
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole: migrateTaskRole,
      runtimePlatform,
    });
    migrateTask.addContainer('migrate', {
      image: ecs.ContainerImage.fromEcrRepository(migrateRepo, imageTag.valueAsString),
      essential: true,
      user: 'bun',
      command: ['bunx', 'prisma', 'migrate', 'deploy'],
      environment: { PREPARE_EVOLUTION_DATABASE: 'true' },
      secrets: databaseSecrets(data.databaseSecret),
      logging: ecs.LogDrivers.awsLogs({ logGroup: migrateLogs, streamPrefix: 'migrate' }),
    });

    const webTask = new ecs.FargateTaskDefinition(this, 'WebTask', {
      family: names.webFamily,
      cpu: config.webCpu,
      memoryLimitMiB: config.webMemoryMiB,
      executionRole,
      taskRole: webTaskRole,
      runtimePlatform,
    });
    webTask.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(webRepo, imageTag.valueAsString),
      essential: true,
      user: 'bun',
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        AUTH_TRUST_HOST: 'true',
        AUTH_URL: config.appUrl,
        NEXT_PUBLIC_APP_URL: config.appUrl,
        PLATFORM_BASE_DOMAIN: config.baseDomain,
        EMAIL_DELIVERY_MODE: 'capture',
        UPLOADS_BUCKET: data.uploadsBucket.bucketName,
        UPLOADS_PREFIX: 'uploads',
        AWS_REGION: cdk.Stack.of(this).region,
        EVOLUTION_BASE_URL: 'http://evolution.devfathom.local:8080',
      },
      secrets: {
        ...databaseSecrets(data.databaseSecret),
        AUTH_SECRET: ecs.Secret.fromSecretsManager(data.authSecret),
        PLATFORM_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(data.platformEncryptionSecret),
        CRON_SECRET: ecs.Secret.fromSecretsManager(data.cronSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: webLogs, streamPrefix: 'web' }),
      stopTimeout: cdk.Duration.seconds(30),
      healthCheck: {
        command: [
          'CMD-SHELL',
          "bun -e \"const r=await fetch('http://127.0.0.1:3000/api/health'); process.exit(r.ok?0:1)\"",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    const evolutionTask = new ecs.FargateTaskDefinition(this, 'EvolutionTask', {
      family: names.evolutionFamily,
      cpu: config.evolutionCpu,
      memoryLimitMiB: config.evolutionMemoryMiB,
      executionRole,
      taskRole: evolutionTaskRole,
      runtimePlatform,
    });
    const redis = evolutionTask.addContainer('redis', {
      image: ecs.ContainerImage.fromRegistry(REDIS_IMAGE),
      essential: true,
      command: ['redis-server', '--save', '', '--appendonly', 'no'],
      logging: ecs.LogDrivers.awsLogs({ logGroup: evolutionLogs, streamPrefix: 'redis' }),
      healthCheck: {
        command: ['CMD', 'redis-cli', 'ping'],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(5),
      },
    });
    const evolution = evolutionTask.addContainer('evolution', {
      image: ecs.ContainerImage.fromEcrRepository(evolutionRepo, imageTag.valueAsString),
      essential: true,
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      environment: {
        DATABASE_PROVIDER: 'postgresql',
        SERVER_PORT: '8080',
        SERVER_URL: 'http://evolution.devfathom.local:8080',
        CACHE_REDIS_ENABLED: 'true',
        CACHE_REDIS_URI: 'redis://127.0.0.1:6379',
        CACHE_REDIS_PREFIX_KEY: 'evolution',
        LOG_LEVEL: 'ERROR,WARN,INFO',
        LANGUAGE: 'en',
        RDS_CA_BUNDLE: '/etc/ssl/rds-global-bundle.pem',
      },
      secrets: {
        ...databaseSecrets(data.databaseSecret),
        AUTHENTICATION_API_KEY: ecs.Secret.fromSecretsManager(data.evolutionApiKeySecret),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: evolutionLogs, streamPrefix: 'evolution' }),
      stopTimeout: cdk.Duration.seconds(20),
      healthCheck: {
        command: [
          'CMD-SHELL',
          "node -e \"fetch('http://127.0.0.1:8080/').then(()=>process.exit(0)).catch(()=>process.exit(1))\"",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(40),
      },
    });
    evolution.addContainerDependencies({
      container: redis,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    const privateSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };
    const webService = new ecs.FargateService(this, 'WebService', {
      serviceName: names.webService,
      cluster,
      taskDefinition: webTask,
      desiredCount: config.webDesiredCount,
      securityGroups: [appSecurityGroup],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      enableExecuteCommand: false,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });
    const scaling = webService.autoScaleTaskCount({
      minCapacity: config.webMinCapacity,
      maxCapacity: config.webMaxCapacity,
    });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: 'devfathom.local',
      vpc: data.vpc,
      description: 'Private service discovery for DevFathom tasks',
    });
    new ecs.FargateService(this, 'EvolutionService', {
      serviceName: names.evolutionService,
      cluster,
      taskDefinition: evolutionTask,
      desiredCount: 1,
      securityGroups: [evolutionSecurityGroup],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      healthCheckGracePeriod: cdk.Duration.seconds(90),
      enableExecuteCommand: false,
      cloudMapOptions: {
        name: 'evolution',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: data.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
      http2Enabled: true,
    });
    alb.logAccessLogs(data.accessLogsBucket, 'alb');

    const target: elbv2.AddApplicationTargetsProps = {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/api/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    };

    let targetGroup: elbv2.ApplicationTargetGroup;
    if (settings.enableTls) {
      const zone =
        settings.hostedZoneId && settings.hostedZoneName
          ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
              hostedZoneId: settings.hostedZoneId,
              zoneName: settings.hostedZoneName,
            })
          : undefined;
      const certificate = new acm.Certificate(this, 'Certificate', {
        domainName: config.domainName,
        subjectAlternativeNames: [...config.additionalDomains],
        validation: zone
          ? acm.CertificateValidation.fromDns(zone)
          : acm.CertificateValidation.fromDns(),
      });
      alb.addListener('Http', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
      const https = alb.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      });
      targetGroup = https.addTargets('Web', target);
      this.certificateArn = certificate.certificateArn;
    } else {
      const http = alb.addListener('Http', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });
      targetGroup = http.addTargets('Web', target);
    }

    const alarmTopic = new sns.Topic(this, 'Alarms', {
      displayName: `DevFathom ${config.stage} alarms`,
      enforceSSL: true,
    });
    if (settings.alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(settings.alarmEmail));
    }

    const alarms = [
      targetGroup.metrics
        .httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: cdk.Duration.minutes(5) })
        .createAlarm(this, 'Target5xx', {
          alarmDescription: 'Web targets returned 5xx responses.',
          threshold: 5,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      targetGroup.metrics.unhealthyHostCount({ period: cdk.Duration.minutes(1) }).createAlarm(this, 'UnhealthyHosts', {
        alarmDescription: 'At least one web target is unhealthy.',
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      webService.metricCpuUtilization({ period: cdk.Duration.minutes(5) }).createAlarm(this, 'WebCpu', {
        alarmDescription: 'Web service CPU is high.',
        threshold: 80,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      data.database.metricCPUUtilization({ period: cdk.Duration.minutes(5) }).createAlarm(this, 'DbCpu', {
        alarmDescription: 'Postgres CPU is high.',
        threshold: 80,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      data.database.metricFreeStorageSpace({ period: cdk.Duration.minutes(5) }).createAlarm(this, 'DbStorage', {
        alarmDescription: 'Postgres free storage is low.',
        threshold: config.rdsFreeStorageAlarmBytes,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      data.database.metricDatabaseConnections({ period: cdk.Duration.minutes(5) }).createAlarm(this, 'DbConnections', {
        alarmDescription: 'Postgres connection count is high for this instance size.',
        threshold: config.rdsConnectionAlarm,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    }

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: names.prefix,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Web CPU and target 5xx',
            left: [webService.metricCpuUtilization()],
            right: [targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT)],
          }),
          new cloudwatch.GraphWidget({
            title: 'Postgres CPU and connections',
            left: [data.database.metricCPUUtilization()],
            right: [data.database.metricDatabaseConnections()],
          }),
        ],
      ],
    });

    const scheme = settings.enableTls ? 'https' : 'http';
    this.clusterName = cluster.clusterName;
    this.migrateTaskFamily = migrateTask.family;
    this.webTaskFamily = webTask.family;
    this.evolutionTaskFamily = evolutionTask.family;
    this.webServiceName = names.webService;
    this.evolutionServiceName = names.evolutionService;
    this.appSecurityGroupId = appSecurityGroup.securityGroupId;
    this.privateSubnetIds = cdk.Fn.join(
      ',',
      data.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds
    );
    this.webRepositoryUri = webRepo.repositoryUri;
    this.migrateRepositoryUri = migrateRepo.repositoryUri;
    this.evolutionRepositoryUri = evolutionRepo.repositoryUri;
    this.migrateLogGroupName = migrateLogs.logGroupName;
    this.albDnsName = alb.loadBalancerDnsName;
    this.albUrl = `${scheme}://${alb.loadBalancerDnsName}`;
  }

  private repository(
    id: string,
    repositoryName: string,
    removalPolicy: cdk.RemovalPolicy,
    emptyOnDelete: boolean
  ): ecr.Repository {
    return new ecr.Repository(this, id, {
      repositoryName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy,
      emptyOnDelete,
      lifecycleRules: [{ description: 'Keep the newest 30 images', maxImageCount: 30 }],
    });
  }

  private taskLogGroup(id: string, logGroupName: string, config: EnvironmentConfig): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName,
      retention: config.logRetention,
      removalPolicy: config.logRemovalPolicy,
    });
  }
}
