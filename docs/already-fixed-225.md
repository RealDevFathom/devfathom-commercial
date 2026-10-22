# GitHub issue #225 is already fixed

The current code already applies the shared password policy to organization onboarding:

- `src/lib/platform/commands.ts:24` imports `passwordSchema` from the shared password-policy module.
- `src/lib/platform/commands.ts:668` defines `organizationInput.adminPassword` as
  `passwordSchema.min(12).max(256)`, retaining the onboarding-specific 12–256 character bounds
  while also requiring the shared lowercase, uppercase, and digit rules.
- `src/lib/password-policy.ts:21-26` defines those shared lowercase, uppercase, and digit checks.
- `src/lib/platform/commands.organization-create.test.ts:120-132` is a focused regression test
  proving that `aaaaaaaaaaaa` is rejected before either the organization or administrator is
  created.

The organization-onboarding fix is present in commit
`21df23e5c15b413ec368bee910ae7c290b4d2f8a` (`fix(#225)`), which is already an ancestor
of the current branch. During follow-up review, the related platform administrator password-reset
command was also aligned with this shared policy, with focused coverage proving that a weak reset
password is rejected before the user is updated.
