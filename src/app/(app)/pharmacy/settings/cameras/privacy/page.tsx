import type { Metadata } from 'next';

import { CameraPrivacyPage, privacyNotice } from '@/components/camera/camera-privacy-page';

export const metadata: Metadata = { title: 'Pharmacy camera privacy' };

export default async function PharmacyCameraPrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; kind?: string }>;
}) {
  return <CameraPrivacyPage vertical="pharmacy" notice={privacyNotice(await searchParams)} />;
}
