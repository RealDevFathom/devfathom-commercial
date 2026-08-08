import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('production deployment contract', () => {
  it('keeps the dispatch digest out of shell source and verifies the promoted revision', () => {
    const workflow = read('.github', 'workflows', 'promote-production.yml');

    expect(workflow.match(/\$\{\{ inputs\.image_digest \}\}/g)).toHaveLength(1);
    expect(workflow).toContain('IMAGE_DIGEST: ${{ inputs.image_digest }}');
    expect(workflow.indexOf('- name: Validate image digest')).toBeLessThan(
      workflow.indexOf('- uses: azure/login@v3')
    );
    expect(workflow).toContain('[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]');
    expect(workflow).toContain(`[[ "$migration_command" == 'bunx prisma migrate deploy' ]]`);
    expect(workflow).toContain('az containerapp job secret list');
    expect(workflow).toContain('[[ -z "$initialization_secrets" ]]');
    expect(workflow).toContain('az containerapp revision show');
    expect(workflow).toContain('[[ "$revision_image" == "$image"');
    expect(workflow).toContain('--connect-timeout 5 --max-time 10');
    expect(workflow).toContain('--retry-max-time 150');
  });

  it('keeps initialization credentials out of the always-on app', () => {
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
    expect(template).not.toContain('resource seedPasswordSecret');
    expect(template).not.toContain('resource adminPasswordSecret');
    expect(template).not.toContain('resource platformAdminPasswordSecret');
    expect(template).toContain("{ name: 'admin-password', value: adminPassword }");
    expect(template).toContain('secrets: migrationSecrets');
  });

  it('defaults production to migrations only and provides an explicit bootstrap parameter file', () => {
    const template = read('infra', 'environment.bicep');
    const production = read('infra', 'production.bicepparam');
    const bootstrap = read('infra', 'production.bootstrap.bicepparam');

    expect(template).toContain('param bootstrapDatabase bool = false');
    expect(template).toContain(": 'bunx prisma migrate deploy'");
    expect(production).toContain('param bootstrapDatabase = false');
    expect(production).toContain("param emailDeliveryMode = 'capture'");
    expect(production).toContain('param minReplicas = 1');
    expect(production).not.toMatch(/DEVFATHOM_PRODUCTION_(?:SEED|ADMIN|PLATFORM_ADMIN)_PASSWORD/);
    expect(bootstrap).toContain('param bootstrapDatabase = true');
    expect(bootstrap).toContain('DEVFATHOM_PRODUCTION_ADMIN_PASSWORD');
    expect(bootstrap).toContain('DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD');
    expect(bootstrap).not.toContain('DEVFATHOM_PRODUCTION_SEED_PASSWORD');
  });

  it('retains the existing staging seed inputs', () => {
    const staging = read('infra', 'staging.bicepparam');

    expect(staging).toContain('param seedDatabase = true');
    expect(staging).toContain('param bootstrapDatabase = false');
    expect(staging).toContain("param emailDeliveryMode = 'capture'");
    expect(staging).toContain('DEVFATHOM_STAGING_SEED_PASSWORD');
    expect(staging).toContain('DEVFATHOM_STAGING_ADMIN_PASSWORD');
    expect(staging).toContain('DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD');
  });
});
