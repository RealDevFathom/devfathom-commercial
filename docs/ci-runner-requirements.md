# CI runner requirements and PR scope

PR #235 keeps the automated QA gate, browser gate and native amd64 image build
on `ubuntu-latest`. Each job gets a disposable GitHub-hosted VM and Docker daemon.
The image build retains its native `RUNNER_ARCH=X64` guard. Jobs can use separate
hosted runners; the browser gate still waits for the automated gate to pass.

The final change pins the Node setup action to a commit and selects Node 22 in
both QA jobs, adds a memory preflight script and regression tests, and documents
the requirements for any future self-hosted rollout. All existing QA commands,
coverage and failure checks remain. PostgreSQL client and Azure CLI/Bicep use the
hosted image tooling, as before this PR; the self-hosted package installation and
downloaded root installer have been removed. This replaces the earlier PR scope
claim that only runner labels and image-build steps changed.

Both QA jobs check the runner, container and Docker daemon memory before
installing application dependencies. They require at least 12 GiB of effective
memory (16 GiB recommended): the existing 8 GiB V8 heap allowance, PostgreSQL
services and native allocations cannot fit in the reviewed 6 GiB Mac Docker VM.
The preflight remains a hard failure on undersized infrastructure. It does not
resize a runner or prove that the complete workload will finish.

The `mac-runner` migration is deferred. Before allowing PR workflows onto
self-hosted infrastructure, an administrator must provision a disposable VM and
a dedicated Docker daemon for each job, with sufficient memory. Destroy both
after the job, including cancellation or failure. An ephemeral runner
registration alone does not reset the VM or daemon. Do not expose a persistent
host Docker socket or share credentials, workspaces, containers or caches with
deployment runners.

For that future rollout, approval must cover the exact executed revision; a
persistent `ci-ready` label is insufficient after a push. Restrict runner-group
access to trusted workflows so a PR cannot bypass approval by changing its
workflow. See GitHub's
[self-hosted runner security guidance](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners).

Those self-hosted controls are external prerequisites and are not provisioned by
this PR. Keep the hosted runner selection until they are verified. Before a
future migration, compare queue time and job duration for the automated gate,
browser gate and native amd64 image build against hosted runs of the same
revision. No performance improvement is claimed or measured by this change.
