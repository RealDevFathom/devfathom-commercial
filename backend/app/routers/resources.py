from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import DataError, IntegrityError, StatementError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection, row_dict, rows, statement
from ..schemas import ResourcePayload
from ..security import Principal, current_principal
from .domain_common import bind_values

router = APIRouter(prefix="/api/v1", tags=["resources"])


@dataclass(frozen=True)
class Resource:
    table: str
    read_scope: str
    write_scope: str | None
    columns: tuple[str, ...]
    writable: tuple[str, ...] = ()
    nullable: tuple[str, ...] = ()
    order_by: str = '"updatedAt" DESC'
    admin_only: bool = False


RESOURCES: dict[str, Resource] = {
    "projects": Resource(
        "projects",
        "projects:read",
        "projects:write",
        (
            "id",
            "name",
            "description",
            "status",
            "type",
            "startDate",
            "endDate",
            "techStack",
            "budget",
            "clientId",
            "createdAt",
            "updatedAt",
        ),
        ("name", "description", "status", "type", "startDate", "endDate", "techStack", "budget", "clientId"),
        ("description", "startDate", "endDate", "budget", "clientId"),
    ),
    "clients": Resource(
        "clients",
        "clients:read",
        "clients:write",
        (
            "id",
            "name",
            "logo",
            "website",
            "industry",
            "location",
            "timezone",
            "notes",
            "status",
            "createdAt",
            "updatedAt",
        ),
        ("name", "logo", "website", "industry", "location", "timezone", "notes", "status"),
        ("logo", "website", "industry", "location", "timezone", "notes"),
    ),
    "meetings": Resource(
        "meetings",
        "meetings:read",
        "meetings:write",
        (
            "id",
            "title",
            "description",
            "startTime",
            "endTime",
            "location",
            "recurrence",
            "createdById",
            "createdAt",
            "updatedAt",
        ),
        ("title", "description", "startTime", "endTime", "location", "recurrence"),
        ("description", "location", "recurrence"),
        '"startTime" ASC',
    ),
    "tasks": Resource(
        "tasks",
        "tasks:read",
        "tasks:write",
        (
            "id",
            "title",
            "description",
            "columnId",
            "order",
            "priority",
            "dueDate",
            "createdById",
            "parentId",
            "createdAt",
            "updatedAt",
        ),
        ("title", "description", "columnId", "order", "priority", "dueDate", "parentId"),
        ("description", "dueDate", "parentId"),
    ),
    "invoices": Resource(
        "invoices",
        "finance:read",
        "finance:write",
        (
            "id",
            "invoiceNumber",
            "clientId",
            "projectId",
            "items",
            "subtotal",
            "tax",
            "total",
            "currency",
            "status",
            "dueDate",
            "paidAt",
            "sentAt",
            "notes",
            "createdAt",
            "updatedAt",
        ),
        (
            "invoiceNumber",
            "clientId",
            "projectId",
            "items",
            "subtotal",
            "tax",
            "total",
            "currency",
            "status",
            "dueDate",
            "paidAt",
            "sentAt",
            "notes",
        ),
        ("projectId", "paidAt", "sentAt", "notes"),
        admin_only=True,
    ),
    "transactions": Resource(
        "transactions",
        "finance:read",
        "finance:write",
        (
            "id",
            "type",
            "amount",
            "currency",
            "category",
            "description",
            "projectId",
            "clientId",
            "receiptUrl",
            "date",
            "createdAt",
            "updatedAt",
        ),
        ("type", "amount", "currency", "category", "description", "projectId", "clientId", "receiptUrl", "date"),
        ("category", "projectId", "clientId", "receiptUrl"),
        "date DESC",
        admin_only=True,
    ),
    "team": Resource(
        "users",
        "team:read",
        None,
        (
            "id",
            "name",
            "email",
            "role",
            "department",
            "title",
            "avatar",
            "skills",
            "startDate",
            "status",
            "lastActiveAt",
        ),
        order_by="name ASC",
    ),
}

MIGRATED_DOMAIN_WRITES = frozenset(name for name, resource in RESOURCES.items() if resource.write_scope)
DOMAIN_WRITE_PATHS = {
    "projects": "/api/v1/projects",
    "clients": "/api/v1/clients",
    "meetings": "/api/v1/meetings",
    "tasks": "/api/v1/tasks",
    "invoices": "/api/finance/invoices",
    "transactions": "/api/finance/transactions",
}


def quoted(identifier: str) -> str:
    return f'"{identifier}"'


def select_columns(resource: Resource) -> str:
    return ", ".join(quoted(column) for column in resource.columns)


async def authorize(resource: Resource, principal: Principal, write: bool = False) -> None:
    required = resource.write_scope if write else resource.read_scope
    if required is None or not principal.has_scope(required):
        raise HTTPException(status_code=403, detail=f"Required scope: {required}")
    if resource.admin_only and principal.role != "ADMIN":
        raise HTTPException(status_code=403, detail="This resource requires an admin account")


def get_resource(name: str) -> Resource:
    resource = RESOURCES.get(name)
    if not resource:
        raise HTTPException(status_code=404, detail=f"The {name} module has not moved to FastAPI yet")
    return resource


def require_domain_write(resource_name: str) -> None:
    if resource_name in MIGRATED_DOMAIN_WRITES:
        raise HTTPException(
            status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
            detail=f"Use the validated domain endpoint: {DOMAIN_WRITE_PATHS[resource_name]}",
        )


def patch_values(resource: Resource, payload: ResourcePayload) -> dict[str, Any]:
    values = {key: value for key, value in payload.values(for_patch=True).items() if key in resource.writable}
    if not values:
        raise HTTPException(status_code=422, detail="No writable fields were supplied")
    invalid_nulls = sorted(key for key, value in values.items() if value is None and key not in resource.nullable)
    if invalid_nulls:
        raise HTTPException(status_code=422, detail=f"Fields cannot be null: {', '.join(invalid_nulls)}")
    return values


@router.get("/spec", include_in_schema=False)
async def api_spec() -> dict:
    return {"name": "DevFathom API", "openapi": "/openapi.json", "docs": "/docs", "version": "1.0"}


@router.get("/{resource_name}")
async def list_resources(
    resource_name: str,
    limit: int = Query(50, ge=1, le=100),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    resource = get_resource(resource_name)
    await authorize(resource, principal)
    result = await db.execute(
        statement(f"SELECT {select_columns(resource)} FROM {resource.table} ORDER BY {resource.order_by} LIMIT :limit"),
        {"limit": limit},
    )
    return {"data": rows(result)}


@router.post("/{resource_name}", status_code=status.HTTP_201_CREATED)
async def create_resource(
    resource_name: str,
    payload: ResourcePayload,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_domain_write(resource_name)
    resource = get_resource(resource_name)
    await authorize(resource, principal, write=True)
    values = {key: value for key, value in payload.values().items() if key in resource.writable}
    if not values:
        raise HTTPException(status_code=422, detail="No writable fields were supplied")
    now = datetime.now(UTC).replace(tzinfo=None)
    values.update({"id": uuid4().hex, "createdAt": now, "updatedAt": now})
    if resource_name in {"meetings", "tasks"}:
        values["createdById"] = principal.id
    columns = list(values)
    sql = (
        f"INSERT INTO {resource.table} ({', '.join(quoted(column) for column in columns)}) "
        f"VALUES ({', '.join(':' + column for column in columns)}) "
        f"RETURNING {select_columns(resource)}"
    )
    try:
        result = await db.execute(statement(sql), bind_values(values))
        await db.commit()
    except (IntegrityError, DataError, StatementError) as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="The resource did not pass database validation") from exc
    return {"data": row_dict(result.mappings().one())}


@router.get("/{resource_name}/{resource_id}")
async def get_resource_by_id(
    resource_name: str,
    resource_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    resource = get_resource(resource_name)
    await authorize(resource, principal)
    result = await db.execute(
        statement(f"SELECT {select_columns(resource)} FROM {resource.table} WHERE id = :id"),
        {"id": resource_id},
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Resource not found")
    return {"data": row_dict(record)}


@router.patch("/{resource_name}/{resource_id}")
async def update_resource(
    resource_name: str,
    resource_id: str,
    payload: ResourcePayload,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_domain_write(resource_name)
    resource = get_resource(resource_name)
    await authorize(resource, principal, write=True)
    values = patch_values(resource, payload)
    values.update({"id": resource_id, "updatedAt": datetime.now(UTC).replace(tzinfo=None)})
    assignments = ", ".join(f"{quoted(key)} = :{key}" for key in values if key != "id")
    try:
        result = await db.execute(
            statement(f"UPDATE {resource.table} SET {assignments} WHERE id = :id RETURNING {select_columns(resource)}"),
            bind_values(values),
        )
    except (IntegrityError, DataError, StatementError) as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="The resource did not pass database validation") from exc
    record = result.mappings().first()
    if not record:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Resource not found")
    await db.commit()
    return {"data": row_dict(record)}


@router.delete("/{resource_name}/{resource_id}")
async def delete_resource(
    resource_name: str,
    resource_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_domain_write(resource_name)
    resource = get_resource(resource_name)
    await authorize(resource, principal, write=True)
    result = await db.execute(
        statement(f"DELETE FROM {resource.table} WHERE id = :id RETURNING id"), {"id": resource_id}
    )
    if not result.first():
        await db.rollback()
        raise HTTPException(status_code=404, detail="Resource not found")
    await db.commit()
    return {"success": True}
