from typing import Any

import jwt
from fastapi import HTTPException
from jwt import InvalidTokenError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..config import Settings
from ..database import json_value, statement
from ..security import Principal, principal_from_api_token

PROFILE_FIELDS = (
    "id",
    "name",
    "email",
    "role",
    "department",
    "title",
    "avatar",
    "phone",
    "bio",
    "skills",
    "startDate",
    "status",
    "lastActiveAt",
)

SAFE_SETTINGS_COLUMNS = (
    "id, name, email, role::text AS role, department::text AS department, "
    'title, avatar, phone, bio, skills, "startDate", status::text AS status, '
    '"lastActiveAt", preferences, "notificationPrefs"'
)

SAFE_UI_PREFERENCE_VALUES = {
    "theme": {"light", "dark", "system"},
    "density": {"default", "compact"},
    "type": {"default", "lg"},
    "accent": {"quiet", "bold"},
    "layout": {"rail", "top"},
    "icons": {"numeric", "architectural"},
}

SAFE_NOTIFICATION_CATEGORIES = {
    "task",
    "mention",
    "meeting",
    "leave",
    "invoice",
    "project",
    "client",
    "resignation",
    "note",
}
SAFE_NOTIFICATION_CHANNELS = {"inApp", "email"}


def _serialize_settings_bootstrap(record: dict[str, Any]) -> dict[str, Any]:
    stored_preferences = dict(record["preferences"] or {})
    preferences = {
        key: value
        for key, allowed_values in SAFE_UI_PREFERENCE_VALUES.items()
        if isinstance((value := stored_preferences.get(key)), str) and value in allowed_values
    }

    stored_notifications = dict(record["notificationPrefs"] or {})
    notification_preferences: dict[str, dict[str, bool]] = {}
    for category in SAFE_NOTIFICATION_CATEGORIES:
        stored_channels = stored_notifications.get(category)
        if not isinstance(stored_channels, dict):
            continue
        notification_preferences[category] = {
            channel: value
            for channel in SAFE_NOTIFICATION_CHANNELS
            if isinstance((value := stored_channels.get(channel)), bool)
        }

    return {
        "profile": {field: json_value(record[field]) for field in PROFILE_FIELDS},
        "preferences": preferences,
        "notificationPreferences": notification_preferences,
    }


async def load_settings_bootstrap(principal: Principal, db: AsyncConnection) -> dict[str, Any]:
    """Load only the authenticated member's safe, primary Settings data."""
    result = await db.execute(
        statement(f"SELECT {SAFE_SETTINGS_COLUMNS} FROM users WHERE id = :id"),
        {"id": principal.id},
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="User not found")

    return _serialize_settings_bootstrap(record)


async def load_session_settings_bootstrap(
    token: str,
    db: AsyncConnection,
    settings: Settings,
) -> dict[str, Any]:
    """Resolve a browser session and load its safe Settings projection in one query."""
    try:
        payload = jwt.decode(token, settings.auth_secret, algorithms=["HS256"])
        if payload.get("purpose") == "two_factor":
            raise InvalidTokenError("two-factor challenges are not sessions")
        user_id = payload["sub"]
    except (InvalidTokenError, KeyError) as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired session") from exc

    result = await db.execute(
        statement(f'SELECT {SAFE_SETTINGS_COLUMNS}, "tokenVersion" FROM users WHERE id = :id'),
        {"id": user_id},
    )
    record = result.mappings().first()
    if not record or record["status"] not in {"ACTIVE", "ON_LEAVE"}:
        raise HTTPException(status_code=401, detail="Session user is inactive")
    if int(payload.get("ver", -1)) != record["tokenVersion"]:
        raise HTTPException(status_code=401, detail="Session has been revoked")

    return _serialize_settings_bootstrap(record)


async def load_settings_bootstrap_for_credentials(
    token: str,
    db: AsyncConnection,
    settings: Settings,
) -> dict[str, Any]:
    """Authenticate once and load only the caller-owned primary Settings data."""
    if token.startswith("df_"):
        principal = await principal_from_api_token(token, db)
        if not principal.has_scope("auth:read"):
            raise HTTPException(status_code=403, detail="Required scope: auth:read")
        return await load_settings_bootstrap(principal, db)
    return await load_session_settings_bootstrap(token, db, settings)
