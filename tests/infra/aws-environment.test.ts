// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { API_KEY_SECRET_ID_ENV, LOCAL_API_KEY_ENV } from '@/lib/ai/ai-credentials';
import {
  AI_TIERS,
  DEFAULT_AI_SECRETS_REGION,
  DEFAULT_BEDROCK_REGION,
  DEFAULT_MODELS,
  DEFAULT_MONTHLY_CAPS_USD,
  DEFAULT_PROVIDER_ORDER,
  ROUTED_AI_PROVIDERS,
  capEnvName,
  modelEnvName,
} from '@/lib/ai/model-defaults';

// js-yaml is present through @eslint/eslintrc but ships no type declarations, and
// @types/js-yaml is not installed. Load it untyped and describe the part used here.
type YamlTypeOptions = {
  kind: 'scalar' | 'sequence' | 'mapping';
  construct: (data: unknown) => unknown;
};
type JsYaml = {
  Type: new (tag: string, options: YamlTypeOptions) => object;
  DEFAULT_SCHEMA: { extend(types: object[]): object };
  load(source: string, options: { schema: object }): unknown;
};
const yaml = createRequire(import.meta.url)('js-yaml') as JsYaml;

const INTRINSICS = [
  'And',
  'Base64',
  'Cidr',
  'Condition',
  'Equals',
  'FindInMap',
  'GetAZs',
  'GetAtt',
  'If',
  'ImportValue',
  'Join',
  'Not',
  'Or',
  'Ref',
  'Select',
  'Split',
  'Sub',
];
const cloudFormationSchema = yaml.DEFAULT_SCHEMA.extend(
  INTRINSICS.flatMap((name) =>
    (['scalar', 'sequence', 'mapping'] as const).map(
      (kind) => new yaml.Type(`!${name}`, { kind, construct: (data) => ({ [name]: data }) })
    )
  )
);

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};
type Policy = { PolicyName: string; PolicyDocument: { Statement: Statement[] } };
type Resource = { Type: string; Condition?: string; Properties?: Record<string, unknown> };
type Parameter = {
  Type: string;
  Default?: string | number;
  AllowedValues?: string[];
  AllowedPattern?: string;
  MinValue?: number;
};
type Template = {
  Parameters: Record<string, Parameter>;
  Rules: Record<string, unknown>;
  Conditions: Record<string, unknown>;
  Resources: Record<string, Resource>;
  Outputs: Record<string, unknown>;
};
type Container = {
  Name: string;
  Environment: Array<{ Name: string; Value: unknown }>;
  Secrets?: unknown;
};

const templatePath = fileURLToPath(new URL('../../infra/aws/environment.yaml', import.meta.url));
const templateSource = readFileSync(templatePath, 'utf8');
const template = yaml.load(templateSource, { schema: cloudFormationSchema }) as Template;

// ---------------------------------------------------------------------------
// A small evaluator for the intrinsics the AI settings use, so assertions read
// as the strings CloudFormation would produce for a given set of parameters.
// ---------------------------------------------------------------------------

const ACCOUNT = '111122223333';
const NO_VALUE = Symbol('AWS::NoValue');
type Parameters = Record<string, string>;

function parametersWith(overrides: Parameters = {}): Parameters {
  const defaults = Object.fromEntries(
    Object.entries(template.Parameters).map(([name, parameter]) => [
      name,
      String(parameter.Default ?? ''),
    ])
  );
  return {
    ...defaults,
    'AWS::Partition': 'aws',
    'AWS::AccountId': ACCOUNT,
    'AWS::Region': 'ap-southeast-1',
    ...overrides,
  };
}

function condition(name: string, parameters: Parameters): boolean {
  return Boolean(render(template.Conditions[name], parameters));
}

function render(node: unknown, parameters: Parameters): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => render(item, parameters)).filter((item) => item !== NO_VALUE);
  }
  if (!node || typeof node !== 'object') return node;
  const entries = Object.entries(node as Record<string, unknown>);
  if (entries.length === 1) {
    const [[name, argument]] = entries;
    const args = argument as unknown[];
    switch (name) {
      case 'Ref': {
        const ref = argument as string;
        if (ref === 'AWS::NoValue') return NO_VALUE;
        return ref in parameters ? parameters[ref] : `<${ref}>`;
      }
      case 'GetAtt':
        return `<${Array.isArray(argument) ? argument.join('.') : String(argument)}>`;
      case 'Sub': {
        const [text, variables] =
          typeof argument === 'string' ? [argument, {}] : (args as [string, object]);
        const values = render(variables, parameters) as Record<string, unknown>;
        return text.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
          if (key.startsWith('!')) return `\${${key.slice(1)}}`;
          if (key in values) return String(values[key]);
          return key in parameters ? parameters[key] : `<${key}>`;
        });
      }
      case 'Select':
        return (render(args[1], parameters) as unknown[])[Number(args[0])];
      case 'Split':
        return String(render(args[1], parameters)).split(String(args[0]));
      case 'Join':
        return (render(args[1], parameters) as unknown[]).join(String(args[0]));
      case 'If':
        return render(condition(args[0] as string, parameters) ? args[1] : args[2], parameters);
      case 'Equals':
        return render(args[0], parameters) === render(args[1], parameters);
      case 'Not':
        return !render(args[0], parameters);
      case 'And':
        return args.every((item) => render(item, parameters));
      case 'Or':
        return args.some((item) => render(item, parameters));
      case 'Condition':
        return condition(argument as string, parameters);
    }
  }
  return Object.fromEntries(
    entries
      .map(([key, value]) => [key, render(value, parameters)] as const)
      .filter(([, value]) => value !== NO_VALUE)
  );
}

function container(taskDefinition: string, overrides?: Parameters): Container {
  const properties = render(
    template.Resources[taskDefinition].Properties,
    parametersWith(overrides)
  ) as { ContainerDefinitions: Container[] };
  return properties.ContainerDefinitions[0];
}

function environmentOf(taskDefinition: string, overrides?: Parameters): Record<string, unknown> {
  return Object.fromEntries(
    container(taskDefinition, overrides).Environment.map(({ Name, Value }) => [Name, Value])
  );
}

function policiesOf(role: string, overrides?: Parameters): Policy[] {
  const properties = render(template.Resources[role].Properties, parametersWith(overrides)) as {
    Policies?: Policy[];
  };
  return properties.Policies ?? [];
}

function statementsOf(role: string, overrides?: Parameters): Statement[] {
  return policiesOf(role, overrides).flatMap((policy) => policy.PolicyDocument.Statement);
}

const actionsOf = (statement: Statement) =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];
const resourcesOf = (statement: Statement) =>
  (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]) as string[];

const BEDROCK_ACTIONS = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];
const US_PROFILE_DESTINATIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
const BEDROCK_PARAMETERS = {
  cheap: 'AiBedrockCheapModelId',
  standard: 'AiBedrockStandardModelId',
  deep: 'AiBedrockDeepModelId',
} as const;
const CAP_PARAMETERS = {
  anthropic: 'AiAnthropicMonthlyCapUsd',
  openai: 'AiOpenAiMonthlyCapUsd',
  bedrock: 'AiBedrockMonthlyCapUsd',
} as const;

const profileArn = (profile: string) =>
  `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/${profile}`;
const secretArn = (name: string, region = 'ap-southeast-1') =>
  `arn:aws:secretsmanager:${region}:${ACCOUNT}:secret:${name}-??????`;

describe('AWS environment: AI provider keys stay out of the stack', () => {
  it('creates no AI provider secret and exports none', () => {
    const secretNames = Object.values(template.Resources)
      .filter((resource) => resource.Type === 'AWS::SecretsManager::Secret')
      .map((resource) => JSON.stringify(resource.Properties?.Name));

    expect(template.Resources).not.toHaveProperty('AnthropicApiKeySecret');
    expect(secretNames.filter((name) => /anthropic|openai|api-key/i.test(name))).toEqual([]);
    expect(template.Outputs).not.toHaveProperty('AnthropicApiKeySecretName');
  });

  it('never injects a key value into a container', () => {
    for (const taskDefinition of ['WebTaskDefinition', 'MigrateTaskDefinition']) {
      for (const mode of ['seed', 'migrate']) {
        const definition = container(taskDefinition, { MigrationMode: mode });
        const names = [
          ...definition.Environment.map(({ Name }) => Name),
          ...((definition.Secrets ?? []) as Array<{ Name: string }>).map(({ Name }) => Name),
        ];
        for (const keyEnv of Object.values(LOCAL_API_KEY_ENV)) expect(names).not.toContain(keyEnv);
      }
    }
  });

  it('keeps separate execution roles, and neither can read an AI provider key', () => {
    expect(template.Resources.WebTaskDefinition.Properties).toMatchObject({
      ExecutionRoleArn: { GetAtt: 'WebTaskExecutionRole.Arn' },
    });
    expect(template.Resources.MigrateTaskDefinition.Properties).toMatchObject({
      ExecutionRoleArn: { GetAtt: 'TaskExecutionRole.Arn' },
    });
    for (const role of ['WebTaskExecutionRole', 'TaskExecutionRole']) {
      expect(JSON.stringify(template.Resources[role])).not.toMatch(/anthropic|openai|api-key/i);
    }
  });

  it('gives the migration task no AI settings and no permissions', () => {
    const migrateEnvironment = Object.keys(environmentOf('MigrateTaskDefinition'));
    expect(
      migrateEnvironment.filter((name) => /^(AI_|BEDROCK_|ANTHROPIC|OPENAI)/.test(name))
    ).toEqual([]);
    expect(template.Resources.MigrateTaskRole.Properties).not.toHaveProperty('Policies');
  });
});

describe('AWS environment: web container AI contract', () => {
  it('passes secret ids, never values, with environment-derived defaults', () => {
    for (const environment of ['staging', 'production']) {
      const env = environmentOf('WebTaskDefinition', { EnvironmentName: environment });
      expect(env[API_KEY_SECRET_ID_ENV.anthropic]).toBe(
        `devfathom/${environment}/anthropic-api-key`
      );
      expect(env[API_KEY_SECRET_ID_ENV.openai]).toBe(`devfathom/${environment}/openai-api-key`);
      expect(env.AI_SECRETS_REGION).toBe(DEFAULT_AI_SECRETS_REGION);
    }
    expect(DEFAULT_AI_SECRETS_REGION).toBe('ap-southeast-1');
  });

  it('uses a named secret when one is given', () => {
    const env = environmentOf('WebTaskDefinition', {
      AnthropicApiKeySecretId: 'team/anthropic',
      OpenAiApiKeySecretId: 'team/openai',
    });
    expect(env.ANTHROPIC_API_KEY_SECRET_ID).toBe('team/anthropic');
    expect(env.OPENAI_API_KEY_SECRET_ID).toBe('team/openai');
  });

  it('routes through the chain by default with the code-default order, models and caps', () => {
    const env = environmentOf('WebTaskDefinition');

    expect(env.AI_PROVIDER).toBe('auto');
    expect(env.AI_PROVIDER_ORDER).toBe(DEFAULT_PROVIDER_ORDER.join(','));
    expect(env.BEDROCK_REGION).toBe(DEFAULT_BEDROCK_REGION);
    expect(DEFAULT_BEDROCK_REGION).toBe('us-east-1');
    for (const tier of AI_TIERS) {
      expect(env[modelEnvName('bedrock', tier)]).toBe(DEFAULT_MODELS.bedrock[tier]);
    }
    for (const provider of ROUTED_AI_PROVIDERS) {
      expect(Number(env[capEnvName(provider)])).toBe(DEFAULT_MONTHLY_CAPS_USD[provider]);
    }
    expect(DEFAULT_MONTHLY_CAPS_USD).toEqual({ anthropic: 190, openai: 190, bedrock: 300 });
  });

  it('drops the superseded Bedrock pin and never configures Azure', () => {
    const names = Object.keys(environmentOf('WebTaskDefinition'));

    expect(names).not.toContain('AI_BEDROCK_REGION');
    expect(names.filter((name) => /_(HAIKU|SONNET|OPUS)_MODEL_ID$/.test(name))).toEqual([]);
    expect(names.filter((name) => name.startsWith('AZURE_'))).toEqual([]);
    expect(names).not.toContain('AI_MODEL');
    expect(templateSource).not.toMatch(/apac\.|ap-southeast-1::foundation-model/);
  });
});

describe('AWS environment: AI parameters', () => {
  it('defaults AI_PROVIDER to the routed chain and offers no legacy provider', () => {
    const parameter = template.Parameters.AiProvider;

    expect(parameter.Default).toBe('auto');
    expect(parameter.AllowedValues).toEqual(
      expect.arrayContaining(['auto', 'anthropic', 'openai', 'bedrock', 'disabled'])
    );
    for (const legacy of ['azure', 'groq', 'google', 'vertex']) {
      expect(parameter.AllowedValues).not.toContain(legacy);
    }
  });

  it('accepts only routed providers in the fallback order', () => {
    const pattern = new RegExp(template.Parameters.AiProviderOrder.AllowedPattern!);

    for (const order of ['anthropic,openai,bedrock', 'bedrock', 'openai,anthropic']) {
      expect(order).toMatch(pattern);
    }
    for (const order of ['azure', 'anthropic,azure', 'anthropic,,openai', '', 'anthropic openai']) {
      expect(order).not.toMatch(pattern);
    }
  });

  it('keeps Bedrock model parameters on US profiles and caps non-negative', () => {
    for (const tier of AI_TIERS) {
      const parameter = template.Parameters[BEDROCK_PARAMETERS[tier]];
      const pattern = new RegExp(parameter.AllowedPattern!);
      expect(parameter.Default).toBe(DEFAULT_MODELS.bedrock[tier]);
      expect(DEFAULT_MODELS.bedrock[tier]).toMatch(pattern);
      expect(`apac.${DEFAULT_MODELS.anthropic[tier]}`).not.toMatch(pattern);
      expect(DEFAULT_MODELS.anthropic[tier]).not.toMatch(pattern);
    }
    for (const provider of ROUTED_AI_PROVIDERS) {
      const parameter = template.Parameters[CAP_PARAMETERS[provider]];
      expect(parameter).toMatchObject({ Type: 'Number', MinValue: 0 });
      expect(parameter.Default).toBe(DEFAULT_MONTHLY_CAPS_USD[provider]);
    }
    for (const name of ['AnthropicApiKeySecretId', 'OpenAiApiKeySecretId']) {
      const pattern = new RegExp(template.Parameters[name].AllowedPattern!);
      expect('').toMatch(pattern);
      expect('devfathom/staging/openai-api-key').toMatch(pattern);
      // A name only: an ARN or a wildcard would widen or break the IAM resource.
      expect('arn:aws:secretsmanager:ap-southeast-1:1:secret:x').not.toMatch(pattern);
      expect('devfathom/*').not.toMatch(pattern);
    }
  });

  it('no longer restricts the stack region; the staging and production rules remain', () => {
    expect(template.Rules).not.toHaveProperty('SingaporeOnly');
    expect(template.Rules).toHaveProperty('SeedOnlyInStaging');
    expect(template.Rules).toHaveProperty('BootstrapOnlyInProduction');
  });
});

describe('AWS environment: web task role least privilege', () => {
  it('reads exactly the two named key secrets in the secrets region', () => {
    const statements = statementsOf('WebTaskRole').filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('secretsmanager:'))
    );

    expect(statements).toHaveLength(1);
    expect(actionsOf(statements[0])).toEqual(['secretsmanager:GetSecretValue']);
    expect(statements[0].Condition).toBeUndefined();
    expect(resourcesOf(statements[0])).toEqual([
      secretArn('devfathom/staging/anthropic-api-key'),
      secretArn('devfathom/staging/openai-api-key'),
    ]);
  });

  it('follows the secret ids and region the container is given', () => {
    const overrides = {
      EnvironmentName: 'production',
      OpenAiApiKeySecretId: 'team/openai',
      AiSecretsRegion: 'eu-west-1',
    };
    const [statement] = statementsOf('WebTaskRole', overrides).filter(
      (candidate) => candidate.Sid === 'ReadAIProviderKeys'
    );
    const env = environmentOf('WebTaskDefinition', overrides);

    expect(resourcesOf(statement)).toEqual([
      secretArn(String(env.ANTHROPIC_API_KEY_SECRET_ID), 'eu-west-1'),
      secretArn(String(env.OPENAI_API_KEY_SECRET_ID), 'eu-west-1'),
    ]);
    expect(env.ANTHROPIC_API_KEY_SECRET_ID).toBe('devfathom/production/anthropic-api-key');
    expect(env.AI_SECRETS_REGION).toBe('eu-west-1');
  });

  it('invokes Bedrock only through the three US profiles from us-east-1', () => {
    const statements = statementsOf('WebTaskRole').filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('bedrock:'))
    );
    const profiles = AI_TIERS.map((tier) => profileArn(DEFAULT_MODELS.bedrock[tier]));
    const foundationModels = AI_TIERS.flatMap((tier) =>
      US_PROFILE_DESTINATIONS.map(
        (region) =>
          `arn:aws:bedrock:${region}::foundation-model/${DEFAULT_MODELS.bedrock[tier].replace(/^us\./, '')}`
      )
    );

    expect(statements).toHaveLength(2);
    for (const statement of statements) expect(actionsOf(statement)).toEqual(BEDROCK_ACTIONS);

    const [profileStatement, modelStatement] = statements;
    expect(resourcesOf(profileStatement)).toEqual(profiles);
    expect(profileStatement.Condition).toBeUndefined();
    expect(resourcesOf(modelStatement)).toEqual(foundationModels);
    expect(modelStatement.Condition).toEqual({
      StringEquals: { 'bedrock:InferenceProfileArn': profiles },
    });
    expect(foundationModels).toContain(
      'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-5-5'
    );
  });

  it('follows the Bedrock model parameters into the policy and the container', () => {
    const overrides = { AiBedrockDeepModelId: 'us.anthropic.claude-opus-9-9-v1:0' };
    const env = environmentOf('WebTaskDefinition', overrides);
    const statements = statementsOf('WebTaskRole', overrides).filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('bedrock:'))
    );

    expect(env.AI_BEDROCK_MODEL_DEEP).toBe('us.anthropic.claude-opus-9-9-v1:0');
    expect(resourcesOf(statements[0])).toContain(profileArn('us.anthropic.claude-opus-9-9-v1:0'));
    expect(resourcesOf(statements[1])).toEqual(
      expect.arrayContaining(
        US_PROFILE_DESTINATIONS.map(
          (region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-opus-9-9-v1:0`
        )
      )
    );
  });

  it('grants nothing broader: no wildcard actions, no wildcard resources, no Converse action', () => {
    const aiStatements = statementsOf('WebTaskRole').filter((statement) =>
      actionsOf(statement).some((action) => /^(bedrock|secretsmanager):/.test(action))
    );
    expect(aiStatements).toHaveLength(3);
    for (const statement of aiStatements) {
      expect(statement.Effect).toBe('Allow');
      for (const action of actionsOf(statement)) {
        expect(action).not.toContain('*');
        expect(action).not.toMatch(/Converse/);
      }
      for (const resource of resourcesOf(statement)) {
        expect(resource.replace(/-\?{6}$/, '')).not.toMatch(/[*?]/);
      }
    }
  });
});
