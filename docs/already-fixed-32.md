# GitHub issue #32 — already fixed

Issue #32 asked the project to choose explicit Azure Container Apps startup and
liveness behaviour using the measured 35.92-second staging cold start, while
keeping the replica decision separate for environments that receive real
LiveKit webhooks. The current code already implements that work:

- `infra/environment.bicep:549-557` declares a TCP startup probe with a
  10-second initial delay and ten failures at 10-second intervals. This gives a
  cold-starting process substantially more room than the measured 35.92 seconds
  before startup is considered failed.
- `infra/environment.bicep:558-565` declares an explicit TCP liveness probe with
  a 60-second initial delay, a 30-second period, and a three-failure threshold.
  The deployment therefore no longer inherits an unreviewable platform-default
  liveness probe close to the observed cold-start duration.
- `infra/environment.bicep:566-573` retains a separate readiness probe and points
  it at `/api/ready`, preserving its 10-second initial delay, 10-second period,
  twelve-failure threshold, and five-second timeout.
- `infra/environment.bicep:31` keeps `minReplicas` configurable and
  `infra/environment.bicep:577` applies that parameter to the Container App.
  `infra/production.bicepparam:13` pins production to one replica, while staging
  omits an override and therefore retains the scale-to-zero default. This keeps
  probe tuning relevant to staging without using replica cost as a substitute
  for correct probe configuration.

No implementation change is needed for issue #32. The existing values provide
reviewable cold-start protection, and the production/staging parameter choices
already reflect the sequencing described by the issue.
