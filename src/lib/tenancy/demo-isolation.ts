import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { publicRequestOrigin } from '@/lib/http-origin';

export const DEMO_UNAVAILABLE_MESSAGE = 'Not available in demo.';

const BLOCKED_PREFIXES = [
  'apiTokens.',
  'email.',
  // DEV-679: invoice reads spend AI-provider credits.
  'pharmacyInvoiceCapture.',
  // DEV-752: pack-photo reads spend AI-provider credits.
  'pharmacyPackLabel.',
  'restaurantCameras.',
  'restaurantMenuImport.',
  'trelloImport.',
  'webhooks.',
] as const;

const BLOCKED_MUTATIONS = new Set([
  'finance.sendInvoiceEmail',
  'organizationAdmin.addDomain',
  'organizationAdmin.createScimToken',
  'organizationAdmin.removeRole',
  'organizationAdmin.resetMemberPassword',
  'organizationAdmin.retryDomain',
  'organizationAdmin.revokeScimToken',
  'organizationAdmin.updateEmail',
  'organizationAdmin.updateMember',
  'organizationAdmin.upsertRole',
  'restaurantDevices.initiateEnrollment',
  'restaurantDevices.revoke',
  'restaurantDevices.rotate',
  'restaurantNotifications.configureWebhook',
  'restaurantNotifications.retryWebhook',
  'restaurantNotifications.testWebhook',
  'restaurantPayments.saveTerminalConfig',
  'restaurantStaff.clearStaffCapabilityOverride',
  'restaurantStaff.create',
  'restaurantStaff.createJobRole',
  'restaurantStaff.issueCredential',
  'restaurantStaff.provisionMyProfile',
  'restaurantStaff.revokeCredential',
  'restaurantStaff.revokeMyTerminalCredential',
  'restaurantStaff.rotateCredential',
  'restaurantStaff.seedDefaultJobRoles',
  'restaurantStaff.setJobRoleCapabilities',
  'restaurantStaff.setStaffCapabilityOverride',
  'restaurantStaff.setStaffJobRoles',
  'restaurantStaff.setStatus',
  'restaurantStaff.update',
  'restaurantStaff.updateJobRole',
  'team.adminResetPassword',
  'team.adminUpdateMember',
  'team.changePassword',
  'team.inviteMember',
  'team.layOffMember',
  'team.signOutEverywhere',
  'team.updateProfile',
  'twoFactor.beginEnrollment',
  'twoFactor.confirmEnrollment',
  'twoFactor.disable',
]);

export function isDemoProcedureBlocked(path: string, type: 'query' | 'mutation'): boolean {
  if (BLOCKED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (type !== 'mutation') return false;
  return BLOCKED_MUTATIONS.has(path);
}

export async function isDemoTenant(db: ScopedDb): Promise<boolean> {
  const organization = await db.organization.findFirst({ select: { isDemo: true } });
  return organization?.isDemo === true;
}

export function isDemoMutationOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  try {
    return (
      Boolean(origin) && new URL(origin!).origin.toLowerCase() === publicRequestOrigin(request)
    );
  } catch {
    return false;
  }
}
