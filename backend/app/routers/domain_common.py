import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import json_value, statement
from ..security import Principal


def new_id() -> str:
    return uuid4().hex


def record(row: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {key: json_value(value) for key, value in row.items()}


def bind_value(value: Any) -> Any:
    """Normalize values for Prisma's timestamp(3) PostgreSQL columns."""
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.astimezone(UTC).replace(tzinfo=None)
    if isinstance(value, list):
        return [bind_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(bind_value(item) for item in value)
    if isinstance(value, dict):
        return {key: bind_value(item) for key, item in value.items()}
    return value


def bind_values(values: Mapping[str, Any] | None) -> dict[str, Any]:
    return {key: bind_value(value) for key, value in (values or {}).items()}


async def fetch_one(db: AsyncConnection, sql: str, values: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    result = await db.execute(statement(sql), bind_values(values))
    return record(result.mappings().first())


async def fetch_all(db: AsyncConnection, sql: str, values: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    result = await db.execute(statement(sql), bind_values(values))
    return [record(row) or {} for row in result.mappings().all()]


async def execute(db: AsyncConnection, sql: str, values: Mapping[str, Any] | None = None) -> None:
    await db.execute(statement(sql), bind_values(values))


def dump(model: Any, *, exclude_unset: bool = False) -> dict[str, Any]:
    return model.model_dump(by_alias=True, exclude_unset=exclude_unset, mode="python")


def unique(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(values))


def require_scope(principal: Principal, scope: str) -> None:
    if not principal.has_scope(scope):
        raise HTTPException(status_code=403, detail=f"Required scope: {scope}")


def require_admin(principal: Principal) -> None:
    if principal.role != "ADMIN":
        raise HTTPException(status_code=403, detail="This operation requires an admin account")


async def project_access(
    db: AsyncConnection,
    principal: Principal,
    project_id: str,
    *,
    manage: bool = False,
) -> None:
    if principal.role == "ADMIN":
        exists = await fetch_one(db, "SELECT id FROM projects WHERE id = :id", {"id": project_id})
        if not exists:
            raise HTTPException(status_code=404, detail="Project not found")
        return
    membership = await fetch_one(
        db,
        'SELECT role FROM project_members WHERE "projectId" = :project_id AND "userId" = :user_id',
        {"project_id": project_id, "user_id": principal.id},
    )
    if not membership or (manage and membership["role"] != "LEAD"):
        raise HTTPException(status_code=403, detail="You do not have access to this project")


async def related_project_id(
    db: AsyncConnection,
    entity: Literal["board", "column", "task"],
    entity_id: str,
) -> str:
    queries = {
        "board": 'SELECT "projectId" FROM boards WHERE id = :id',
        "column": ('SELECT b."projectId" FROM columns c JOIN boards b ON b.id = c."boardId" WHERE c.id = :id'),
        "task": (
            'SELECT b."projectId" FROM tasks t JOIN columns c ON c.id = t."columnId" '
            'JOIN boards b ON b.id = c."boardId" WHERE t.id = :id'
        ),
    }
    row = await fetch_one(db, queries[entity], {"id": entity_id})
    if not row:
        raise HTTPException(status_code=404, detail=f"{entity.capitalize()} not found")
    return row["projectId"]


async def related_access(
    db: AsyncConnection,
    principal: Principal,
    entity: Literal["board", "column", "task"],
    entity_id: str,
    *,
    manage: bool = False,
) -> str:
    project_id = await related_project_id(db, entity, entity_id)
    await project_access(db, principal, project_id, manage=manage)
    return project_id


async def log_activity(
    db: AsyncConnection,
    principal: Principal,
    *,
    type: str,
    message: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> None:
    await execute(
        db,
        'INSERT INTO activities (id, type, message, "userId", "entityType", "entityId", metadata, "createdAt") '
        "VALUES (:id, :type, :message, :user_id, :entity_type, :entity_id, CAST(:metadata AS jsonb), :created_at)",
        {
            "id": new_id(),
            "type": type,
            "message": message,
            "user_id": principal.id,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "metadata": json.dumps(metadata) if metadata is not None else None,
            "created_at": datetime.now(UTC),
        },
    )
