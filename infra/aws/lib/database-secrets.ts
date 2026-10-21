import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/** ECS secret mappings for the JSON keys in an RDS-managed secret. */
export function databaseSecrets(secret: secretsmanager.ISecret): { [key: string]: ecs.Secret } {
  return {
    DB_USERNAME: ecs.Secret.fromSecretsManager(secret, 'username'),
    DB_PASSWORD: ecs.Secret.fromSecretsManager(secret, 'password'),
    DB_HOST: ecs.Secret.fromSecretsManager(secret, 'host'),
    DB_PORT: ecs.Secret.fromSecretsManager(secret, 'port'),
    DB_NAME: ecs.Secret.fromSecretsManager(secret, 'dbname'),
  };
}
