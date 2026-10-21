import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { DeploySettings, EnvironmentConfig } from './config';
import { Compute } from './compute-stack';
import { DataPlane } from './data-plane-stack';

export interface EnvironmentStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly settings: DeploySettings;
}

export class EnvironmentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EnvironmentStackProps) {
    super(scope, id, props);
    const data = new DataPlane(this, 'Data', { config: props.config });
    const compute = new Compute(this, 'Compute', {
      config: props.config,
      settings: props.settings,
      data,
    });

    this.output('UploadsBucketName', data.uploadsBucket.bucketName);
    this.output('DatabaseSecretArn', data.databaseSecret.secretArn);
    this.output('VpcId', data.vpc.vpcId);
    this.output('ClusterName', compute.clusterName);
    this.output('MigrateTaskDefinitionFamily', compute.migrateTaskFamily);
    this.output('WebTaskDefinitionFamily', compute.webTaskFamily);
    this.output('EvolutionTaskDefinitionFamily', compute.evolutionTaskFamily);
    this.output('WebServiceName', compute.webServiceName);
    this.output('EvolutionServiceName', compute.evolutionServiceName);
    this.output('AppSecurityGroupId', compute.appSecurityGroupId);
    this.output('PrivateSubnetIds', compute.privateSubnetIds);
    this.output('WebRepositoryUri', compute.webRepositoryUri);
    this.output('MigrateRepositoryUri', compute.migrateRepositoryUri);
    this.output('EvolutionRepositoryUri', compute.evolutionRepositoryUri);
    this.output('MigrateLogGroupName', compute.migrateLogGroupName);
    this.output('AlbDnsName', compute.albDnsName);
    this.output('AlbUrl', compute.albUrl);
    if (compute.certificateArn) {
      this.output('CertificateArn', compute.certificateArn);
    }
  }

  private output(name: string, value: string): void {
    new cdk.CfnOutput(this, name, { value });
  }
}
