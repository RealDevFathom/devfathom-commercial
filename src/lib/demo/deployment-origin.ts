import {
  demoSharedDeploymentOrigin as configuredDemoSharedDeploymentOrigin,
  type DemoOrganization,
} from '@/lib/platform/activation-gates';

export function demoSharedDeploymentOrigin(organization: DemoOrganization): string | null {
  return configuredDemoSharedDeploymentOrigin(
    organization,
    process.env.AUTH_URL || process.env.NEXTAUTH_URL,
    process.env.SHARED_APP_HOSTS
  );
}
