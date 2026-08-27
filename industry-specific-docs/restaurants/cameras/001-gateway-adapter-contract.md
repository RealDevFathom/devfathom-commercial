# Camera gateway adapter contract

CAM-L1 registers a branch-bound gateway separately from POS/KDS devices. The app stores only the SHA-256 hash of a 256-bit `rcg_` gateway secret and re-resolves it by the unique hash on every trust decision. Revoked gateways are unusable regardless of their last heartbeat.

The vendor-neutral adapter exposes `listCameras`, `getLiveManifest`, `listRecordings`, `getRecordingSegment`, `getRetentionState`, `getGatewayHealth`, and `testConnection`. Its capability record fixes transport to HLS, storage to gateway-local, PTZ off, audio off, and clip export off. Vendor presets only fill forms; ONVIF Profile S discovery and RTSP remain the single runtime path.

Credentials use AES-256-GCM with a 32-byte application-held key. Ciphertext is write-only to control surfaces and is decrypted only while provisioning the gateway. No read serializer includes `sealedValue`. Platform audit projections explicitly omit `credentialCiphertext` and `assembledRtspUrl`.

The simulator is selected explicitly by tests/development callers. It performs no network access and supplies a fixed HLS manifest, segment bytes, recording index, retention/health state, and the three coarse probe outcomes. There is no production environment-variable fallback.

## Security boundary

Platform transactions bypass tenant RLS. Camera commands therefore verify the branch with both the selected organization and branch IDs in the same transaction, write `organizationId` explicitly, and reject strict payloads with unknown keys. Tenant APIs must derive organization scope from the authenticated session and must not accept an `organizationId` key.

The simulator does not prove vendor authentication, camera VLAN routing, network segmentation, firmware-specific stream paths, storage capacity, or hardware retention behavior. Those remain hardware-pilot checks.
