import type { Metadata } from 'next';
import { OrganizationAdminContent } from './organization-admin-content';

export const metadata: Metadata = { title: 'Organization administration' };

export default function OrganizationAdminPage() {
  return <OrganizationAdminContent />;
}
