from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncConnection

from ..collaboration_schemas import NotificationPrefs, SuccessOut
from ..database import connection, row_dict, statement
from ..security import Principal, current_principal
from .collaboration_common import (
    collaboration_audit_event,
    fetch_all,
    fetch_one,
    json_text,
    require_scope,
)

router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])


@router.get("")
async def get_notifications(
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
    unread_only: bool = Query(False, alias="unreadOnly"),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "notifications:read")
    clauses = ['"userId" = :user_id']
    params: dict[str, Any] = {"user_id": principal.id, "take": limit}
    if unread_only:
        clauses.append('"isRead" = false')
    if cursor:
        clauses.append(
            '("createdAt", id) < (SELECT "createdAt", id FROM notifications WHERE id = :cursor AND "userId" = :user_id)'
        )
        params["cursor"] = cursor
    return await fetch_all(
        db,
        'SELECT id, "userId", title, message, type, "isRead", "entityType", "entityId", '
        '"createdAt" FROM notifications WHERE '
        + " AND ".join(clauses)
        + ' ORDER BY "createdAt" DESC, id DESC LIMIT :take',
        params,
    )


@router.patch("/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "notifications:write")
    owner = await fetch_one(db, 'SELECT "userId" FROM notifications WHERE id = :id', {"id": notification_id})
    if not owner:
        raise HTTPException(status_code=404, detail="Notification not found")
    if owner["userId"] != principal.id:
        raise HTTPException(status_code=403, detail="You can only update your notifications")
    result = await db.execute(
        statement('UPDATE notifications SET "isRead" = true WHERE id = :id RETURNING *'),
        {"id": notification_id},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="NOTIFICATIONS",
        operation="UPDATE",
        action="notifications.read",
        target_type="Notification",
        target_id=notification_id,
    )
    await db.commit()
    return row_dict(result.mappings().one())


@router.post("/read-all", response_model=SuccessOut)
async def mark_all_notifications_read(
    principal: Principal = Depends(current_principal), db: AsyncConnection = Depends(connection)
) -> SuccessOut:
    await require_scope(principal, "notifications:write")
    await db.execute(
        statement('UPDATE notifications SET "isRead" = true WHERE "userId" = :id AND "isRead" = false'),
        {"id": principal.id},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="NOTIFICATIONS",
        operation="UPDATE",
        action="notifications.read_all",
        target_type="Notification",
    )
    await db.commit()
    return SuccessOut()


@router.get("/preferences")
async def get_notification_preferences(
    principal: Principal = Depends(current_principal), db: AsyncConnection = Depends(connection)
) -> dict[str, Any] | None:
    await require_scope(principal, "notifications:read")
    result = await fetch_one(db, 'SELECT "notificationPrefs" FROM users WHERE id = :id', {"id": principal.id})
    return result["notificationPrefs"] if result else None


@router.put("/preferences", response_model=SuccessOut)
async def update_notification_preferences(
    payload: NotificationPrefs,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> SuccessOut:
    await require_scope(principal, "notifications:write")
    await db.execute(
        statement('UPDATE users SET "notificationPrefs" = CAST(:prefs AS jsonb) WHERE id = :id'),
        {"prefs": json_text(payload.model_dump(by_alias=True)), "id": principal.id},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="NOTIFICATIONS",
        operation="UPDATE",
        action="notifications.preferences.update",
        target_type="User",
        target_id=principal.id,
        changes=payload.model_dump(by_alias=True, exclude_none=True),
    )
    await db.commit()
    return SuccessOut()
