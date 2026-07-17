import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection, row_dict, rows, statement
from ..schemas_admin import ApiTokenCreate, WebhookCreate, WebhookUpdate
from ..scopes import GRANTABLE_SCOPES
from ..security import Principal, current_principal
from .firm_common import as_naive_utc, audit_event, generate_api_token, new_id, require_roles, utcnow_naive

router = APIRouter(prefix="/api/admin", tags=["administration"])
WEBHOOK_EVENTS = {"invoice.paid", "task.created"}


def admin_scope(scope: str):
    async def dependency(principal: Principal = Depends(current_principal)) -> Principal:
        require_roles(principal, "ADMIN")
        if not principal.has_scope(scope):
            raise HTTPException(status_code=403, detail=f"Required scope: {scope}")
        return principal

    return dependency


api_tokens_read = admin_scope("api-tokens:read")
api_tokens_write = admin_scope("api-tokens:write")
webhooks_read = admin_scope("webhooks:read")
webhooks_write = admin_scope("webhooks:write")
audit_read = admin_scope("audit:read")


def validate_delegated_scopes(principal: Principal, requested_scopes: list[str]) -> None:
    """Prevent a token creator from delegating authority they do not possess."""
    if "*" in requested_scopes and "*" not in principal.scopes:
        raise HTTPException(status_code=403, detail="Only a wildcard-authorized caller may issue a wildcard token")
    unauthorized = sorted(scope for scope in set(requested_scopes) if scope != "*" and not principal.has_scope(scope))
    if unauthorized:
        raise HTTPException(
            status_code=403,
            detail=f"Cannot delegate scopes outside caller authority: {', '.join(unauthorized)}",
        )


@router.get("/api-tokens")
async def list_api_tokens(_: Principal = Depends(api_tokens_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement(
            'SELECT t.id, t.name, t.prefix, t.scopes, t."userId", t."lastUsedAt", t."expiresAt", t."createdAt", '
            'u.name AS "userName", u.email AS "userEmail", u.avatar AS "userAvatar", u.role::text AS "userRole" '
            'FROM api_tokens t JOIN users u ON u.id = t."userId" ORDER BY t."createdAt" DESC'
        )
    )
    return {"data": rows(result)}


@router.get("/api-tokens/scopes")
async def grantable_api_token_scopes(_: Principal = Depends(api_tokens_read)) -> dict:
    return {"data": ["*", *sorted(GRANTABLE_SCOPES)]}


@router.get("/api-tokens/usage")
async def api_token_usage(_: Principal = Depends(api_tokens_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement(
            """SELECT t.id,
            COUNT(a.id)::int AS total,
            COUNT(a.id) FILTER (WHERE a.outcome = 'SUCCESS')::int AS success,
            COUNT(a.id) FILTER (WHERE a.outcome = 'FAILURE')::int AS failure,
            COUNT(a.id) FILTER (WHERE a."createdAt" >= now() - interval '7 days')::int AS "last7d",
            MAX(a."createdAt") AS "lastUsedAt"
            FROM api_tokens t LEFT JOIN audit_logs a ON a."tokenId" = t.id AND a.source = 'REST_API'
            GROUP BY t.id"""
        )
    )
    return {
        row["id"]: {key: row_dict(row)[key] for key in ("total", "success", "failure", "last7d", "lastUsedAt")}
        for row in result.mappings()
    }


@router.post("/api-tokens", status_code=status.HTTP_201_CREATED)
async def create_api_token(
    payload: ApiTokenCreate, principal: Principal = Depends(api_tokens_write), db: AsyncConnection = Depends(connection)
) -> dict:
    # Validate before target lookup or token generation so rejected delegation
    # never creates a secret or touches persistence.
    validate_delegated_scopes(principal, payload.scopes)
    target_id = payload.user_id or principal.id
    target = await db.execute(
        statement("SELECT id, name, status::text status FROM users WHERE id = :id"), {"id": target_id}
    )
    user = target.mappings().first()
    if not user:
        raise HTTPException(status_code=404, detail="Target user not found")
    if user["status"] not in {"ACTIVE", "ON_LEAVE"}:
        raise HTTPException(status_code=400, detail="Cannot issue a token for an inactive user")
    token, prefix, token_hash = generate_api_token()
    token_id = new_id()
    expires_at = utcnow_naive() + timedelta(days=payload.expires_in_days) if payload.expires_in_days else None
    await db.execute(
        statement(
            'INSERT INTO api_tokens (id, name, prefix, "tokenHash", scopes, "userId", "expiresAt", "createdAt") VALUES (:id, :name, :prefix, :token_hash, :scopes, :user_id, :expires_at, now())'
        ),
        {
            "id": token_id,
            "name": payload.name,
            "prefix": prefix,
            "token_hash": token_hash,
            "scopes": payload.scopes,
            "user_id": target_id,
            "expires_at": expires_at,
        },
    )
    await audit_event(
        db,
        principal,
        category="API_TOKEN",
        operation="CREATE",
        action="apiTokens.create",
        target_type="ApiToken",
        target_id=token_id,
        target_label=payload.name,
        metadata={
            "scopes": payload.scopes,
            "prefix": prefix,
            "boundUserId": target_id,
            "expiresAt": expires_at.isoformat() if expires_at else None,
        },
    )
    await db.commit()
    return {
        "id": token_id,
        "token": token,
        "name": payload.name,
        "prefix": prefix,
        "scopes": payload.scopes,
        "expiresAt": expires_at,
        "boundUser": {"id": target_id, "name": user["name"]},
    }


@router.delete("/api-tokens/{token_id}")
async def revoke_api_token(
    token_id: str, principal: Principal = Depends(api_tokens_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement("DELETE FROM api_tokens WHERE id = :id RETURNING id, name, prefix, scopes"), {"id": token_id}
    )
    token = result.mappings().first()
    if not token:
        raise HTTPException(status_code=404, detail="API token not found")
    await audit_event(
        db,
        principal,
        category="API_TOKEN",
        operation="DELETE",
        action="apiTokens.revoke",
        target_type="ApiToken",
        target_id=token_id,
        target_label=token["name"],
        metadata={"prefix": token["prefix"], "scopes": token["scopes"]},
    )
    await db.commit()
    return {"success": True}


WEBHOOK_SELECT = 'id, url, events, active, "createdById", "createdAt", "updatedAt"'


def validate_webhook_events(events: list[str]) -> None:
    unknown = set(events) - WEBHOOK_EVENTS
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unsupported webhook events: {', '.join(sorted(unknown))}")


@router.get("/webhooks")
async def list_webhooks(_: Principal = Depends(webhooks_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement(
            f'SELECT w.{WEBHOOK_SELECT.replace(", ", ", w.")}, u.name AS "createdByName", '
            '(SELECT COUNT(*) FROM webhook_deliveries d WHERE d."webhookId" = w.id)::int AS "deliveryCount" '
            'FROM webhooks w JOIN users u ON u.id = w."createdById" ORDER BY w."createdAt" DESC'
        )
    )
    data = rows(result)
    for webhook in data:
        deliveries = await db.execute(
            statement(
                'SELECT id, event, "statusCode", success, error, "attemptedAt" FROM webhook_deliveries WHERE "webhookId" = :id ORDER BY "attemptedAt" DESC LIMIT 5'
            ),
            {"id": webhook["id"]},
        )
        webhook["deliveries"] = rows(deliveries)
    return {"data": data}


@router.get("/webhooks/{webhook_id}/deliveries")
async def recent_webhook_deliveries(
    webhook_id: str, _: Principal = Depends(webhooks_read), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement(
            'SELECT id, event, "statusCode", success, error, "attemptedAt" FROM webhook_deliveries WHERE "webhookId" = :id ORDER BY "attemptedAt" DESC LIMIT 20'
        ),
        {"id": webhook_id},
    )
    return {"data": rows(result)}


@router.post("/webhooks", status_code=status.HTTP_201_CREATED)
async def create_webhook(
    payload: WebhookCreate, principal: Principal = Depends(webhooks_write), db: AsyncConnection = Depends(connection)
) -> dict:
    validate_webhook_events(payload.events)
    webhook_id = new_id()
    signing_secret = secrets.token_hex(32)
    result = await db.execute(
        statement(
            f'INSERT INTO webhooks (id, url, secret, events, active, "createdById", "createdAt", "updatedAt") VALUES (:id, :url, :secret, :events, :active, :creator, now(), now()) RETURNING {WEBHOOK_SELECT}'
        ),
        {
            "id": webhook_id,
            "url": str(payload.url),
            "secret": signing_secret,
            "events": payload.events,
            "active": payload.active,
            "creator": principal.id,
        },
    )
    record = row_dict(result.mappings().one())
    await audit_event(
        db,
        principal,
        category="SYSTEM",
        operation="CREATE",
        action="webhooks.create",
        target_type="Webhook",
        target_id=webhook_id,
        target_label=str(payload.url),
        metadata={"events": payload.events, "active": payload.active},
    )
    await db.commit()
    return {"data": {**record, "secret": signing_secret}}


@router.patch("/webhooks/{webhook_id}")
async def update_webhook(
    webhook_id: str,
    payload: WebhookUpdate,
    principal: Principal = Depends(webhooks_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    supplied = payload.model_fields_set
    if not supplied:
        raise HTTPException(status_code=422, detail="No fields were supplied")
    if payload.events is not None:
        validate_webhook_events(payload.events)
    values = payload.model_dump(include=supplied)
    if "url" in values:
        values["url"] = str(values["url"])
    values.update({"id": webhook_id})
    assignments = [f'"{key}" = :{key}' for key in supplied] + ['"updatedAt" = now()']
    result = await db.execute(
        statement(f"UPDATE webhooks SET {', '.join(assignments)} WHERE id = :id RETURNING {WEBHOOK_SELECT}"), values
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Webhook not found")
    await audit_event(
        db,
        principal,
        category="SYSTEM",
        operation="UPDATE",
        action="webhooks.update",
        target_type="Webhook",
        target_id=webhook_id,
        target_label=record["url"],
        input_data=values,
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.delete("/webhooks/{webhook_id}")
async def delete_webhook(
    webhook_id: str, principal: Principal = Depends(webhooks_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement(f"DELETE FROM webhooks WHERE id = :id RETURNING {WEBHOOK_SELECT}"), {"id": webhook_id}
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Webhook not found")
    await audit_event(
        db,
        principal,
        category="SYSTEM",
        operation="DELETE",
        action="webhooks.delete",
        target_type="Webhook",
        target_id=webhook_id,
        target_label=record["url"],
        metadata={"events": record["events"]},
    )
    await db.commit()
    return {"success": True}


@router.get("/audit-logs")
async def list_audit_logs(
    search: str | None = None,
    actor_id: str | None = None,
    actor_type: str | None = None,
    category: str | None = None,
    operation: str | None = None,
    source: str | None = None,
    outcome: str | None = None,
    action: str | None = None,
    assistant_only: bool = False,
    target_type: str | None = None,
    target_id: str | None = None,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    _: Principal = Depends(audit_read),
    db: AsyncConnection = Depends(connection),
) -> dict:
    clauses = []
    values: dict[str, object] = {"limit": limit + 1}
    exact = {
        "actor_id": ('"actorId"', actor_id),
        "actor_type": ('"actorType"', actor_type),
        "category": ("category", category),
        "operation": ("operation", operation),
        "source": ("source", source),
        "outcome": ("outcome", outcome),
        "target_type": ('"targetType"', target_type),
        "target_id": ('"targetId"', target_id),
    }
    for key, (column, value) in exact.items():
        if value is not None:
            clauses.append(f"{column} = :{key}")
            values[key] = value
    if assistant_only:
        clauses.append("action LIKE 'assistant.%'")
    elif action:
        clauses.append("action = :action")
        values["action"] = action
    if start_date:
        clauses.append('"createdAt" >= :start_date')
        values["start_date"] = as_naive_utc(start_date)
    if end_date:
        clauses.append('"createdAt" <= :end_date')
        values["end_date"] = as_naive_utc(end_date)
    if cursor:
        clauses.append('("createdAt", id) < (SELECT "createdAt", id FROM audit_logs WHERE id = :cursor)')
        values["cursor"] = cursor
    if search:
        clauses.append(
            'concat_ws(\' \', "actorName", "actorEmail", action, description, "targetLabel", "targetId", "tokenName", ip, path, "errorMessage") ILIKE :search'
        )
        values["search"] = f"%{search}%"
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    result = await db.execute(
        statement(f'SELECT * FROM audit_logs {where} ORDER BY "createdAt" DESC, id DESC LIMIT :limit'), values
    )
    data = rows(result)
    next_cursor = data.pop()["id"] if len(data) > limit else None
    return {"items": data, "nextCursor": next_cursor}


@router.get("/audit-logs/stats")
async def audit_stats(_: Principal = Depends(audit_read), db: AsyncConnection = Depends(connection)) -> dict:
    headline = await db.execute(
        statement(
            "SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE outcome = 'FAILURE')::int failures, COUNT(*) FILTER (WHERE \"createdAt\" >= now() - interval '24 hours')::int \"last24h\", COUNT(*) FILTER (WHERE outcome = 'FAILURE' AND \"createdAt\" >= now() - interval '24 hours')::int \"failures24h\" FROM audit_logs"
        )
    )
    categories = await db.execute(
        statement("SELECT category, COUNT(*)::int count FROM audit_logs GROUP BY category ORDER BY count DESC")
    )
    actors = await db.execute(
        statement(
            'SELECT "actorId" AS id, MAX("actorName") AS name, COUNT(*)::int count FROM audit_logs WHERE "actorId" IS NOT NULL AND "createdAt" >= now() - interval \'24 hours\' GROUP BY "actorId" ORDER BY count DESC LIMIT 5'
        )
    )
    return {**row_dict(headline.mappings().one()), "byCategory": rows(categories), "topActors": rows(actors)}


@router.get("/audit-logs/filters")
async def audit_filters(_: Principal = Depends(audit_read), db: AsyncConnection = Depends(connection)) -> dict:
    categories = await db.execute(statement("SELECT DISTINCT category FROM audit_logs ORDER BY category"))
    actions = await db.execute(statement("SELECT DISTINCT action FROM audit_logs ORDER BY action LIMIT 500"))
    actors = await db.execute(
        statement(
            'SELECT "actorId" AS id, MAX("actorName") AS name, COUNT(*)::int count FROM audit_logs WHERE "actorId" IS NOT NULL GROUP BY "actorId" ORDER BY count DESC'
        )
    )
    return {
        "categories": [row[0] for row in categories],
        "actions": [row[0] for row in actions],
        "actors": rows(actors),
        "operations": ["CREATE", "READ", "UPDATE", "DELETE", "LOGIN", "LOGOUT", "LOGIN_FAILED", "EXECUTE", "OTHER"],
        "sources": ["TRPC", "REST_API", "AUTH", "SYSTEM"],
        "outcomes": ["SUCCESS", "FAILURE"],
    }
