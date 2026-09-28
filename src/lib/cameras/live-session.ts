export type CameraLiveGrant = { grantId: string; expiresAt: Date | string };

/** One selected view, no retries. Renew before expiry; never resurrect a stopped view. */
export function startCameraLiveSession(options: {
  issue: (previousGrantId?: string) => Promise<CameraLiveGrant>;
  onGrant: (grant: CameraLiveGrant) => void;
  onStop: (message: string) => void;
}) {
  let stopped = false;
  let renewals = 0;
  let timer: ReturnType<typeof setTimeout>;
  let deadline: ReturnType<typeof setTimeout>;
  const stop = (message?: string) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    if (message) options.onStop(message);
  };
  const issue = async (previousGrantId?: string) => {
    if (stopped) return;
    deadline = setTimeout(
      () => stop('Authorization timed out. Open live view to try again.'),
      10_000
    );
    try {
      const grant = await options.issue(previousGrantId);
      if (stopped) return;
      clearTimeout(deadline);
      const remaining = new Date(grant.expiresAt).getTime() - Date.now();
      if (
        !Number.isFinite(remaining) ||
        remaining <= 15_000 ||
        remaining > 60_000 ||
        !grant.grantId
      ) {
        stop('Live view authorization expired. Open live view to request access.');
        return;
      }
      options.onGrant(grant);
      deadline = setTimeout(() => stop('Live view authorization expired.'), remaining);
      timer = setTimeout(() => {
        if (++renewals >= 30) {
          stop('Viewing session ended. Open live view to continue.');
          return;
        }
        clearTimeout(deadline);
        void issue(grant.grantId);
      }, remaining - 15_000);
    } catch {
      stop('Live view authorization denied or unavailable. Open live view to request access.');
    }
  };
  void issue();
  return { stop };
}
