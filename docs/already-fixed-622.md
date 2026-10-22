# GitHub issue #622: already fixed

Issue #622 is already fixed in the current code. No application or test code was changed for
this verification.

## Code evidence

- `src/lib/restaurant/drawer-sessions.ts:461-464` resolves the branch-local business date and
  calls `assertMoneyDayOpen` before creating a drawer session.
- `src/lib/restaurant/drawer-sessions.ts:466-499` creates the session and records its
  `OPENING_FLOAT` movement only after that guard succeeds.
- `src/lib/restaurant/daily-close.ts:669-684` shows that `assertMoneyDayOpen` acquires the
  branch/day close lock and rejects a date with an existing close using `CLOSE_EXISTS`.
- `src/lib/restaurant/daily-close.ts:438-452` shows that `cutClose` acquires the same lock before
  checking for an existing close and loading the close inputs. Opening and closing therefore
  serialize on the same branch/day lock.
- `src/lib/restaurant/drawer-sessions.test.ts:197-224` contains the focused regression test: it
  closes a business day, verifies that opening a drawer on that day fails with `CLOSE_EXISTS`,
  and verifies that no drawer session was persisted.

Together, these checks cover the reported closed-day write and the open-versus-close race. If
the close wins the lock, opening observes the close and fails. If opening wins, its transaction
finishes before the close can evaluate the day's drawers, so the close's existing readiness
validation sees the newly opened drawer.
