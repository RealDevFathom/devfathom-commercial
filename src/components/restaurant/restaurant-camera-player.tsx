'use client';

import { CameraLivePlayer } from '@/components/camera/camera-live-player';
import type { CameraLiveGrant } from '@/lib/cameras/live-session';

const restaurantStreamUrl = (cameraId: string, grantId: string) =>
  `/api/restaurant/cameras/${encodeURIComponent(cameraId)}/stream?grant=${encodeURIComponent(grantId)}`;

/** Restaurant binding of the shared live player; behavior is unchanged. */
export function RestaurantCameraPlayer(props: {
  cameraId: string;
  name: string;
  issue: (previousGrantId?: string) => Promise<CameraLiveGrant>;
}) {
  return <CameraLivePlayer {...props} streamUrl={restaurantStreamUrl} />;
}
