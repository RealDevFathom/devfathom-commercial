import json
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from backend.app.routers import admin, auth_management, finance, people
from backend.app.routers.firm_common import (
    AUDIT_MAX_BYTES,
    _totp,
    as_naive_utc,
    generate_api_token,
    generate_recovery_codes,
    generate_totp_secret,
    hash_recovery_code,
    invoice_totals,
    matching_totp_counter,
    redact,
    require_roles,
    serialize_audit_json,
    sha256_token,
    verify_totp,
)
from backend.app.schemas_admin import ApiTokenCreate, WebhookCreate
from backend.app.schemas_auth_management import PasswordResetApply, PasswordResetRequest, password_meets_policy
from backend.app.schemas_finance import InvoiceCreate, InvoiceItemIn
from backend.app.schemas_people import LeaveCreate, MemberUpdate, ReviewCycleCreate
from backend.app.security import Principal
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError
from starlette.requests import Request


def principal(role: str = "EMPLOYEE") -> Principal:
    return Principal(id="user-1", name="Test User", email="test@example.com", role=role, status="ACTIVE", scopes=["*"])


def test_invoice_money_is_derived_and_rounded_server_side() -> None:
    items = [
        InvoiceItemIn(description="Fractional work", quantity=Decimal("1.005"), rate=Decimal("10")),
        InvoiceItemIn(description="Hosting", quantity=Decimal("2"), rate=Decimal("4.999")),
    ]
    rendered, subtotal, total = invoice_totals(items, Decimal("1.25"))
    assert rendered[0]["amount"] == 10.05
    assert rendered[1]["amount"] == 10.0
    assert subtotal == Decimal("20.05")
    assert total == Decimal("21.30")


def test_invoice_schema_rejects_empty_items_and_oversized_money() -> None:
    with pytest.raises(ValidationError):
        InvoiceCreate(client_id="client", items=[], due_date=datetime.now(UTC))
    with pytest.raises(ValidationError):
        InvoiceItemIn(description="Bad", quantity=1, rate=Decimal("10000000000"))


def test_currency_is_explicit_and_limited() -> None:
    invoice = InvoiceCreate(
        client_id="client",
        items=[InvoiceItemIn(description="Work", quantity=1, rate=100)],
        currency="PKR",
        due_date=datetime.now(UTC),
    )
    assert invoice.currency == "PKR"
    with pytest.raises(ValidationError):
        InvoiceCreate(
            client_id="client",
            items=[InvoiceItemIn(description="Work", quantity=1, rate=100)],
            currency="EUR",
            due_date=datetime.now(UTC),
        )


def test_sensitive_audit_payloads_are_deeply_redacted() -> None:
    value = {
        "email": "person@example.com",
        "new_password": "NeverStoreThis1",
        "nested": {"token": "raw-token", "safe": [1, {"secret": "raw-secret"}]},
    }
    assert redact(value) == {
        "email": "person@example.com",
        "new_password": "[REDACTED]",
        "nested": {"token": "[REDACTED]", "safe": [1, {"secret": "[REDACTED]"}]},
    }


def test_audit_serialization_handles_domain_types_bounds_and_substring_secrets() -> None:
    value = {
        "invoiceTotal": Decimal("123.45"),
        "occurredAt": datetime(2026, 7, 12, 3, 4, tzinfo=UTC),
        "accessTokenValue": "must-not-leak",
        "DatabasePASSWORDBackup": "must-not-leak-either",
        "huge": "x" * (AUDIT_MAX_BYTES * 2),
        "deep": {"next": {"next": {"next": {"next": {"next": {"next": {"next": {"next": "stop"}}}}}}}},
    }
    encoded = serialize_audit_json(value)
    assert encoded is not None
    decoded = json.loads(encoded)
    assert len(encoded.encode()) <= AUDIT_MAX_BYTES
    assert "must-not-leak" not in encoded
    assert "[REDACTED]" in encoded
    assert decoded


def test_prisma_datetime_normalization_is_naive_utc() -> None:
    aware = datetime(2026, 7, 12, 8, 30, tzinfo=timezone(timedelta(hours=5)))
    normalized = as_naive_utc(aware)
    assert normalized == datetime(2026, 7, 12, 3, 30)
    assert normalized.tzinfo is None
    naive = datetime(2026, 7, 12, 3, 30)
    assert as_naive_utc(naive) is naive


def test_api_and_link_tokens_store_only_hashes() -> None:
    token, prefix, token_hash = generate_api_token()
    assert token.startswith("df_")
    assert prefix == token[:12]
    assert token not in token_hash
    assert sha256_token("same") == sha256_token("same")
    assert sha256_token("same") != sha256_token("different")


def test_api_token_scopes_are_known_and_deduplicated() -> None:
    token = ApiTokenCreate(name="scoped", scopes=["projects:read", "projects:read", "notes:write"])
    assert token.scopes == ["projects:read", "notes:write"]
    with pytest.raises(ValidationError):
        ApiTokenCreate(name="unknown", scopes=["made-up:write"])


def test_principal_preserves_session_and_api_token_actor_identity() -> None:
    session = principal()
    assert (session.actor_type, session.token_id, session.token_name) == ("USER", None, None)
    token = Principal(
        id="user-1",
        name="Test User",
        email="test@example.com",
        role="ADMIN",
        status="ACTIVE",
        scopes=["projects:read"],
        actor_type="API_TOKEN",
        token_id="token-1",
        token_name="Automation",
    )
    assert (token.actor_type, token.token_id, token.token_name) == ("API_TOKEN", "token-1", "Automation")


def test_totp_verification_allows_one_step_clock_skew() -> None:
    secret = generate_totp_secret()
    counter = 123456
    token = _totp(secret, counter)
    assert verify_totp(secret, token, at=counter * 30)
    assert verify_totp(secret, token, at=(counter + 1) * 30)
    assert not verify_totp(secret, "00000x", at=counter * 30)


def test_totp_helper_returns_the_exact_counter_for_atomic_replay_claims() -> None:
    assert "atomic" in auth_management.TOTP_REPLAY_PROTECTION
    secret = generate_totp_secret()
    counter = 123456
    token = _totp(secret, counter)
    assert matching_totp_counter(secret, token, at=counter * 30) == counter
    assert matching_totp_counter(secret, token, at=(counter + 1) * 30) == counter
    assert matching_totp_counter(secret, "00000x", at=counter * 30) is None


def test_recovery_codes_are_unique_normalized_and_hash_only() -> None:
    codes, hashes = generate_recovery_codes()
    assert len(codes) == len(hashes) == 10
    assert len(set(codes)) == 10
    assert all(code not in hashes for code in codes)
    assert hash_recovery_code(f"  {codes[0].upper()} ") == hashes[0]


@pytest.mark.parametrize(
    ("value", "expected"),
    [("GoodPass1", True), ("lowercase1", False), ("UPPERCASE1", False), ("NoNumber", False), ("Short1A", False)],
)
def test_password_policy(value: str, expected: bool) -> None:
    assert password_meets_policy(value) is expected


def test_password_reset_schema_enforces_shared_policy() -> None:
    with pytest.raises(ValidationError):
        PasswordResetApply(token="token", new_password="weak")


class _FakeResult:
    def __init__(self, record: dict | None = None) -> None:
        self.record = record

    def mappings(self) -> "_FakeResult":
        return self

    def first(self) -> dict | None:
        return self.record


class _PasswordResetDb:
    def __init__(self, user: dict | None) -> None:
        self.user = user
        self.calls = 0
        self.commits = 0

    async def execute(self, *_args, **_kwargs) -> _FakeResult:
        self.calls += 1
        return _FakeResult(self.user if self.calls == 1 else None)

    async def commit(self) -> None:
        self.commits += 1


@pytest.mark.asyncio
@pytest.mark.parametrize("known_user", [False, True])
async def test_password_reset_equalizes_paths_and_detaches_delivery(monkeypatch, known_user: bool) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    async def delivery_must_not_run_inline(*_args) -> None:
        raise AssertionError("external delivery was awaited inline")

    monkeypatch.setattr(auth_management.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(auth_management, "send_password_reset_email", delivery_must_not_run_inline)
    auth_management._reset_attempts.clear()
    user = {"id": "u1", "password": "hash", "status": "ACTIVE"} if known_user else None
    db = _PasswordResetDb(user)
    background = BackgroundTasks()
    request = Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 1)})
    response = await auth_management.request_password_reset(
        PasswordResetRequest(email="person@example.com"), request, background, db
    )
    assert response == {"success": True}
    assert sleeps and sleeps[0] > 0.20
    assert len(background.tasks) == (1 if known_user else 0)
    assert db.commits == (1 if known_user else 0)


def test_leave_and_review_ranges_are_validated() -> None:
    now = datetime.now(UTC)
    with pytest.raises(ValidationError):
        LeaveCreate(type="VACATION", start_date=now, end_date=now - timedelta(days=1))
    with pytest.raises(ValidationError):
        ReviewCycleCreate(name="Q3", start_date=now, end_date=now - timedelta(days=1))


def test_webhooks_accept_only_http_protocols_and_known_events_are_router_validated() -> None:
    WebhookCreate(url="https://example.com/hook", events=["invoice.paid"])
    with pytest.raises(ValidationError):
        WebhookCreate(url="ftp://example.com/hook", events=["invoice.paid"])
    with pytest.raises(HTTPException) as error:
        admin.validate_webhook_events(["invoice.paid", "unknown.event"])
    assert error.value.status_code == 422


def test_role_guards_enforce_admin_and_hr_boundaries() -> None:
    require_roles(principal("ADMIN"), "ADMIN")
    require_roles(principal("HR"), "ADMIN", "HR")
    with pytest.raises(HTTPException) as error:
        require_roles(principal("EMPLOYEE"), "ADMIN", "HR")
    assert error.value.status_code == 403


class _AdminInvariantResult:
    def __init__(self, *, record=None, scalar=None) -> None:
        self.record = record
        self.scalar = scalar

    def mappings(self):
        return self

    def first(self):
        return self.record

    def one(self):
        return self.record

    def scalar_one(self):
        return self.scalar


class _AdminInvariantDb:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.commits = 0

    async def execute(self, sql, *_args, **_kwargs):
        rendered = str(sql)
        self.events.append(rendered)
        if "COUNT(*)" in rendered:
            return _AdminInvariantResult(scalar=1)
        if "RETURNING id, name" in rendered:
            return _AdminInvariantResult(
                record={
                    "id": "admin-2",
                    "name": "Other Admin",
                    "email": "other@example.com",
                    "role": "EMPLOYEE",
                    "department": "ENGINEERING",
                    "title": "Engineer",
                    "phone": None,
                    "bio": None,
                    "skills": [],
                    "status": "ACTIVE",
                }
            )
        return _AdminInvariantResult(record={"name": "Other Admin", "role": "ADMIN", "status": "ACTIVE"})

    async def commit(self):
        self.commits += 1


@pytest.mark.asyncio
async def test_admin_demotion_acquires_global_invariant_lock_before_member_row(monkeypatch) -> None:
    events: list[str] = []

    async def lock(_db):
        events.append("ADMIN_LOCK")

    async def no_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(people, "lock_active_admin_invariant", lock)
    monkeypatch.setattr(people, "audit_event", no_audit)
    db = _AdminInvariantDb(events)
    await people.admin_update_member("admin-2", MemberUpdate(role="EMPLOYEE"), principal("ADMIN"), db)
    assert events[0] == "ADMIN_LOCK"
    assert "FOR UPDATE" in events[1]
    assert db.commits == 1


@pytest.mark.asyncio
async def test_limited_admin_tokens_need_explicit_admin_domain_scopes() -> None:
    limited = principal("ADMIN")
    limited.scopes = ["finance:write"]
    with pytest.raises(HTTPException) as error:
        await admin.api_tokens_read(limited)
    assert error.value.status_code == 403
    scoped = principal("ADMIN")
    scoped.scopes = ["api-tokens:read"]
    assert await admin.api_tokens_read(scoped) is scoped


class _NeverDb:
    async def execute(self, *_args, **_kwargs):
        raise AssertionError("scope escalation must fail before database access")


@pytest.mark.asyncio
@pytest.mark.parametrize("requested", [["*"], ["finance:read"]])
async def test_limited_token_cannot_mint_broader_scopes(requested: list[str]) -> None:
    caller = principal("ADMIN")
    caller.scopes = ["api-tokens:write"]
    with pytest.raises(HTTPException) as error:
        await admin.create_api_token(ApiTokenCreate(name="escalation", scopes=requested), caller, _NeverDb())
    assert error.value.status_code == 403


def test_delegated_token_scopes_must_be_subset_of_caller_authority() -> None:
    limited = principal("ADMIN")
    limited.scopes = ["api-tokens:write", "projects:write"]
    admin.validate_delegated_scopes(limited, ["api-tokens:read", "projects:read"])
    with pytest.raises(HTTPException):
        admin.validate_delegated_scopes(limited, ["projects:write", "finance:read"])
    wildcard = principal("ADMIN")
    wildcard.scopes = ["*"]
    admin.validate_delegated_scopes(wildcard, ["*"])


@pytest.mark.asyncio
async def test_limited_tokens_cannot_mutate_auth_or_team_management() -> None:
    limited = principal("ADMIN")
    limited.scopes = ["projects:write"]
    with pytest.raises(HTTPException):
        await auth_management.auth_write(limited)
    with pytest.raises(HTTPException):
        await auth_management.team_write_admin(limited)
    scoped = principal("ADMIN")
    scoped.scopes = ["auth:write", "team:write"]
    assert await auth_management.auth_write(scoped) is scoped
    assert await auth_management.team_write_admin(scoped) is scoped


def test_expected_firm_routes_are_exposed_by_domain_modules() -> None:
    paths = {route.path for module in (finance, people, admin, auth_management) for route in module.router.routes}
    expected = {
        "/api/finance/summary",
        "/api/finance/invoices/{invoice_id}/payments",
        "/api/hr/leave/{leave_id}/decision",
        "/api/hr/resignations/{resignation_id}/decision",
        "/api/hr/reviews/{review_id}/submit",
        "/api/admin/api-tokens",
        "/api/admin/audit-logs",
        "/api/admin/webhooks",
        "/api/auth/password-reset",
        "/api/auth/invitations/accept",
        "/api/auth/sessions",
        "/api/auth/two-factor/enrollment/confirm",
    }
    assert expected <= paths
