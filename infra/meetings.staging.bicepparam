using './meetings.bicep'

param environmentName = 'staging'

// Standard_F4s_v2 is the recommendation on merit — LiveKit asks for
// compute-optimised instances and the selective-subscription policy makes four
// vCPUs plausible. It is NOT the value here, because `az deployment group
// validate` against this subscription returns:
//
//   SkuNotAvailable: Following SKUs have failed for Capacity Restrictions:
//   Standard_F4s_v2 ... not available in location 'UAENorth'
//
// No FSv2 SKU appears in `az vm list-skus --location uaenorth` at all, so
// Standard_F8s_v2 is equally unavailable. The available compute-optimised
// alternatives (Standard_F4as_v6/v7, $0.337/h) cost more than D4s_v5 ($0.235/h),
// so D4s_v5 is the cheapest orderable four-vCPU machine. Flip this back to
// Standard_F4s_v2 once a capacity request for FSv2 in UAE North is granted.
// Full evidence: docs/meetings/011-azure-infrastructure.md.
param vmSize = 'Standard_D4s_v5'

// Reserved labels — src/lib/tenancy/host-routing.ts. DNS is a manual GoDaddy
// step, documented in docs/meetings/012-dns-and-tls.md.
param meetHost = 'meet-staging.devfathom.com'
param turnHost = 'turn-staging.devfathom.com'

param adminUsername = 'devfathom'

// Public half of the break-glass key pair. A public key is not a secret, but it
// is read from the environment so the operator's key is never pasted into the
// repository by accident. Export it before validating or deploying:
//   export DEVFATHOM_MEETINGS_SSH_PUBLIC_KEY="$(cat ~/.ssh/devfathom-meetings.pub)"
param adminPublicKey = readEnvironmentVariable('DEVFATHOM_MEETINGS_SSH_PUBLIC_KEY')

param alertEmail = readEnvironmentVariable('DEVFATHOM_MEETINGS_ALERT_EMAIL', 'ops@devfathom.com')

// Ubuntu 24.04 LTS, pinned. Bumping this is a deliberate, logged operation —
// docs/meetings/015-staging-operations.md.
param imageVersion = '24.04.202608020'
