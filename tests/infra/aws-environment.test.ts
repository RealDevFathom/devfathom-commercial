import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const cloudFormationTypes = ['Ref', 'Sub', 'GetAtt', 'FindInMap', 'If', 'Equals', 'Not', 'And', 'Condition'];
const cloudFormationSchema = yaml.DEFAULT_SCHEMA.extend(
  cloudFormationTypes.flatMap((name) => [
    new yaml.Type(`!${name}`, { kind: 'scalar', construct: (data) => ({ [name]: data }) }),
    new yaml.Type(`!${name}`, { kind: 'sequence', construct: (data) => ({ [name]: data }) }),
  ]),
);

type TemplateResource = { Properties?: Record<string, unknown> };
type Template = { Resources: Record<string, TemplateResource> };

const templatePath = fileURLToPath(new URL('../../infra/aws/environment.yaml', import.meta.url));
const template = yaml.load(readFileSync(templatePath, 'utf8'), {
  schema: cloudFormationSchema,
}) as Template;

function executionRoleSecretResources(roleName: string): unknown[] {
  const properties = template.Resources[roleName].Properties!;
  const policies = properties.Policies as Array<{
    PolicyDocument: { Statement: Array<{ Resource: unknown[] }> };
  }>;
  return policies[0].PolicyDocument.Statement[0].Resource;
}

describe('AWS environment task-secret isolation', () => {
  it('creates a current placeholder version before ECS resolves the Anthropic secret', () => {
    const secret = template.Resources.AnthropicApiKeySecret.Properties!;

    expect(secret).toMatchObject({
      GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true },
    });
    expect(secret).not.toHaveProperty('SecretString');
  });

  it('uses separate execution roles for web and migration tasks', () => {
    expect(template.Resources.WebTaskDefinition.Properties).toMatchObject({
      ExecutionRoleArn: { GetAtt: 'WebTaskExecutionRole.Arn' },
    });
    expect(template.Resources.MigrateTaskDefinition.Properties).toMatchObject({
      ExecutionRoleArn: { GetAtt: 'TaskExecutionRole.Arn' },
    });
  });

  it('does not authorize the migration execution role to read the Anthropic key', () => {
    const webSecrets = executionRoleSecretResources('WebTaskExecutionRole');
    const migrationSecrets = executionRoleSecretResources('TaskExecutionRole');

    expect(webSecrets).toContainEqual({ Ref: 'AnthropicApiKeySecret' });
    expect(migrationSecrets).not.toContainEqual({ Ref: 'AnthropicApiKeySecret' });
  });
});
