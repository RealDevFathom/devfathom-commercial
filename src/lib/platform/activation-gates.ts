import { tenantHostUrl } from '@/lib/tenancy/host-routing';

/**
 * WHA-1180 — the activation preflight's unmet conditions, as data.
 *
 * The console used to receive one sentence ("Activation preflight failed: add
 * ready production deployment."). It names a precondition but not where to
 * satisfy it, so an operator on staging had to guess. Each unmet gate now
 * carries the operator's next action, which lets the Lifecycle gate panel
 * render a checklist with links and lets the failing command hand the same
 * list to any API client.
 *
 * The joined sentence is preserved byte-for-byte: `activationPreflightMessage`
 * rebuilds it from the same gates in the same order, so every existing caller
 * keeps reading the message it always read.
 *
 * Deliberately free of `server-only` imports: the org detail page, the command
 * and the control route all read the same contract from here.
 */

export type ActivationGateKey =
  'commercial_package' | 'enabled_modules' | 'administrator' | 'production_deployment';

export type ActivationGate = {
  gate: ActivationGateKey;
  message: string;
  action: { label: string; href: string };
};

/** The organization facts the base (vertical-independent) preflight decides on. */
export type ActivationGateState = {
  organizationId: string;
  hasPackage: boolean;
  /** Organization overrides plus the package baseline, inherited live. */
  enabledModuleCount: number;
  /** ADMIN users in an ACTIVE or ON_LEAVE state. */
  administratorCount: number;
  /** Production deployments already in READY. */
  readyProductionDeploymentCount: number;
};

/**
 * The noun each gate contributes to the legacy joined sentence. Held apart from
 * `message` so the checklist row can read as a natural instruction without
 * altering the wire message the command has always thrown.
 */
const GATE_NOUN: Record<ActivationGateKey, string> = {
  commercial_package: 'commercial package',
  enabled_modules: 'enabled module',
  administrator: 'active organization administrator',
  production_deployment: 'ready production deployment',
};

/** Unmet gates in the order the preflight has always reported them. */
export function unmetActivationGates(state: ActivationGateState): ActivationGate[] {
  const organization = `/platform/organizations/${state.organizationId}`;
  const gates: ActivationGate[] = [];

  if (!state.hasPackage) {
    gates.push({
      gate: 'commercial_package',
      message: 'Assign a commercial package.',
      action: { label: 'Assign package', href: `${organization}#profile` },
    });
  }
  if (state.enabledModuleCount === 0) {
    gates.push({
      gate: 'enabled_modules',
      message: 'Enable at least one module.',
      action: { label: 'Review modules', href: `${organization}#modules` },
    });
  }
  if (state.administratorCount === 0) {
    gates.push({
      gate: 'administrator',
      message: 'Add an active organization administrator.',
      action: { label: 'Add administrator', href: `${organization}#people` },
    });
  }
  if (state.readyProductionDeploymentCount === 0) {
    gates.push({
      gate: 'production_deployment',
      message: 'Add a ready production deployment.',
      action: {
        label: 'Add deployment',
        href: `/platform/deployments?organizationId=${encodeURIComponent(state.organizationId)}`,
      },
    });
  }

  return gates;
}

export function activationPreflightMessage(gates: ActivationGate[]): string {
  const nouns = gates.map((entry) => GATE_NOUN[entry.gate]);
  return `Activation preflight failed: add ${nouns.join(', ')}.`;
}

/**
 * The production URL the shared platform hosts already serve this organization
 * on, or null when the one-click default does not apply.
 *
 * Null for two distinct reasons, both of which keep the manual registration
 * path: a DEDICATED organization is served from its own deployment and custom
 * domain, and an environment with no configured base domain has no shared host
 * to point at (`tenantHostUrl` returns null there rather than inventing one).
 *
 * The empty path keeps this byte-identical to the URL `sharedProvision` writes
 * in src/lib/platform/jobs.ts, so the one-click default and the provisioning
 * worker cannot drift apart.
 */
export function sharedDeploymentUrl(organization: {
  slug: string;
  deploymentMode: string;
}): string | null {
  if (organization.deploymentMode !== 'SHARED') return null;
  return tenantHostUrl(organization.slug, '');
}

export type DemoOrganization = {
  isDemo?: boolean;
  vertical?: string;
  deploymentMode?: string;
};

function parsedOrigin(value: string, protocol?: string): URL | null {
  try {
    const url = new URL(protocol && !value.includes('://') ? `${protocol}//${value}` : value);
    return url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !['http:', 'https:'].includes(url.protocol)
      ? null
      : url;
  } catch {
    return null;
  }
}

export function demoSharedDeploymentOrigin(
  organization: DemoOrganization,
  configured: string | undefined,
  sharedAppHosts: string | undefined
): string | null {
  if (
    !organization.isDemo ||
    organization.vertical !== 'RESTAURANT' ||
    organization.deploymentMode !== 'SHARED'
  ) {
    return null;
  }

  if (!configured) return null;
  const origin = parsedOrigin(configured);
  if (!origin) return null;

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) return null;

  const allowed = (sharedAppHosts ?? '')
    .split(',')
    .map((value) => parsedOrigin(value.trim(), origin.protocol)?.origin)
    .filter(Boolean);
  return allowed.includes(origin.origin) ? origin.origin : null;
}
