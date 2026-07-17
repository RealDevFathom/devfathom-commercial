from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection
from ..security import Principal, current_principal
from .collaboration_common import fetch_all, require_scope

router = APIRouter(prefix="/api/v1/search", tags=["search"])
COLLABORATION_SEARCH_KEYS = ("notes", "messages", "meetings", "team")


async def collaboration_search_sections(
    db: AsyncConnection, principal: Principal, query: str
) -> dict[str, list[dict[str, Any]]]:
    """Composable sections for the canonical `/api/v1/search` legacy response."""
    value = query.strip()
    if not value:
        return {key: [] for key in COLLABORATION_SEARCH_KEYS}
    like = f"%{value}%"
    notes = await fetch_all(
        db,
        "SELECT n.id, n.title, n.visibility::text AS visibility, "
        "jsonb_build_object('id', u.id, 'name', u.name) AS author FROM notes n "
        'JOIN users u ON u.id = n."authorId" WHERE (n.title ILIKE :query OR n."contentText" ILIKE :query) '
        "AND (n.\"authorId\" = :user_id OR n.visibility::text = 'TEAM' OR "
        "(n.visibility::text = 'SHARED' AND EXISTS(SELECT 1 FROM note_shares ns "
        'WHERE ns."noteId" = n.id AND ns."userId" = :user_id))) '
        'ORDER BY n."updatedAt" DESC LIMIT 6',
        {"query": like, "user_id": principal.id},
    )
    messages = await fetch_all(
        db,
        'SELECT m.id, m."channelId", m.content, m."createdAt", '
        "jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS sender "
        'FROM messages m JOIN users u ON u.id = m."senderId" WHERE m."deletedAt" IS NULL '
        "AND m.content ILIKE :query AND EXISTS(SELECT 1 FROM channel_members cm "
        'WHERE cm."channelId" = m."channelId" AND cm."userId" = :user_id) '
        'ORDER BY m."createdAt" DESC LIMIT 6',
        {"query": like, "user_id": principal.id},
    )
    meetings = await fetch_all(
        db,
        'SELECT m.id, m.title, m.description, m."startTime", m."endTime", m.location, m.recurrence '
        "FROM meetings m WHERE (m.title ILIKE :query OR COALESCE(m.description, '') ILIKE :query) "
        'AND (m."createdById" = :user_id OR EXISTS(SELECT 1 FROM meeting_attendees ma '
        'WHERE ma."meetingId" = m.id AND ma."userId" = :user_id)) '
        'ORDER BY m."startTime" DESC LIMIT 6',
        {"query": like, "user_id": principal.id},
    )
    team = await fetch_all(
        db,
        "SELECT id, name, title, avatar FROM users WHERE status::text <> 'INACTIVE' "
        "AND (name ILIKE :query OR email ILIKE :query OR COALESCE(title, '') ILIKE :query) "
        "ORDER BY name LIMIT 6",
        {"query": like},
    )
    return {"notes": notes, "messages": messages, "meetings": meetings, "team": team}


async def legacy_search_sections(
    db: AsyncConnection, principal: Principal, query: str
) -> dict[str, list[dict[str, Any]]]:
    """Notes/team hook matching the legacy projects/tasks/clients/notes/team composition."""
    sections = await collaboration_search_sections(db, principal, query)
    return {"notes": sections["notes"], "team": sections["team"]}


@router.get("/collaboration")
async def collaboration_search(
    query: str = Query(min_length=0),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, list[dict[str, Any]]]:
    await require_scope(principal, "search:read")
    return await collaboration_search_sections(db, principal, query)
