// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { API_KEY_SECRET_ID_ENV, LOCAL_API_KEY_ENV } from '@/lib/ai/ai-credentials';
import {
  AI_TIERS,
  DEFAULT_AI_SECRETS_REGION,
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
  Command?: unknown[];
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
// The decided Bedrock fallback: global cross-Region profiles called from Singapore.
// The deep tier uses the standard model on Bedrock.
const BEDROCK_SOURCE_REGION = 'ap-southeast-1';
const BEDROCK_GLOBAL_PROFILES = {
  cheap: 'global.anthropic.claude-haiku-5-5',
  standard: 'global.anthropic.claude-sonnet-5-5',
  deep: 'global.anthropic.claude-sonnet-5-5',
} as const;
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

  it('defaults AI off in production and to the routed chain in staging', () => {
    expect(environmentOf('WebTaskDefinition', { EnvironmentName: 'production' }).AI_PROVIDER).toBe(
      'disabled'
    );
    expect(environmentOf('WebTaskDefinition', { EnvironmentName: 'staging' }).AI_PROVIDER).toBe(
      'auto'
    );
  });

  it('passes an explicit AiProvider through in either environment', () => {
    for (const environment of ['staging', 'production']) {
      for (const provider of ['auto', 'anthropic', 'openai', 'bedrock', 'disabled']) {
        const env = environmentOf('WebTaskDefinition', {
          EnvironmentName: environment,
          AiProvider: provider,
        });
        expect(env.AI_PROVIDER).toBe(provider);
      }
    }
  });

  it('uses the code-default order and caps, Bedrock from Singapore and the small model off', () => {
    const env = environmentOf('WebTaskDefinition');

    expect(env.AI_PROVIDER_ORDER).toBe(DEFAULT_PROVIDER_ORDER.join(','));
    expect(env.BEDROCK_REGION).toBe(BEDROCK_SOURCE_REGION);
    for (const tier of AI_TIERS) {
      expect(env[modelEnvName('bedrock', tier)]).toBe(BEDROCK_GLOBAL_PROFILES[tier]);
    }
    expect(env.AF_HAIKU_LOOKUPS).toBe('false');
    for (const provider of ROUTED_AI_PROVIDERS) {
      expect(Number(env[capEnvName(provider)])).toBe(DEFAULT_MONTHLY_CAPS_USD[provider]);
    }
    expect(DEFAULT_MONTHLY_CAPS_USD).toEqual({ anthropic: 190, openai: 190, bedrock: 300 });
  });

  it('follows the Bedrock region, model and small-model parameters into the container', () => {
    const env = environmentOf('WebTaskDefinition', {
      AiBedrockRegion: 'eu-central-1',
      AiBedrockDeepModelId: 'eu.anthropic.claude-opus-9-9-v1:0',
      AiHaikuLookups: 'true',
    });

    expect(env.BEDROCK_REGION).toBe('eu-central-1');
    expect(env.AI_BEDROCK_MODEL_DEEP).toBe('eu.anthropic.claude-opus-9-9-v1:0');
    expect(env.AF_HAIKU_LOOKUPS).toBe('true');
  });

  it('drops the superseded Bedrock pin and never configures Azure', () => {
    const names = Object.keys(environmentOf('WebTaskDefinition'));

    expect(names).not.toContain('AI_BEDROCK_REGION');
    expect(names.filter((name) => /_(HAIKU|SONNET|OPUS)_MODEL_ID$/.test(name))).toEqual([]);
    expect(names.filter((name) => name.startsWith('AZURE_'))).toEqual([]);
    expect(names).not.toContain('AI_MODEL');
    expect(templateSource).not.toMatch(/us-east-1|us\.anthropic\.|claude-[a-z]+-4-/);
  });
});

describe('AWS environment: AI parameters', () => {
  it('defaults AI_PROVIDER to the environment default and offers no legacy provider', () => {
    const parameter = template.Parameters.AiProvider;

    expect(parameter.Default).toBe('');
    expect(parameter.AllowedValues).toEqual([
      '',
      'auto',
      'anthropic',
      'openai',
      'bedrock',
      'disabled',
    ]);
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

  it('defaults Bedrock to the global profiles from Singapore, the small model off, caps non-negative', () => {
    expect(template.Parameters.AiBedrockRegion.Default).toBe(BEDROCK_SOURCE_REGION);
    expect(BEDROCK_SOURCE_REGION).toMatch(
      new RegExp(template.Parameters.AiBedrockRegion.AllowedPattern!)
    );
    expect(template.Parameters.AiHaikuLookups).toMatchObject({
      Default: 'false',
      AllowedValues: ['true', 'false'],
    });
    for (const tier of AI_TIERS) {
      const parameter = template.Parameters[BEDROCK_PARAMETERS[tier]];
      const pattern = new RegExp(parameter.AllowedPattern!);
      expect(parameter.Default).toBe(BEDROCK_GLOBAL_PROFILES[tier]);
      for (const geo of ['global', 'us', 'eu', 'apac', 'au', 'jp']) {
        expect(`${geo}.${DEFAULT_MODELS.anthropic[tier]}`).not.toMatch(pattern);
        expect(`${geo}.anthropic.claude-sonnet-5-5`).toMatch(pattern);
      }
      expect(DEFAULT_MODELS.anthropic[tier]).not.toMatch(pattern);
      expect('anthropic.claude-sonnet-5-5').not.toMatch(pattern);
      expect('global.openai.gpt-6-sol').not.toMatch(pattern);
      expect('ca.anthropic.claude-haiku-5-5').not.toMatch(pattern);
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

  it('invokes every Anthropic Claude model and profile, including global profiles', () => {
    const statements = statementsOf('WebTaskRole').filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('bedrock:'))
    );

    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement.Effect).toBe('Allow');
      expect(actionsOf(statement)).toEqual(BEDROCK_ACTIONS);
    }

    const [profiles, regionalModels, globalModels] = statements;
    expect(resourcesOf(profiles)).toEqual([
      `arn:aws:bedrock:*:${ACCOUNT}:inference-profile/*anthropic.claude-*`,
    ]);
    expect(profiles.Condition).toBeUndefined();
    expect(resourcesOf(regionalModels)).toEqual([
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
    ]);
    expect(regionalModels.Condition).toBeUndefined();
    // AWS evaluates the Region-less global foundation-model ARN of a global
    // cross-Region profile with aws:RequestedRegion = "unspecified".
    expect(resourcesOf(globalModels)).toEqual([
      'arn:aws:bedrock:::foundation-model/anthropic.claude-*',
    ]);
    expect(globalModels.Condition).toEqual({
      StringEquals: { 'aws:RequestedRegion': 'unspecified' },
    });
  });

  it('covers the default profiles and the Singapore source Region, and nothing but Claude', () => {
    const resources = statementsOf('WebTaskRole')
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith('bedrock:')))
      .flatMap(resourcesOf);
    const matches = (arn: string) =>
      resources.some((resource) =>
        new RegExp(`^${resource.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(
          arn
        )
      );

    for (const tier of AI_TIERS) {
      const profile = BEDROCK_GLOBAL_PROFILES[tier];
      const model = profile.replace(/^global\./, '');
      expect(
        matches(`arn:aws:bedrock:${BEDROCK_SOURCE_REGION}:${ACCOUNT}:inference-profile/${profile}`)
      ).toBe(true);
      expect(matches(`arn:aws:bedrock:${BEDROCK_SOURCE_REGION}::foundation-model/${model}`)).toBe(
        true
      );
      expect(matches(`arn:aws:bedrock:::foundation-model/${model}`)).toBe(true);
    }
    expect(
      matches(`arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/global.openai.gpt-6-sol`)
    ).toBe(false);
    expect(matches('arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6-sol')).toBe(false);
    expect(matches('arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0')).toBe(false);
    expect(
      matches(
        `arn:aws:bedrock:us-east-1:999999999999:inference-profile/global.anthropic.claude-sonnet-5-5`
      )
    ).toBe(false);
  });

  it('grants nothing broader: exact actions, no Converse action, secrets without wildcards', () => {
    const aiStatements = statementsOf('WebTaskRole').filter((statement) =>
      actionsOf(statement).some((action) => /^(bedrock|secretsmanager):/.test(action))
    );
    expect(aiStatements).toHaveLength(4);
    for (const statement of aiStatements) {
      expect(statement.Effect).toBe('Allow');
      for (const action of actionsOf(statement)) {
        expect(action).not.toContain('*');
        expect(action).not.toMatch(/Converse/);
      }
      for (const resource of resourcesOf(statement)) {
        if (resource.startsWith('arn:aws:secretsmanager:')) {
          expect(resource.replace(/-\?{6}$/, '')).not.toMatch(/[*?]/);
        } else {
          expect(resource).toMatch(/anthropic\.claude-\*$/);
        }
      }
    }
    expect(JSON.stringify(template.Resources.WebTaskRole)).not.toMatch(/aws-marketplace|kms:/);
  });
});

// ---------------------------------------------------------------------------
// DEV-835 (scan finding F13): the web workload must never reach the database
// admin URL, the credential the migration task uses to deploy the schema.
// ---------------------------------------------------------------------------

const ADMIN_URL_SECRET = 'DatabaseAdminUrlSecret';
const ENVIRONMENTS = ['staging', 'production'] as const;
// Parameter sets the template accepts; seed and bootstrap are staging- and production-only.
const DEPLOYMENTS: Parameters[] = [
  ...ENVIRONMENTS.map((EnvironmentName) => ({ EnvironmentName, MigrationMode: 'migrate' })),
  { EnvironmentName: 'staging', MigrationMode: 'seed' },
  { EnvironmentName: 'production', MigrationMode: 'bootstrap' },
  {
    EnvironmentName: 'staging',
    AnthropicApiKeySecretId: 'team/anthropic',
    OpenAiApiKeySecretId: 'devfathom/staging/openai-api-key',
    AiSecretsRegion: 'ap-southeast-1',
  },
];

const secretResources = () =>
  Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === 'AWS::SecretsManager::Secret'
  );

function secretName(logicalId: string, parameters: Parameters): string {
  return String(render(template.Resources[logicalId].Properties?.Name, parametersWith(parameters)));
}

// IAM wildcards: `*` is any run of characters, `?` exactly one.
const globMatches = (pattern: string, value: string, ignoreCase = false) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    ignoreCase ? 'i' : ''
  ).test(value);

const readsSecrets = (statement: Statement) =>
  statement.Effect === 'Allow' &&
  actionsOf(statement).some((action) => globMatches(action, 'secretsmanager:GetSecretValue', true));

// Whether any statement of the role lets it read the named secret resource,
// whether through the resource itself or a wildcard ARN that matches it.
function roleCanRead(role: string, secret: string, parameters: Parameters): boolean {
  const arn = `arn:aws:secretsmanager:${parametersWith(parameters)['AWS::Region']}:${ACCOUNT}:secret:${secretName(secret, parameters)}-AbCdEf`;
  return statementsOf(role, parameters)
    .filter(readsSecrets)
    .flatMap(resourcesOf)
    .some((resource) => resource === `<${secret}>` || globMatches(String(resource), arn));
}

function rolesOf(taskDefinition: string): { execution: string; task: string } {
  const properties = template.Resources[taskDefinition].Properties as Record<
    string,
    { GetAtt: string }
  >;
  return {
    execution: properties.ExecutionRoleArn.GetAtt.replace(/\.Arn$/, ''),
    task: properties.TaskRoleArn.GetAtt.replace(/\.Arn$/, ''),
  };
}

function containerSecrets(taskDefinition: string, parameters: Parameters) {
  return (
    (container(taskDefinition, parameters).Secrets ?? []) as Array<{
      Name: string;
      ValueFrom: string;
    }>
  ).map(({ Name, ValueFrom }) => ({ Name, secret: ValueFrom.replace(/^<(\w+)>:value::$/, '$1') }));
}

describe('AWS environment: the web workload cannot read the migration credential (F13)', () => {
  const web = rolesOf('WebTaskDefinition');
  const migrate = rolesOf('MigrateTaskDefinition');

  it('gives the web and migration tasks different execution and task roles', () => {
    expect(new Set([web.execution, web.task, migrate.execution, migrate.task]).size).toBe(4);
  });

  it.each(DEPLOYMENTS)(
    'keeps the database admin URL from every web principal (%o)',
    (parameters) => {
      expect(roleCanRead(web.execution, ADMIN_URL_SECRET, parameters)).toBe(false);
      expect(roleCanRead(web.task, ADMIN_URL_SECRET, parameters)).toBe(false);
      expect(
        containerSecrets('WebTaskDefinition', parameters).map(({ secret }) => secret)
      ).not.toContain(ADMIN_URL_SECRET);
      // The web database URL is the app role's, never the admin's.
      expect(containerSecrets('WebTaskDefinition', parameters)).toContainEqual({
        Name: 'DATABASE_URL',
        secret: 'DatabaseAppUrlSecret',
      });
    }
  );

  it.each(DEPLOYMENTS)('lets the migration task deploy the schema with it (%o)', (parameters) => {
    expect(roleCanRead(migrate.execution, ADMIN_URL_SECRET, parameters)).toBe(true);
    expect(containerSecrets('MigrateTaskDefinition', parameters)).toContainEqual({
      Name: 'DATABASE_URL',
      secret: ADMIN_URL_SECRET,
    });
    const [command] = container('MigrateTaskDefinition', parameters).Command?.slice(-1) ?? [];
    expect(String(command)).toContain('bunx prisma migrate deploy');
  });

  it('lets no other role read it, and only the migration task uses the role that can', () => {
    for (const parameters of DEPLOYMENTS) {
      const readers = Object.entries(template.Resources)
        .filter(([, resource]) => resource.Type === 'AWS::IAM::Role')
        .filter(([role]) => roleCanRead(role, ADMIN_URL_SECRET, parameters))
        .map(([role]) => role);
      expect(readers).toEqual([migrate.execution]);
    }
    const usingMigrationRole = Object.entries(template.Resources)
      .filter(([, resource]) => resource.Type === 'AWS::ECS::TaskDefinition')
      .filter(([name]) => Object.values(rolesOf(name)).includes(migrate.execution))
      .map(([name]) => name);
    expect(usingMigrationRole).toEqual(['MigrateTaskDefinition']);
  });

  it('gives the web roles no way to borrow another principal or start the migration task', () => {
    for (const role of [web.execution, web.task]) {
      const actions = statementsOf(role).flatMap(actionsOf);
      expect(actions.filter((action) => /^(iam|sts|ecs|lambda):|^\*$/i.test(action))).toEqual([]);
      const managed =
        (template.Resources[role].Properties?.ManagedPolicyArns as string[] | undefined) ?? [];
      expect(managed).toEqual(
        role === web.execution
          ? ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']
          : []
      );
    }
  });

  it.each(DEPLOYMENTS)(
    'lets the web execution role read exactly the secrets the web container receives (%o)',
    (parameters) => {
      const received = containerSecrets('WebTaskDefinition', parameters).map(
        ({ secret }) => secret
      );
      const readable = secretResources()
        .map(([logicalId]) => logicalId)
        .filter((logicalId) => roleCanRead(web.execution, logicalId, parameters));
      expect(readable.sort()).toEqual([...new Set(received)].sort());
      for (const password of [
        'AdminPasswordSecret',
        'PlatformAdminPasswordSecret',
        'SeedPasswordSecret',
      ]) {
        expect(readable).not.toContain(password);
      }
    }
  );

  it('refuses this stack’s own secrets as an AI key secret id, so the web task role cannot reach them', () => {
    for (const parameter of ['AnthropicApiKeySecretId', 'OpenAiApiKeySecretId']) {
      const pattern = new RegExp(template.Parameters[parameter].AllowedPattern ?? '');
      for (const EnvironmentName of ENVIRONMENTS) {
        for (const [logicalId] of secretResources()) {
          expect(pattern.test(secretName(logicalId, { EnvironmentName })), logicalId).toBe(false);
        }
        expect(pattern.test(`devfathom/${EnvironmentName}/database-admin-url`)).toBe(false);
        expect(pattern.test(`devfathom/${EnvironmentName}/anthropic-api-key/extra`)).toBe(false);
        expect(pattern.test(`devfathom/${EnvironmentName}/anthropic-api-key`)).toBe(true);
        expect(pattern.test(`devfathom/${EnvironmentName}/openai-api-key`)).toBe(true);
      }
      for (const accepted of ['', 'team/anthropic', 'team/openai', 'shared/devfathom/keys']) {
        expect(pattern.test(accepted), accepted).toBe(true);
      }
      for (const refused of ['team/*', 'team/anthropic?', 'has space']) {
        expect(pattern.test(refused), refused).toBe(false);
      }
    }
  });
});
