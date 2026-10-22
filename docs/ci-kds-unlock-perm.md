# KDS unlock test permissions

KDS terminal unlock deliberately requires the authenticated operator to hold the
`kitchen:operate` capability. The unlock route validates the submitted PIN before
checking that capability. This ordering prevents an invalid credential from being
used to discover which staff members have kitchen access.

The expected responses are therefore:

- an incorrect PIN returns `401`, whether or not the operator has
  `kitchen:operate`;
- a correct PIN for an operator without `kitchen:operate` returns `403`; and
- a correct PIN for an operator with `kitchen:operate` can unlock a KDS terminal.

The focused terminal threat tests cover the `401` and `403` boundaries. Database
acceptance fixtures that successfully unlock KDS devices must assign
`kitchen:operate` to their operator roles. This is fixture setup, not a relaxation
of the production authorization policy.
