# Self-hosted CI rollout requirements

The `mac-runner` migration is blocked pending runner infrastructure changes.
The reviewed QA run at `db4d9803adf31922c88391ce321b14939e5a4ff9`
failed with missing `psql`/`az` (127) and killed typecheck/build processes (137).

The workflow now installs PostgreSQL client in both QA jobs and Azure CLI/Bicep
in the automated gate before those tools are used. The Linux runner must provide
`sudo`, `apt-get` and `curl`, with passwordless package installation. Azure CLI
uses Microsoft's [Debian/Ubuntu installer](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-linux?pivots=apt).

Both QA jobs check the runner, container and Docker daemon memory before
installing application dependencies. Provision at least 12 GiB of effective
memory (16 GiB recommended); the existing 8 GiB V8 heap allowance, PostgreSQL
services and native allocations cannot fit in the reviewed 6 GiB VM. This check
only reports an undersized runner; it does not resize it or prove the workload
will complete. Retain every gate and validate the provisioned runner with a
complete QA run, including browser QA and the amd64 image build.

Before allowing PR workflows onto self-hosted infrastructure, an administrator
must replace the reusable runner with a disposable VM and a dedicated Docker
daemon for each job. Destroy both after the job, including cancellation or
failure. An ephemeral runner registration alone does not reset the VM or daemon.
Do not expose a persistent host Docker socket or share credentials, workspaces,
containers or caches with deployment runners. Approval must cover the exact
executed revision; a persistent `ci-ready` label is insufficient after a push.
Restrict runner-group access to trusted workflows so a PR cannot bypass that
approval by changing its workflow. See GitHub's
[self-hosted runner security guidance](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners).

These lifecycle, access and approval controls are infrastructure requirements;
they are **not implemented by this repository change**. The workflows still
target the existing runner labels. Do not consider the memory or isolation
findings resolved until the infrastructure is provisioned and verified. Merely
adding an `ephemeral` label or a cleanup step is not sufficient isolation.
