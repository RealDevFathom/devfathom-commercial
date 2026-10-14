export function vercelProvisioningConfiguration(): {
  bearerToken: string;
  teamId: string;
} | null {
  const bearerToken = process.env.VERCEL_ACCESS_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID;
  return bearerToken && teamId ? { bearerToken, teamId } : null;
}

export function isDedicatedProvisioningConfigured(): boolean {
  return vercelProvisioningConfiguration() !== null;
}
