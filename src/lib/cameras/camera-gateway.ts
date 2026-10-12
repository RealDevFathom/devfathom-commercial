export type CameraStreamTransport = 'hls';

export const cameraGatewayCapabilities = {
  transport: 'hls',
  recording: 'gateway-local',
  ptz: false,
  audio: false,
  clipExport: false,
} as const;

export type CameraProbeResult =
  | { outcome: 'ok'; discoveredProfile: string }
  | { outcome: 'auth-failed' }
  | { outcome: 'unreachable' };

export interface CameraGatewayAdapter {
  listCameras(): Promise<Array<{ id: string; name: string }>>;
  getLiveManifest(cameraId: string): Promise<string>;
  /** PNG still bytes. Callers must authorize access before invoking the adapter. */
  getSnapshot(cameraId: string): Promise<Uint8Array>;
  listRecordings(
    cameraId: string
  ): Promise<Array<{ id: string; startedAt: string; durationSeconds: number }>>;
  getRecordingSegment(recordingId: string, segment: string): Promise<Uint8Array>;
  getRetentionState(): Promise<{ days: number; usedBytes: number }>;
  getGatewayHealth(): Promise<{ healthy: boolean }>;
  testConnection(input: { outcome?: CameraProbeResult['outcome'] }): Promise<CameraProbeResult>;
}
