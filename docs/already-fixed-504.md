# GitHub issue #504: already fixed

Issue #504 reports that `projects.addMember` can demote the last project lead when
the target is already a member. The current implementation already prevents that
state:

- `src/server/routers/projects.ts:217-225` loads the existing target membership
  and counts the project's leads before an `addMember` role update.
- `src/server/routers/projects.ts:226-231` rejects a change from `LEAD` to
  `MEMBER` when the project has no other lead.
- `src/server/routers/projects.ts:235-238` performs the upsert only after that
  guard, so the reported self-demotion cannot reach the write.
- `src/server/routers/projects.ts:346-358` applies the equivalent invariant to
  the dedicated `setMemberRole` path.

The guard was introduced by commit `4e3e4c8` before this issue was handled on the
current branch. No additional production-code or test change is needed.
