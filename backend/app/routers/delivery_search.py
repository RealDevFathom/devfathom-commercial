from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection
from ..security import Principal, current_principal
from .domain_common import fetch_all

router = APIRouter(prefix="/api/v1", tags=["search"])


async def search_groups(
    query: str,
    principal: Principal,
    db: AsyncConnection,
) -> dict[str, list[dict[str, Any]]]:
    q = query.strip()
    empty: dict[str, list[dict[str, Any]]] = {
        "projects": [],
        "tasks": [],
        "clients": [],
        "notes": [],
        "team": [],
    }
    if not q:
        return empty
    pattern = f"%{q}%"
    project_visibility = (
        ""
        if principal.role == "ADMIN"
        else 'AND EXISTS (SELECT 1 FROM project_members pm WHERE pm."projectId" = p.id AND pm."userId" = :user_id)'
    )
    if principal.has_scope("projects:read"):
        empty["projects"] = await fetch_all(
            db,
            "SELECT p.id, p.name, p.type::text AS type, p.status::text AS status, "
            "CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'name', c.name) END AS client "
            'FROM projects p LEFT JOIN clients c ON c.id = p."clientId" '
            f'WHERE p.name ILIKE :pattern {project_visibility} ORDER BY p."updatedAt" DESC LIMIT 6',
            {"pattern": pattern, "user_id": principal.id},
        )
    if principal.has_scope("tasks:read"):
        empty["tasks"] = await fetch_all(
            db,
            "SELECT t.id, t.title, t.priority::text AS priority, "
            "json_build_object('board', json_build_object('id', b.id, 'project', json_build_object('id', p.id, 'name', p.name))) AS column "
            'FROM tasks t JOIN columns c ON c.id = t."columnId" JOIN boards b ON b.id = c."boardId" '
            'JOIN projects p ON p.id = b."projectId" WHERE t.title ILIKE :pattern '
            f'{project_visibility} ORDER BY t."updatedAt" DESC LIMIT 6',
            {"pattern": pattern, "user_id": principal.id},
        )
    # Session principals use the wildcard scope and retain the legacy UI directory
    # policy. Scoped REST tokens additionally need clients:read and an admin owner.
    if "*" in principal.scopes or (principal.role == "ADMIN" and principal.has_scope("clients:read")):
        empty["clients"] = await fetch_all(
            db,
            "SELECT id, name, industry FROM clients WHERE name ILIKE :pattern ORDER BY name LIMIT 6",
            {"pattern": pattern},
        )
    if principal.has_scope("notes:read"):
        empty["notes"] = await fetch_all(
            db,
            "SELECT n.id, n.title, n.visibility::text AS visibility, "
            "json_build_object('id', u.id, 'name', u.name) AS author "
            'FROM notes n JOIN users u ON u.id = n."authorId" '
            'WHERE (n.title ILIKE :pattern OR n."contentText" ILIKE :pattern) AND '
            "(n.\"authorId\" = :user_id OR n.visibility = 'TEAM' OR "
            'EXISTS (SELECT 1 FROM note_shares ns WHERE ns."noteId" = n.id AND ns."userId" = :user_id)) '
            'ORDER BY n."updatedAt" DESC LIMIT 6',
            {"pattern": pattern, "user_id": principal.id},
        )
    if principal.has_scope("team:read"):
        empty["team"] = await fetch_all(
            db,
            "SELECT id, name, title, avatar FROM users WHERE status <> 'INACTIVE' "
            "AND (name ILIKE :pattern OR email ILIKE :pattern OR title ILIKE :pattern) ORDER BY name LIMIT 6",
            {"pattern": pattern},
        )
    return empty


@router.get("/search")
async def global_search(
    query: str = Query(""),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    return {"data": await search_groups(query, principal, db)}
