import json
from collections.abc import AsyncIterator

from backend.app.config import Settings, get_settings
from backend.app.database import connection
from backend.app.main import app
from backend.app.security import Principal, create_access_token
from backend.app.services.settings_bootstrap import load_settings_bootstrap
from fastapi.testclient import TestClient


class _MappingResult:
    def __init__(self, row: dict | None):
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class _BootstrapDb:
    def __init__(self, *, user_id: str = "user-1", role: str = "EMPLOYEE"):
        self.user_id = user_id
        self.role = role
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, query, params=None):
        sql = str(query)
        bound = dict(params or {})
        self.calls.append((sql, bound))
        row = {
            "id": self.user_id,
            "name": "Settings User",
            "email": "settings@example.com",
            "role": self.role,
            "department": "ENGINEERING",
            "title": "Engineer",
            "avatar": None,
            "phone": "+1 555 0100",
            "bio": "Safe profile",
            "skills": ["Python"],
            "startDate": None,
            "status": "ACTIVE",
            "lastActiveAt": None,
            "preferences": {
                "theme": "dark",
                "apiToken": "bootstrap-must-not-leak",
                "_security": {"twoFactorSecret": "bootstrap-must-not-leak"},
            },
            "notificationPrefs": {
                "task": {
                    "inApp": True,
                    "email": False,
                    "secret": "bootstrap-must-not-leak",
                },
                "credentials": {"email": "bootstrap-must-not-leak"},
            },
        }
        if '"tokenVersion"' in sql:
            row["tokenVersion"] = 0
        return _MappingResult(row)


def _principal(*, user_id: str = "user-1", role: str = "EMPLOYEE") -> Principal:
    return Principal(
        id=user_id,
        name="Settings User",
        email="settings@example.com",
        role=role,
        status="ACTIVE",
        scopes=["*"],
    )


async def test_bootstrap_is_bound_to_the_current_principal_and_projects_safe_columns() -> None:
    db = _BootstrapDb()
    payload = await load_settings_bootstrap(_principal(user_id="user-1"), db)

    assert len(db.calls) == 1
    sql, params = db.calls[0]
    assert params == {"id": "user-1"}
    assert "password" not in sql.lower()
    assert '"tokenVersion"' not in sql
    assert "secret" not in sql.lower()
    assert payload["profile"]["id"] == "user-1"
    assert payload["preferences"] == {"theme": "dark"}
    assert payload["notificationPreferences"] == {"task": {"inApp": True, "email": False}}


async def test_non_admin_bootstrap_contains_no_admin_or_secret_metadata() -> None:
    payload = await load_settings_bootstrap(_principal(), _BootstrapDb())
    serialized = json.dumps(payload)

    assert set(payload) == {"profile", "preferences", "notificationPreferences"}
    assert payload["profile"]["role"] == "EMPLOYEE"
    for forbidden in (
        "apiToken",
        "webhook",
        "password",
        "twoFactor",
        "session",
        "bearer",
        "credential",
        "bootstrap-must-not-leak",
    ):
        assert forbidden.lower() not in serialized.lower()


async def test_admin_bootstrap_still_excludes_token_and_webhook_metadata() -> None:
    payload = await load_settings_bootstrap(_principal(role="ADMIN"), _BootstrapDb(role="ADMIN"))

    assert payload["profile"]["role"] == "ADMIN"
    assert set(payload) == {"profile", "preferences", "notificationPreferences"}
    assert "apiTokens" not in payload
    assert "webhooks" not in payload


def test_bootstrap_resolves_one_principal_with_one_shared_connection() -> None:
    settings = Settings(_env_file=None, auth_secret="test-settings-bootstrap-secret-with-32-chars")
    db = _BootstrapDb()
    connection_count = 0

    async def one_connection() -> AsyncIterator[_BootstrapDb]:
        nonlocal connection_count
        connection_count += 1
        yield db

    app.dependency_overrides[connection] = one_connection
    app.dependency_overrides[get_settings] = lambda: settings
    token = create_access_token(_principal(), settings)
    try:
        response = TestClient(app).get(
            "/api/settings/bootstrap",
            headers={"Authorization": f"Bearer {token}"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert connection_count == 1
    assert len(db.calls) == 1
    assert all(params == {"id": "user-1"} for _, params in db.calls)
    serialized = response.text.lower()
    assert token.lower() not in serialized
    assert "bootstrap-must-not-leak" not in serialized
