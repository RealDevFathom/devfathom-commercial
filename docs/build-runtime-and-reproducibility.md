# Build runtime and reproducibility

## Bun remains a production-runtime risk

The image builds the Next.js standalone artifact with Node, but the final image
currently serves it with `bun server.js`. A successful staging build, startup,
and smoke check proves only that the exercised paths worked. It does not rule
out a Bun code-generation fault on a request path that the smoke check did not
exercise. Such a fault would occur in the serving tier, where its blast radius
and cost are greater than a build-time failure. Treat this as a standing risk,
not as a risk closed by a healthy deployment.

Bun still provides value in the final image because the same image is used for
migration and staging-initialization jobs whose checked-in commands execute
TypeScript with Bun. Moving only the web command to Node would still leave two
interpreters in one image; replacing the runner base with Node would require a
separate, deliberate migration of those operational commands. Until that work
is done, the builder/runner interpreter difference is accepted rather than
assumed safe. The preferred end state is a Node runner with those jobs either
made Node-compatible or moved to a purpose-built image.

## Build-memory coupling

`NODE_OPTIONS=--max-old-space-size=8192` in `Dockerfile` is inherited by each
Node process and is therefore a **per-process** ceiling, not a total allowance
for the build. It is coupled to `experimental.cpus: 1` in `next.config.ts`.
Increasing `cpus` can multiply concurrent heaps at that ceiling and exhaust the
image builder's memory. Review both settings and the container memory budget as
one change.

## Docker and package build parity

The Docker build intentionally invokes Prisma and Next through explicit Node
entry points instead of running `package.json`'s `build` script. This prevents
the Bun-provided `node` shim from selecting Bun in the builder workflow. The
focused contract test fails if the package script changes from the currently
equivalent `prisma generate && next build`, so any new build step must also be
added explicitly to `Dockerfile`.

## Why image digests are not a reproducibility gate

Next generates a random build ID unless `generateBuildId` is configured. That
ID appears in emitted asset paths and manifests, so independent builds of the
same source can produce different image digests. Digest inequality alone does
not show a meaningful or non-reproducible runtime change.

Compare extracted runtime layers and files instead: normalize or separately
account for build-ID-bearing manifest paths, then compare the file inventory,
sizes, and bytes. During the build-runtime change reviewed in issue #29, the
before and after image digests differed, while this artifact comparison found
82,606 runtime files with identical total size and byte-for-byte content; only
build-manifest paths differed. Use that method, rather than image-digest
equality, when evaluating whether a build-only change altered runtime output.
