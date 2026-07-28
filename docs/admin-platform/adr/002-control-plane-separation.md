# ADR-002: Separate Agency Control Plane

Status: Proposed (2026-07-28)

Decision proposed: agency administrative operations use distinct control-plane routes, permissions and audit events rather than overloading tenant `ADMIN`. Consequences: clearer trust boundary and additional identity/UX work. Acceptance requires implemented routes, support-session controls and audit verification.
