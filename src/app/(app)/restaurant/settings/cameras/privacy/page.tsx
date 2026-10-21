import type { Metadata } from 'next';

import { CameraPrivacyPage, privacyNotice } from '@/components/camera/camera-privacy-page';

export const metadata: Metadata = { title: 'Restaurant camera privacy' };

export default async function RestaurantCameraPrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; kind?: string }>;
}) {
  return <CameraPrivacyPage vertical="restaurant" notice={privacyNotice(await searchParams)} />;
}
