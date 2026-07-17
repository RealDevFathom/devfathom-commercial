import json
import logging
import os
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import statement
from ..security import Principal

logger = logging.getLogger(__name__)

COLLABORATION_READ_SCOPES = frozenset({"notes:read", "chat:read", "meetings:read", "notifications:read", "search:read"})
COLLABORATION_WRITE_SCOPES = frozenset({"notes:write", "chat:write", "meetings:write", "notifications:write"})
COLLABORATION_GRANTABLE_SCOPES = COLLABORATION_READ_SCOPES | COLLABORATION_WRITE_SCOPES

RT_MESSAGE_NEW = "chat:message"
RT_MESSAGE_UPDATE = "chat:message:update"
RT_MESSAGE_DELETE = "chat:message:delete"
RT_REACTION = "chat:reaction"
RT_READ = "chat:read"
RT_THREAD_REPLY = "chat:thread"
RT_NOTIFICATION = "notification:new"
RT_MEMBERSHIP_CHANGED = "chat:membership"


class RealtimePublisher(Protocol):
    async def publish(self, room: str, event: str, payload: Any) -> None: ...


class AblyRealtimePublisher:
    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key if api_key is not None else os.getenv("ABLY_API_KEY")

    async def publish(self, room: str, event: str, payload: Any) -> None:
        if not self.api_key:
            return
        try:
            username, password = self.api_key.split(":", 1)
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    f"https://rest.ably.io/channels/{quote(room, safe='')}/messages",
                    auth=(username, password),
                    json={"name": event, "data": jsonable_encoder(payload)},
                )
        except Exception as exc:
            # The database write is authoritative; realtime delivery is best effort.
            logger.warning(
                "realtime_publish_failed",
                extra={"room": room, "event": event, "error_type": type(exc).__name__},
                exc_info=exc,
            )
            return


realtime_publisher: RealtimePublisher = AblyRealtimePublisher()


async def emit_to_channel(channel_id: str, event: str, payload: Any) -> None:
    await realtime_publisher.publish(f"channel:{channel_id}", event, payload)


async def emit_to_user(user_id: str, event: str, payload: Any) -> None:
    await realtime_publisher.publish(f"user:{user_id}", event, payload)


def new_id() -> str:
    return uuid4().hex


def json_text(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=str)


def utcnow() -> datetime:
    # Prisma maps DateTime to PostgreSQL `timestamp without time zone`. Keep DB
    # values in naive UTC; FastAPI serializes them as ISO timestamps at the edge.
    return datetime.now(UTC).replace(tzinfo=None)


async def fetch_one(db: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    result = await db.execute(statement(sql), dict(params or {}))
    record = result.mappings().first()
    return dict(record) if record else None


async def fetch_all(db: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    result = await db.execute(statement(sql), dict(params or {}))
    return [dict(row) for row in result.mappings().all()]


async def require_scope(principal: Principal, scope: str) -> None:
    if not principal.has_scope(scope):
        raise HTTPException(status_code=403, detail=f"Required scope: {scope}")


async def require_channel_member(db: AsyncConnection, channel_id: str, principal: Principal) -> dict[str, Any]:
    member = await fetch_one(
        db,
        'SELECT id, role, muted, "lastReadAt" FROM channel_members '
        'WHERE "channelId" = :channel_id AND "userId" = :user_id',
        {"channel_id": channel_id, "user_id": principal.id},
    )
    if not member:
        raise HTTPException(status_code=403, detail="You are not a member of this channel")
    return member


async def can_manage_channel(db: AsyncConnection, channel_id: str, principal: Principal) -> bool:
    row = await fetch_one(
        db,
        "SELECT c.type::text AS type, cm.role FROM channels c "
        'LEFT JOIN channel_members cm ON cm."channelId" = c.id AND cm."userId" = :user_id '
        "WHERE c.id = :channel_id",
        {"channel_id": channel_id, "user_id": principal.id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="Channel not found")
    if row["role"] in {"OWNER", "ADMIN"}:
        return True
    return principal.role == "ADMIN" and row["type"] != "DM"


async def require_meeting_access(
    db: AsyncConnection, meeting_id: str, principal: Principal, *, manage: bool = False
) -> dict[str, Any]:
    meeting = await fetch_one(
        db,
        'SELECT m.id, m.title, m."createdById", m."startTime", m."endTime", m.recurrence, '
        'EXISTS(SELECT 1 FROM meeting_attendees ma WHERE ma."meetingId" = m.id '
        'AND ma."userId" = :user_id) AS attendee '
        "FROM meetings m WHERE m.id = :meeting_id",
        {"meeting_id": meeting_id, "user_id": principal.id},
    )
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    allowed = principal.role == "ADMIN" or meeting["createdById"] == principal.id
    if not manage:
        allowed = allowed or bool(meeting["attendee"])
    if not allowed:
        raise HTTPException(status_code=403, detail="You do not have access to this meeting")
    return meeting


def notification_category(type: str) -> str | None:
    if type.startswith("task_"):
        return "task"
    if type == "mention":
        return "mention"
    for prefix in ("meeting", "leave", "invoice", "project", "resignation", "note"):
        if type.startswith(f"{prefix}_"):
            return prefix
    if type.startswith(("client_", "contract_")):
        return "client"
    return None


def notification_channel_allowed(prefs: Any, category: str | None, channel: str) -> bool:
    if category is None or not isinstance(prefs, dict):
        return True
    category_prefs = prefs.get(category)
    if not isinstance(category_prefs, dict):
        return True
    return category_prefs.get(channel) is not False


async def insert_notifications(
    db: AsyncConnection,
    user_ids: Iterable[str],
    *,
    title: str,
    message: str,
    type: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
) -> list[str]:
    delivered: list[str] = []
    category = notification_category(type)
    for user_id in dict.fromkeys(user_ids):
        recipient = await fetch_one(
            db,
            'SELECT id, "notificationPrefs" FROM users WHERE id = :id',
            {"id": user_id},
        )
        if not recipient or not notification_channel_allowed(recipient["notificationPrefs"], category, "inApp"):
            continue
        await db.execute(
            statement(
                "INSERT INTO notifications "
                '(id, "userId", title, message, type, "isRead", "entityType", "entityId", "createdAt") '
                "VALUES (:id, :user_id, :title, :message, :type, false, :entity_type, :entity_id, :now)"
            ),
            {
                "id": new_id(),
                "user_id": user_id,
                "title": title,
                "message": message,
                "type": type,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "now": utcnow(),
            },
        )
        delivered.append(user_id)
    return delivered


async def insert_activity(
    db: AsyncConnection,
    principal: Principal,
    *,
    type: str,
    message: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    metadata: Any | None = None,
) -> None:
    await db.execute(
        statement(
            "INSERT INTO activities "
            '(id, type, message, "userId", "entityType", "entityId", metadata, "createdAt") '
            "VALUES (:id, :type, :message, :user_id, :entity_type, :entity_id, "
            "CAST(:metadata AS jsonb), :now)"
        ),
        {
            "id": new_id(),
            "type": type,
            "message": message,
            "user_id": principal.id,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "metadata": json_text(metadata) if metadata is not None else None,
            "now": utcnow(),
        },
    )


async def collaboration_audit_event(
    db: AsyncConnection,
    principal: Principal,
    *,
    category: str,
    operation: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    target_label: str | None = None,
    description: str | None = None,
    input_data: Any = None,
    changes: Any = None,
    metadata: Any = None,
) -> None:
    # Keep collaboration routers aligned with the shared audit contract while
    # retaining a single import seam for eventual middleware consolidation.
    from .firm_common import audit_event

    await audit_event(
        db,
        principal,
        category=category,
        operation=operation,
        action=action,
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        description=description,
        input_data=input_data,
        changes=changes,
        metadata=metadata,
    )
