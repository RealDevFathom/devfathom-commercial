# Pull request secrets scan

The **Secrets scan** GitHub Actions workflow runs Gitleaks when a pull request
targeting `main` or an `integration/**` branch is opened, updated, or reopened.
It checks out the repository with full history so Gitleaks can inspect the
complete pull request commit range rather than only the tip commit.

## Security boundaries

- The workflow is pull-request-only. It has no push, dispatch, reusable-workflow,
  or workflow-completion trigger.
- It is independent of image building and deployment workflows and cannot start
  a deployment.
- Its token permissions are read-only for repository contents and pull requests.
- It uses only the automatically provided `GITHUB_TOKEN`; it does not select a
  GitHub environment or consume deployment credentials.

## Configuration and failures

Gitleaks automatically uses `.gitleaks.toml` at the repository root when that
file is present. Keep exceptions narrow and limited to intentional test fixtures;
do not allow-list application or deployment paths.

If the job reports a leak, remove the secret from every commit in the pull
request range, rotate the exposed credential, and then update the pull request.
Do not suppress a real credential by adding an allow-list entry.

Local `error.log` files are ignored by Git and must not be committed.
