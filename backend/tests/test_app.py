from collections import Counter

import jwt
import pytest
from backend.app.config import Settings
from backend.app.database import connection
from backend.app.main import app
from backend.app.routers import auth, dashboard, resources
from backend.app.schemas import LoginRequest, ResourcePayload, TwoFactorChallengeResponse, TwoFactorVerifyRequest
from backend.app.security import Principal, create_two_factor_challenge, current_principal, principal_from_session
from fastapi import HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.requests import Request

client = TestClient(app)


def test_root_describes_migrated_stack() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["frontend"] == "Nuxt 4"
    assert response.json()["backend"] == "FastAPI"


def test_health_is_available_without_database() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] in {"ok", "degraded"}


def test_combined_routes_are_unique_ordered_and_secured() -> None:
    routes = [route for route in app.routes if isinstance(route, APIRoute)]
    operations = [(method, route.path) for route in routes for method in route.methods]
    assert len(routes) >= 220
    assert not {key: count for key, count in Counter(operations).items() if count > 1}
    assert next(i for i, route in enumerate(routes) if route.path == "/api/v1/search") < next(
        i for i, route in enumerate(routes) if route.path == "/api/v1/{resource_name}"
    )
    assert app.openapi()["components"]["securitySchemes"]["HTTPBearer"]["scheme"] == "bearer"


def test_cors_preflight_allows_put() -> None:
    response = client.options(
        "/api/auth/preferences",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "PUT"},
    )
    assert response.status_code == 200
    assert "PUT" in response.headers["access-control-allow-methods"]


class _Result:
    def __init__(self, record: dict | None = None) -> None:
        self.record = record

    def mappings(self):
        return self

    def first(self):
        return self.record


class _LoginDb:
    def __init__(self, user: dict) -> None:
        self.user = user
        self.commits = 0
        self.sql: list[str] = []

    async def execute(self, sql, *_args, **_kwargs):
        self.sql.append(str(sql))
        return _Result(self.user)

    async def commit(self) -> None:
        self.commits += 1


def _two_factor_user() -> dict:
    return {
        "id": "user-1",
        "name": "Two Factor User",
        "email": "two@example.com",
        "password": "hash",
        "role": "ADMIN",
        "department": "ENGINEERING",
        "title": "Engineer",
        "avatar": None,
        "status": "ACTIVE",
        "tokenVersion": 3,
        "twoFactorEnabledAt": "enabled",
        "twoFactorSecret": "secret",
    }


def _request(ip: str = "127.0.0.1") -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/login",
            "headers": [(b"user-agent", b"pytest")],
            "client": (ip, 1234),
        }
    )


@pytest.mark.asyncio
async def test_enrolled_login_returns_only_a_non_session_challenge(monkeypatch) -> None:
    settings = Settings(auth_secret="test-secret-that-is-long-enough")
    monkeypatch.setattr(auth, "verify_secret", lambda *_args: True)
    auth._login_attempts.clear()
    response = await auth.login(
        LoginRequest(email="two@example.com", password="password"), _request(), _LoginDb(_two_factor_user()), settings
    )
    assert isinstance(response, TwoFactorChallengeResponse)
    claims = jwt.decode(response.challenge_token, settings.auth_secret, algorithms=["HS256"])
    assert claims["purpose"] == "two_factor"
    with pytest.raises(HTTPException):
        await principal_from_session(response.challenge_token, _LoginDb(_two_factor_user()), settings)


@pytest.mark.asyncio
async def test_two_factor_verify_exchanges_challenge_for_session(monkeypatch) -> None:
    settings = Settings(auth_secret="test-secret-that-is-long-enough")
    principal = Principal(
        id="user-1",
        name="Two Factor User",
        email="two@example.com",
        role="ADMIN",
        status="ACTIVE",
        scopes=["*"],
        token_version=3,
    )
    challenge, _ = create_two_factor_challenge(principal, settings)
    monkeypatch.setattr(auth, "matching_totp_counter", lambda *_args: 123456)

    async def claim(*_args):
        return True

    monkeypatch.setattr(auth, "claim_totp_counter", claim)
    db = _LoginDb(_two_factor_user())
    response = await auth.verify_login_two_factor(
        TwoFactorVerifyRequest(challenge_token=challenge, code="123456"), _request(), db, settings
    )
    claims = jwt.decode(response.access_token, settings.auth_secret, algorithms=["HS256"])
    assert claims["purpose"] == "session"
    assert db.commits == 1


@pytest.mark.asyncio
async def test_two_factor_verify_rejects_a_replayed_totp_step(monkeypatch) -> None:
    settings = Settings(auth_secret="test-secret-that-is-long-enough")
    principal = Principal(
        id="user-1",
        name="Two Factor User",
        email="two@example.com",
        role="ADMIN",
        status="ACTIVE",
        scopes=["*"],
        token_version=3,
    )
    challenge, _ = create_two_factor_challenge(principal, settings)
    claims = iter((True, False))
    monkeypatch.setattr(auth, "matching_totp_counter", lambda *_args: 123456)

    async def claim(*_args):
        return next(claims)

    async def no_recovery(*_args):
        return False

    monkeypatch.setattr(auth, "claim_totp_counter", claim)
    monkeypatch.setattr(auth, "consume_recovery_code", no_recovery)
    payload = TwoFactorVerifyRequest(challenge_token=challenge, code="123456")
    auth._login_attempts.clear()
    await auth.verify_login_two_factor(payload, _request(), _LoginDb(_two_factor_user()), settings)
    with pytest.raises(HTTPException) as replay:
        await auth.verify_login_two_factor(payload, _request(), _LoginDb(_two_factor_user()), settings)
    assert replay.value.status_code == 401


def test_production_rejects_default_or_short_auth_secrets() -> None:
    with pytest.raises(ValidationError):
        Settings(environment="production", auth_secret="dev-only-change-me")
    with pytest.raises(ValidationError):
        Settings(vercel_env="production", auth_secret="short-but-sixteen")
    settings = Settings(vercel_env="production", auth_secret="a-unique-production-secret-with-32-chars")
    assert settings.vercel_env == "production"


def test_login_and_two_factor_rate_limits_are_keyed_independently() -> None:
    auth._login_attempts.clear()
    assert all(auth.login_rate_limit("login:email:a@example.com", 2) for _ in range(2))
    assert not auth.login_rate_limit("login:email:a@example.com", 2)
    assert auth.login_rate_limit("login:ip:127.0.0.2", 2)
    assert auth.login_rate_limit("2fa:challenge:digest", 1)
    assert not auth.login_rate_limit("2fa:challenge:digest", 1)


class _DashboardDb:
    def __init__(self) -> None:
        self.scalar_sql: list[str] = []
        self.execute_sql: list[str] = []

    async def scalar(self, sql, _params=None):
        self.scalar_sql.append(str(sql))
        return 7

    async def execute(self, sql, _params=None):
        self.execute_sql.append(str(sql))
        raise AssertionError("restricted dashboard token reached finance queries")


@pytest.mark.asyncio
async def test_dashboard_api_tokens_only_query_granted_sections() -> None:
    restricted = Principal(
        id="user-1",
        name="Scoped Token",
        email="token@example.com",
        role="ADMIN",
        status="ACTIVE",
        scopes=["projects:read"],
        actor_type="API_TOKEN",
        token_id="token-1",
    )
    db = _DashboardDb()
    response = await dashboard.stats(restricted, db)
    assert response["data"] == {
        "activeProjects": 7,
        "totalTasks": 0,
        "completedTasksThisWeek": 0,
        "pendingLeaves": 0,
        "revenue": [],
        "expenses": [],
        "outstandingInvoices": 0,
        "isAdmin": True,
    }
    assert len(db.scalar_sql) == 1 and "projects" in db.scalar_sql[0]
    assert db.execute_sql == []
    restricted.scopes = ["notifications:read"]
    assert await dashboard.activity(restricted, db) == {"data": []}


class _NeverDb:
    async def execute(self, *_args, **_kwargs):
        raise AssertionError("compatibility write reached the database")


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["projects", "tasks", "clients", "invoices", "transactions", "meetings"])
async def test_generic_compatibility_writes_are_blocked_for_migrated_domains(name: str) -> None:
    principal = Principal(
        id="user-1",
        name="Admin",
        email="admin@example.com",
        role="ADMIN",
        status="ACTIVE",
        scopes=["*"],
    )
    payload = ResourcePayload.model_validate({"name": "unsafe", "total": 0, "status": "PAID"})
    calls = (
        resources.create_resource(name, payload, principal, _NeverDb()),
        resources.update_resource(name, "resource-1", payload, principal, _NeverDb()),
        resources.delete_resource(name, "resource-1", principal, _NeverDb()),
    )
    for call in calls:
        with pytest.raises(HTTPException) as error:
            await call
        assert error.value.status_code == 405


def test_generic_patch_preserves_only_nullable_explicit_none() -> None:
    project = resources.RESOURCES["projects"]
    assert resources.patch_values(project, ResourcePayload.model_validate({"description": None})) == {
        "description": None
    }
    with pytest.raises(HTTPException) as error:
        resources.patch_values(project, ResourcePayload.model_validate({"name": None}))
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_failed_password_login_is_audited_without_changing_public_error(monkeypatch) -> None:
    auth._login_attempts.clear()
    monkeypatch.setattr(auth, "verify_secret", lambda *_args: False)
    db = _LoginDb(_two_factor_user())
    with pytest.raises(HTTPException) as error:
        await auth.login(
            LoginRequest(email="two@example.com", password="wrong"),
            _request(),
            db,
            Settings(auth_secret="test-secret-that-is-long-enough"),
        )
    assert error.value.status_code == 401
    assert error.value.detail == "Invalid email or password"
    assert any("INSERT INTO audit_logs" in sql for sql in db.sql)
    assert db.commits == 1


class _EmptyResult:
    def mappings(self):
        return self

    def all(self):
        return []

    def first(self):
        return None

    def __iter__(self):
        return iter(())


class _EmptyHttpDb:
    async def execute(self, *_args, **_kwargs):
        return _EmptyResult()


def test_authenticated_http_routes_span_migrated_domains() -> None:
    principal = Principal(
        id="admin-1",
        name="Admin",
        email="admin@example.com",
        role="ADMIN",
        status="ACTIVE",
        scopes=["*"],
    )
    db = _EmptyHttpDb()

    async def override_principal():
        return principal

    async def override_connection():
        yield db

    app.dependency_overrides[current_principal] = override_principal
    app.dependency_overrides[connection] = override_connection
    try:
        assert client.get("/api/v1/projects").json() == {"data": []}
        assert client.get("/api/v1/notifications").json() == []
        assert client.get("/api/finance/summary").json() == {"byCurrency": []}
        scopes = client.get("/api/admin/api-tokens/scopes")
        assert scopes.status_code == 200 and "projects:read" in scopes.json()["data"]
        blocked = client.post("/api/v1/invoices", json={"total": 0, "status": "PAID"})
        assert blocked.status_code == 405
    finally:
        app.dependency_overrides.clear()
