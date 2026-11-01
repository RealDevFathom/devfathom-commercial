# Build and runtime decisions

This document records constraints that are easy to lose when changing the container build.

## Bun is still a serving-time risk

The dependency stage and final runner use Bun, while `next build`, route type generation, and
TypeScript run on real Node. A successful deployment proves only that Bun started and served the
Node-built artifact on the paths exercised by that deployment. It does **not** prove that a Bun
code-generation fault cannot appear on a different request-serving path or under production load.
Such a fault has a larger blast radius at runtime than at build time, where it fails before release.

Now that Bun no longer performs the build, its remaining benefit is a fast, lockfile-native
production dependency install and continuity for the Bun-based migration and operational scripts
shipped in the image. That benefit must be weighed against maintaining two interpreters and the
possibility of serving-only runtime incompatibilities. The preferred end state is a real-Node
runner, once the production dependency install and operational commands have a tested Node-native
path. Until then, treat Bun serving as an explicitly accepted standing risk; do not mark it closed
from startup, health-check, or light-load evidence alone.

## Build memory and worker count are one constraint

`Dockerfile` sets `NODE_OPTIONS=--max-old-space-size=8192` in the builder and `next.config.ts` sets
`experimental.cpus: 1`. The heap value is a **per-process** ceiling inherited by every process that
Next forks, not a total build allowance. Increasing `cpus` can therefore multiply the simultaneous
heap commitment. Change either value only after sizing the combination against the container
builder's total memory. Comments at both configuration sites point back to this coupling.

## Docker/package build contract

The package build script is `prisma generate && next build`. Docker performs those effects
explicitly, with route-type generation and a standalone TypeScript check between them, because its
Next invocation must use a real Node binary rather than a package-manager shim. Run
`bun run check:docker-build-contract` after changing either definition. The check fails if the
package script changes or if Docker loses or reorders any required builder step; update the script,
Dockerfile, and contract check together when intentionally changing the pipeline.

## Reproducibility is an artifact comparison, not a digest comparison

Next generates a random build ID unless `generateBuildId` is configured. The ID is embedded in
asset paths and manifests, so identical source builds normally produce different container image
digests. Image-digest equality is therefore not a valid reproducibility gate for this application,
and a digest mismatch alone is not evidence that the runtime output changed unexpectedly.

Compare the extracted runtime filesystem instead: normalize or account for build-ID-bearing
manifest paths, then compare the layer/file inventory, file sizes, and file bytes. The review that
introduced the Node build is the worked example: the image digests differed, while 82,606 runtime
files had byte-for-byte identical total size and only build-manifest paths differed. Use that
layer-and-file method when proving that a build-system-only change preserved runtime artifacts.
