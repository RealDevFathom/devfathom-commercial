/**
 * WHA-1180 — the activation gate contract.
 *
 * The owner report was that "Activation preflight failed: add ready production
 * deployment." names a precondition but not where to satisfy it. These tests
 * pin the two halves of the fix that everything else reads:
 *
 *   (a) every unmet gate carries a stable key, an operator sentence, and a link
 *       to the surface that satisfies it;
 *   (b) the joined sentence rebuilt from those gates is byte-identical to the
 *       message the preflight has always thrown, so no existing reader breaks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activationPreflightMessage,
  sharedDeploymentUrl,
  unmetActivationGates,
  type ActivationGateState,
} from './activation-gates';

/** A state that satisfies every base gate. */
function ready(overrides: Partial<ActivationGateState> = {}): ActivationGateState {
  return {
    organizationId: 'org_1',
    hasPackage: true,
    enabledModuleCount: 2,
    administratorCount: 1,
    readyProductionDeploymentCount: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unmetActivationGates', () => {
  it('reports nothing when every precondition is satisfied', () => {
    expect(unmetActivationGates(ready())).toEqual([]);
  });

  it('names the missing production deployment with the surface that adds one', () => {
    const gates = unmetActivationGates(ready({ readyProductionDeploymentCount: 0 }));

    expect(gates).toEqual([
      {
        gate: 'production_deployment',
        message: 'Add a ready production deployment.',
        action: {
          label: 'Add deployment',
          href: '/platform/deployments?organizationId=org_1',
        },
      },
    ]);
  });

  it('gives package, modules and administrator their own linked rows', () => {
    const gates = unmetActivationGates(
      ready({ hasPackage: false, enabledModuleCount: 0, administratorCount: 0 })
    );

    expect(gates.map((gate) => gate.gate)).toEqual([
      'commercial_package',
      'enabled_modules',
      'administrator',
    ]);
    // Each link lands on the panel of this organization that fixes it.
    expect(gates.map((gate) => gate.action.href)).toEqual([
      '/platform/organizations/org_1#profile',
      '/platform/organizations/org_1#modules',
      '/platform/organizations/org_1#people',
    ]);
    for (const gate of gates) {
      expect(gate.message.length).toBeGreaterThan(0);
      expect(gate.action.label.length).toBeGreaterThan(0);
    }
  });

  it('counts the package baseline, so an org with zero override rows is not gated', () => {
    expect(unmetActivationGates(ready({ enabledModuleCount: 1 }))).toEqual([]);
  });

  it('escapes the organization id it puts in the query string', () => {
    const [gate] = unmetActivationGates(
      ready({ organizationId: 'org 1&x', readyProductionDeploymentCount: 0 })
    );

    expect(gate?.action.href).toBe('/platform/deployments?organizationId=org%201%26x');
  });
});

describe('activationPreflightMessage', () => {
  it('reproduces the sentence the preflight has always thrown', () => {
    const gates = unmetActivationGates({
      organizationId: 'org_1',
      hasPackage: false,
      enabledModuleCount: 0,
      administratorCount: 0,
      readyProductionDeploymentCount: 0,
    });

    expect(activationPreflightMessage(gates)).toBe(
      'Activation preflight failed: add commercial package, enabled module, ' +
        'active organization administrator, ready production deployment.'
    );
  });

  it('reproduces the owner-reported single-gate sentence exactly', () => {
    const gates = unmetActivationGates(ready({ readyProductionDeploymentCount: 0 }));

    expect(activationPreflightMessage(gates)).toBe(
      'Activation preflight failed: add ready production deployment.'
    );
  });
});

describe('sharedDeploymentUrl', () => {
  it('derives the shared tenant host for a SHARED organization', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'staging.devfathom.com');

    expect(sharedDeploymentUrl({ slug: 'acme', deploymentMode: 'SHARED' })).toBe(
      'https://acme.staging.devfathom.com'
    );
  });

  it('refuses a DEDICATED organization even when a base domain is configured', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'staging.devfathom.com');

    expect(sharedDeploymentUrl({ slug: 'acme', deploymentMode: 'DEDICATED' })).toBeNull();
  });

  it('refuses when the environment configures no shared host at all', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', '');

    expect(sharedDeploymentUrl({ slug: 'acme', deploymentMode: 'SHARED' })).toBeNull();
  });
});
