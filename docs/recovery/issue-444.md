# Issue 444: recovery of `archive/fix/qa-313`

## Decision

Cherry-pick the still-useful behavior rather than reopening the deleted branch. The recovered
Khata change is adapted to the current authorization model: an over-limit increase requires a
fresh password claim, a non-empty reason, and the tenant-scoped `pharmacy:manage` capability.
That capability is held by the canonical Owner and Manager roles, while the central authorization
engine continues to apply explicit DENY rules before ALLOW rules.

The PostgreSQL recovery also retains the narrow `similarity_op(text, text)` EXECUTE grant needed by
the medicine catalogue's trigram `%` queries after extension functions are removed from PUBLIC.
The grant belongs in the current idempotent runtime-role preparation step, not in an old migration.

## Archive disposition

| Archive commit | Disposition | Reason |
| --- | --- | --- |
| `4f0938c7` | Ported with current-code adaptation | Owner/Manager Khata approval and its recorded reason were still absent. Capability evaluation replaces a coarse account-role check so tenant overrides and DENY precedence remain authoritative. |
| `f09ced61` | Ported with current-code adaptation | The catalogue still uses the pg_trgm `%` operator. The least-privilege function grant is now issued by runtime-role preparation. |
| `1ca3e193` | Not copied independently | Its deployment concern is covered by the current extension-preparation/runtime-role split; only the missing exact runtime grant was retained. |
| `0c32cd2b` | Skipped as already present | The organization surface already describes licensed seats as “currently occupied.” |
| `ba5086e9` | Skipped as obsolete | It only recorded a historical typecheck memory blocker and does not change runtime behavior. |
| `bc1dccb9` | Skipped as obsolete | `BLOCKED.md` is not present on the current branch. |
| `79d4a3d9`, `66be65c3` | Skipped | These are merge commits for the seat-copy and pg_trgm work, not additional fixes to replay. |

No archive migration was copied, so no new migration timestamp is required.
