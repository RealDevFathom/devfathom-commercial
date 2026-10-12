import { withPlatformDb } from '@/lib/tenancy/scoped-db';

export function listActiveCameraBrandPresets() {
  return withPlatformDb((db) =>
    db.platformCameraBrandPreset.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { familyName: 'asc' }],
      select: {
        key: true,
        familyName: true,
        aliases: true,
        iconKey: true,
        rtspPort: true,
        onvifPort: true,
        mainStreamPathTemplate: true,
        subStreamPathTemplate: true,
        authSchemeHint: true,
        defaultUsernameHint: true,
        credentialNote: true,
        setupNote: true,
      },
    })
  );
}
