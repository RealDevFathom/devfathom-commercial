import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function filesUnder(...parts: string[]): string[] {
  const directory = join(process.cwd(), ...parts);

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(...parts, entry.name) : [join(directory, entry.name)]
  );
}

function normalized(values: Iterable<string>) {
  return [...new Set([...values].map((value) => value.toLowerCase()))].sort();
}

function createdExtensions(source: string) {
  return [...source.matchAll(/\bCREATE\s+EXTENSION(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([\w$]+)"?/gi)].map(
    ([, name]) => name
  );
}

type ContainerProbe = {
  type: string;
  source: string;
  initialDelaySeconds: number;
  periodSeconds: number;
  failureThreshold: number;
  timeoutSeconds: number;
};

/** Probes declared on the web container, parsed from the Bicep `probes: [...]` block. */
function webContainerProbes(template: string): ContainerProbe[] {
  const block = template.match(/\n\s*probes: \[\n([\s\S]*?)\n\s*\]\n/);
  expect(block, 'web container probes block').not.toBeNull();

  return [...block![1].matchAll(/\{\n([\s\S]*?)\n\s*\}(?=\n|$)/g)].map(([, source]) => {
    const field = (name: string) => {
      const match = source.match(new RegExp(`^\\s*${name}: (\\d+)$`, 'm'));
      expect(match, `${name} in probe:\n${source}`).not.toBeNull();
      return Number(match![1]);
    };
    const type = source.match(/^\s*type: '(\w+)'$/m);
    expect(type, `type in probe:\n${source}`).not.toBeNull();

    return {
      type: type![1],
      source,
      initialDelaySeconds: field('initialDelaySeconds'),
      periodSeconds: field('periodSeconds'),
      failureThreshold: field('failureThreshold'),
      timeoutSeconds: field('timeoutSeconds'),
    };
  });
}

/** Seconds before a probe that never succeeds reaches its failure threshold. */
function failureWindowSeconds(probe: ContainerProbe) {
  return probe.initialDelaySeconds + probe.failureThreshold * probe.periodSeconds;
}

describe('container app probe contract (DEV-339)', () => {
  // Measured staging cold start from scale-to-zero (revision devfathom-stg--0000013).
  const MEASURED_COLD_START_SECONDS = 35.92;

  it('declares explicit Startup, Liveness and Readiness probes instead of platform defaults', () => {
    const probes = webContainerProbes(read('infra', 'environment.bicep'));

    expect(probes.map((probe) => probe.type)).toEqual(['Startup', 'Liveness', 'Readiness']);
    const [startup, liveness, readiness] = probes;

    expect(startup).toMatchObject({
      initialDelaySeconds: 10,
      periodSeconds: 10,
      failureThreshold: 10,
      timeoutSeconds: 5,
    });
    expect(startup.source).toContain('tcpSocket: { port: 3000 }');
    expect(liveness).toMatchObject({
      initialDelaySeconds: 60,
      periodSeconds: 30,
      failureThreshold: 3,
      timeoutSeconds: 5,
    });
    expect(liveness.source).toContain('tcpSocket: { port: 3000 }');
    expect(readiness).toMatchObject({
      initialDelaySeconds: 10,
      periodSeconds: 10,
      failureThreshold: 12,
      timeoutSeconds: 5,
    });
    expect(readiness.source).toContain(
      "httpGet: { path: '/api/ready', port: 3000, scheme: 'HTTP' }"
    );
  });

  it('sizes the probes with real margin over the measured 35.92 s cold start', () => {
    const [startup, liveness, readiness] = webContainerProbes(read('infra', 'environment.bicep'));

    // The probe that can kill a booting container must allow at least twice the measured boot,
    // not the ~1.1 s margin observed under the old platform-default liveness probe.
    expect(failureWindowSeconds(startup)).toBe(110);
    expect(failureWindowSeconds(startup)).toBeGreaterThanOrEqual(2 * MEASURED_COLD_START_SECONDS);
    // Liveness would not fire mid-boot even if Startup gating were ever removed.
    expect(liveness.initialDelaySeconds).toBeGreaterThan(MEASURED_COLD_START_SECONDS);
    expect(liveness.failureThreshold * liveness.periodSeconds).toBe(90);
    expect(failureWindowSeconds(readiness)).toBe(130);
    expect(failureWindowSeconds(readiness)).toBeGreaterThanOrEqual(2 * MEASURED_COLD_START_SECONDS);
    for (const probe of [startup, liveness, readiness]) {
      expect(probe.timeoutSeconds, probe.type).toBeLessThan(probe.periodSeconds);
    }
  });

  it('documents the measured margin beside the probes and preserves the replica policy', () => {
    const template = read('infra', 'environment.bicep');
    const probeComment = template.split('probes: [', 1)[0].split('DEV-339', 2)[1];

    expect(probeComment).toBeDefined();
    expect(probeComment).toContain('35.92 s cold start');
    expect(probeComment).toContain('110 s window');
    expect(probeComment).toContain('130 s');
    expect(probeComment).toContain('tests/production-deployment-contract.test.ts');

    // Probe margins are for scale-to-zero environments; replica policy is unchanged.
    expect(template).toContain('param minReplicas int = 0');
    expect(template).toContain('scale: { minReplicas: minReplicas, maxReplicas: 1 }');
    expect(read('infra', 'production.bicepparam')).toContain('param minReplicas = 1');
    expect(read('infra', 'production.bootstrap.bicepparam')).toContain('param minReplicas = 1');
    expect(read('infra', 'staging.bicepparam')).not.toContain('minReplicas');
  });
});

describe('production deployment contract', () => {
  it('keeps the dispatch digest out of shell source and verifies the promoted revision', () => {
    const workflow = read('.github', 'workflows', 'promote-production.yml');

    expect(workflow.match(/\$\{\{ inputs\.image_digest \}\}/g)).toHaveLength(1);
    expect(workflow).toContain('IMAGE_DIGEST: ${{ inputs.image_digest }}');
    expect(workflow.indexOf('- name: Validate image digest')).toBeLessThan(
      workflow.indexOf('- uses: azure/login@v3')
    );
    expect(workflow).toContain('[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]');
    // The migration job runs extensions → migrate deploy → runtime-role grant →
    // module-registry reconcile, and never `prisma/seed.ts`: seeding stays
    // staging-only. `prepare-runtime-role.ts` (406b7183) provisions the
    // NOBYPASSRLS app role, and `sync-catalog.ts` reconciles the module registry
    // on already-provisioned databases where the bootstrap path never reruns.
    expect(workflow).toContain(
      `[[ "$migration_command" == 'bun prisma/prepare-extensions.ts && bunx prisma migrate deploy && bun prisma/prepare-runtime-role.ts && bun prisma/sync-catalog.ts' ]]`
    );
    expect(workflow).toContain('az containerapp job secret list');
    expect(workflow).toContain('[[ -z "$initialization_secrets" ]]');
    expect(workflow).toContain('az containerapp revision show');
    expect(workflow).toContain('[[ "$revision_image" == "$image"');
    expect(workflow).toContain('--connect-timeout 5 --max-time 10');
    expect(workflow).toContain('--retry-max-time 150');
  });

  it('keeps initialization credentials in Key Vault and out of the always-on app', () => {
    const template = read('infra', 'environment.bicep');
    const webEnvironment = template
      .split('var webEnvironment = [', 2)[1]
      .split('\n]\n\nvar migrationEnvironment', 1)[0];

    expect(webEnvironment).toBeDefined();
    for (const name of [
      'SEED_PASSWORD',
      'ADMIN_NAME',
      'ADMIN_EMAIL',
      'ADMIN_PASSWORD',
      'PLATFORM_ADMIN_EMAIL',
      'PLATFORM_ADMIN_PASSWORD',
    ]) {
      expect(webEnvironment).not.toContain(name);
    }
    expect(template).toContain('env: webEnvironment');
    expect(template).toContain('secrets: runtimeKeyVaultSecrets');
    for (const [resource, secret, parameter] of [
      ['seedPasswordSecret', 'seed-password', 'seedPassword'],
      ['adminPasswordSecret', 'admin-password', 'adminPassword'],
      ['platformAdminPasswordSecret', 'platform-admin-password', 'platformAdminPassword'],
    ]) {
      expect(template).toContain(
        `resource ${resource} 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (createInitializationSecrets && !empty(${parameter}))`
      );
      expect(template).toContain(
        `{ name: '${secret}', keyVaultUrl: '\${vaultBaseUrl}/${secret}', identity: identity.id }`
      );
      expect(template).not.toContain(`{ name: '${secret}', value: ${parameter} }`);
    }
    expect(template).toContain(
      'seedPasswordSecret, adminPasswordSecret, platformAdminPasswordSecret'
    );
    expect(template).toContain('secrets: migrationSecrets');
    expect(template).toContain('param createInitializationSecrets bool = false');
  });

  it('defaults production to migrations only and provides an explicit bootstrap parameter file', () => {
    const template = read('infra', 'environment.bicep');
    const production = read('infra', 'production.bicepparam');
    const bootstrap = read('infra', 'production.bootstrap.bicepparam');

    expect(template).toContain('param bootstrapDatabase bool = false');
    expect(template).toContain(
      "var migrateDatabaseCommand = 'bun prisma/prepare-extensions.ts && bunx prisma migrate deploy && bun prisma/prepare-runtime-role.ts && bun prisma/sync-catalog.ts'"
    );
    // Production still never seeds: the migration-only command carries no
    // `prisma/seed.ts` (the seed suffix is reachable only from the staging-only
    // `seedDatabase` branch), and production disables seed and bootstrap alike.
    expect(production).toContain('param seedDatabase = false');
    expect(template).toContain(
      "{ name: 'EXTENSION_ADMIN_DATABASE_URL', secretRef: 'database-url' }"
    );
    expect(production).toContain('param bootstrapDatabase = false');
    expect(production).toContain("param emailDeliveryMode = 'capture'");
    expect(production).toContain('param minReplicas = 1');
    expect(production).not.toMatch(/DEVFATHOM_PRODUCTION_(?:SEED|ADMIN|PLATFORM_ADMIN)_PASSWORD/);
    expect(bootstrap).toContain('param bootstrapDatabase = true');
    expect(bootstrap).toContain(
      "readEnvironmentVariable('DEVFATHOM_PRODUCTION_ADMIN_PASSWORD', '')"
    );
    expect(bootstrap).toContain(
      "readEnvironmentVariable('DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD', '')"
    );
    expect(bootstrap).not.toContain('DEVFATHOM_PRODUCTION_SEED_PASSWORD');
    expect(bootstrap).toContain(
      "readEnvironmentVariable('DEVFATHOM_PRODUCTION_CREATE_INITIALIZATION_SECRETS', 'false') == 'true'"
    );
  });

  it('disables generic staging seeding while retaining initialization inputs', () => {
    const staging = read('infra', 'staging.bicepparam');

    expect(staging).toContain('param seedDatabase = false');
    expect(staging).toContain('param bootstrapDatabase = false');
    expect(staging).toContain("param emailDeliveryMode = 'capture'");
    expect(staging).toContain("readEnvironmentVariable('DEVFATHOM_STAGING_SEED_PASSWORD', '')");
    expect(staging).toContain("readEnvironmentVariable('DEVFATHOM_STAGING_ADMIN_PASSWORD', '')");
    expect(staging).toContain(
      "readEnvironmentVariable('DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD', '')"
    );
    expect(staging).toContain(
      "readEnvironmentVariable('DEVFATHOM_STAGING_CREATE_INITIALIZATION_SECRETS', 'false') == 'true'"
    );
  });

  it('generates only missing staging initialization credentials', () => {
    const deployment = read('infra', 'deploy-staging.sh');

    expect(deployment).toContain('az keyvault list');
    expect(deployment).toContain("starts_with(name, 'df-stg-')");
    expect(deployment).not.toContain('--query properties.outputs.keyVaultName.value');
    expect(deployment).toContain('if ! vault_lookup=$(az keyvault list');
    expect(deployment).toContain('if (( ${#key_vault_ids[@]} == 0 ))');
    expect(deployment).toContain('az resource show');
    expect(deployment).toContain('--ids "$key_vault_id/secrets/$secret_name"');
    expect(deployment).toContain('elif [[ $secret_lookup == *ResourceNotFound* ]]');
    expect(deployment).toContain('unset DEVFATHOM_STAGING_SEED_PASSWORD');
    expect(deployment).toContain('unset DEVFATHOM_STAGING_CREATE_INITIALIZATION_SECRETS');
    expect(deployment).toContain('generate_initialization_credential "$environment_variable"');
    expect(deployment).toContain('if (( ${#key_vault_ids[@]} > 1 ))');
    expect(deployment).toContain('export DEVFATHOM_STAGING_CREATE_INITIALIZATION_SECRETS=true');
    expect(deployment).toContain('Aborting without changing initialization credentials.');
  });

  it('guards production bootstrap through independent vault and secret discovery', () => {
    const deployment = read('infra', 'deploy-production-bootstrap.sh');

    expect(deployment).toContain('az keyvault list');
    expect(deployment).toContain("starts_with(name, 'df-prd-')");
    expect(deployment).not.toContain('az deployment group show');
    expect(deployment).toContain('if ! vault_lookup=$(az keyvault list');
    expect(deployment).toContain('if (( ${#key_vault_ids[@]} == 0 ))');
    expect(deployment).toContain('unset DEVFATHOM_PRODUCTION_ADMIN_PASSWORD');
    expect(deployment).toContain('unset DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD');
    expect(deployment).toContain('unset DEVFATHOM_PRODUCTION_CREATE_INITIALIZATION_SECRETS');
    expect(deployment).toContain('--ids "$key_vault_id/secrets/$secret_name"');
    expect(deployment).toContain('elif [[ $secret_lookup == *ResourceNotFound* ]]');
    expect(deployment).toContain('if (( ${#key_vault_ids[@]} > 1 ))');
    expect(deployment).toContain('export DEVFATHOM_PRODUCTION_CREATE_INITIALIZATION_SECRETS=true');
    expect(deployment).toContain('--parameters infra/production.bootstrap.bicepparam');
    expect(deployment).toContain('Aborting without changing initialization credentials.');
  });

  it('allow-lists every extension created by deployment code', () => {
    const migrationSources = filesUnder('prisma', 'migrations').filter((path) =>
      path.endsWith('.sql')
    );
    const prismaSources = readdirSync(join(process.cwd(), 'prisma'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(process.cwd(), 'prisma', entry.name));
    const requiredExtensions = normalized(
      [...migrationSources, ...prismaSources, ...filesUnder('scripts')].flatMap((path) =>
        createdExtensions(readFileSync(path, 'utf8'))
      )
    );

    const extensionPreparation = read('prisma', 'prepare-extensions.sql');
    const preparationList = extensionPreparation.match(
      /FOREACH\s+target_extension\s+IN\s+ARRAY\s+ARRAY\[([^\]]+)]::name\[\]/i
    );
    expect(preparationList).not.toBeNull();
    expect(
      normalized([...preparationList![1].matchAll(/'([^']+)'/g)].map(([, name]) => name))
    ).toEqual(requiredExtensions);

    const parameterPaths = readdirSync(join(process.cwd(), 'infra'))
      .filter((name) => /^(?:staging|production).*\.bicepparam$/.test(name))
      .sort();
    expect(parameterPaths).toEqual([
      'production.bicepparam',
      'production.bootstrap.bicepparam',
      'staging.bicepparam',
    ]);
    for (const parameterPath of parameterPaths) {
      const parameter = read('infra', parameterPath).match(
        /^param postgresExtensions = '([^']+)'$/m
      );
      expect(parameter, parameterPath).not.toBeNull();
      expect(normalized(parameter![1].split(',').map((name) => name.trim()))).toEqual(
        requiredExtensions
      );
    }
  });
});
