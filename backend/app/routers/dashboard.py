from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection, rows, statement
from ..security import Principal, current_principal

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

MONTH_LABELS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def recent_months(now: datetime, count: int = 6) -> list[tuple[str, str]]:
    months: list[tuple[str, str]] = []
    month_index = now.year * 12 + now.month - 1
    for offset in range(count - 1, -1, -1):
        index = month_index - offset
        year, zero_based_month = divmod(index, 12)
        month = zero_based_month + 1
        months.append((f"{year:04d}-{month:02d}", f"{MONTH_LABELS[month - 1]} {year}"))
    return months


@router.get("/stats")
async def stats(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    is_admin = principal.role == "ADMIN"
    can_projects = principal.has_scope("projects:read")
    can_tasks = principal.has_scope("tasks:read")
    can_team = principal.has_scope("team:read")
    can_finance = is_admin and principal.has_scope("finance:read")
    project_filter = (
        ""
        if is_admin
        else 'AND EXISTS (SELECT 1 FROM project_members pm WHERE pm."projectId" = p.id AND pm."userId" = :user_id)'
    )
    task_filter = (
        ""
        if is_admin
        else 'AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta."taskId" = t.id AND ta."userId" = :user_id)'
    )
    params = {"user_id": principal.id}

    active_projects = 0
    if can_projects:
        active_projects = await db.scalar(
            statement(f"SELECT count(*) FROM projects p WHERE p.status = 'ACTIVE' {project_filter}"), params
        )
    total_tasks = 0
    completed = 0
    if can_tasks:
        total_tasks = await db.scalar(statement(f"SELECT count(*) FROM tasks t WHERE true {task_filter}"), params)
        completed = await db.scalar(
            statement(
                'SELECT count(*) FROM tasks t JOIN columns c ON c.id = t."columnId" '
                f"WHERE c.name = 'Done' AND t.\"updatedAt\" >= now() - interval '7 days' {task_filter}"
            ),
            params,
        )
    pending_leaves = 0
    if can_team:
        leave_filter = "" if is_admin else 'AND "userId" = :user_id'
        pending_leaves = await db.scalar(
            statement(f"SELECT count(*) FROM leave_requests WHERE status = 'PENDING' {leave_filter}"), params
        )

    revenue: list[dict] = []
    expenses: list[dict] = []
    outstanding = 0
    if can_finance:
        result = await db.execute(
            statement(
                "SELECT currency::text AS currency, type::text AS type, coalesce(sum(amount), 0) AS amount "
                "FROM transactions WHERE date >= date_trunc('month', now()) AND date <= now() "
                "GROUP BY currency, type"
            )
        )
        groups = rows(result)
        revenue = [{"currency": row["currency"], "amount": row["amount"]} for row in groups if row["type"] == "INCOME"]
        expenses = [
            {"currency": row["currency"], "amount": row["amount"]} for row in groups if row["type"] == "EXPENSE"
        ]
        outstanding = int(
            await db.scalar(statement("SELECT count(*) FROM invoices WHERE status IN ('SENT', 'OVERDUE')")) or 0
        )

    return {
        "data": {
            "activeProjects": int(active_projects or 0),
            "totalTasks": int(total_tasks or 0),
            "completedTasksThisWeek": int(completed or 0),
            "pendingLeaves": int(pending_leaves or 0),
            "revenue": revenue,
            "expenses": expenses,
            "outstandingInvoices": outstanding,
            "isAdmin": is_admin,
        }
    }


@router.get("/revenue-chart")
async def revenue_chart(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    if principal.role != "ADMIN" or not principal.has_scope("finance:read"):
        raise HTTPException(status_code=403, detail="Revenue analytics require admin finance access")

    result = await db.execute(
        statement(
            "SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month, "
            "currency::text AS currency, type::text AS type, coalesce(sum(amount), 0) AS amount "
            "FROM transactions "
            "WHERE date >= date_trunc('month', CURRENT_DATE) - interval '5 months' "
            "AND date < date_trunc('month', CURRENT_DATE) + interval '1 month' "
            "GROUP BY date_trunc('month', date), currency, type "
            "ORDER BY date_trunc('month', date), currency, type"
        )
    )
    grouped = rows(result)
    months = recent_months(datetime.now(UTC))
    currencies = sorted({str(item["currency"]) for item in grouped}, key=lambda value: (value != "USD", value))
    by_currency: dict[str, list[dict]] = {}
    for currency in currencies:
        values = {
            (str(item["month"]), str(item["type"])): float(item["amount"])
            for item in grouped
            if item["currency"] == currency
        }
        by_currency[currency] = [
            {
                "month": label,
                "income": values.get((key, "INCOME"), 0),
                "expense": values.get((key, "EXPENSE"), 0),
                "profit": values.get((key, "INCOME"), 0) - values.get((key, "EXPENSE"), 0),
            }
            for key, label in months
        ]
    return {"data": {"currencies": currencies, "byCurrency": by_currency}}


@router.get("/deadlines")
async def deadlines(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    if not principal.has_scope("projects:read"):
        return {"data": []}
    membership = (
        ""
        if principal.role == "ADMIN"
        else 'AND EXISTS (SELECT 1 FROM project_members pm WHERE pm."projectId" = p.id AND pm."userId" = :user_id)'
    )
    result = await db.execute(
        statement(
            'SELECT m.id, m.name, m."dueDate", p.id AS "projectId", p.name AS "projectName", '
            'p.status::text AS "projectStatus" FROM milestones m '
            'JOIN projects p ON p.id = m."projectId" '
            f'WHERE m."completedAt" IS NULL AND m."dueDate" >= CURRENT_DATE {membership} '
            'ORDER BY m."dueDate" ASC LIMIT 10'
        ),
        {"user_id": principal.id},
    )
    return {"data": rows(result)}


@router.get("/my-tasks")
async def my_tasks(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    if not principal.has_scope("tasks:read"):
        return {"data": []}
    result = await db.execute(
        statement(
            'SELECT t.id, t.title, t.priority::text AS priority, t."dueDate", c.name AS "columnName", '
            'b.id AS "boardId", p.id AS "projectId", p.name AS "projectName" FROM tasks t '
            'JOIN task_assignees ta ON ta."taskId" = t.id '
            'JOIN columns c ON c.id = t."columnId" JOIN boards b ON b.id = c."boardId" '
            'JOIN projects p ON p.id = b."projectId" '
            "WHERE ta.\"userId\" = :user_id AND lower(c.name) <> 'done' "
            "ORDER BY CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 "
            "WHEN 'MEDIUM' THEN 2 ELSE 3 END, t.\"dueDate\" ASC NULLS LAST LIMIT 8"
        ),
        {"user_id": principal.id},
    )
    return {"data": rows(result)}


@router.get("/activity")
async def activity(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    conditions = [] if principal.role == "ADMIN" else ['a."userId" = :user_id']
    params: dict = {"user_id": principal.id}
    if "*" not in principal.scopes:
        scope_entities = {
            "projects:read": {"project", "board", "milestone", "projectfile"},
            "tasks:read": {"task", "taskcomment", "timeentry"},
            "clients:read": {"client", "contract", "document"},
            "finance:read": {"invoice", "transaction", "payment"},
            "team:read": {"user", "leaverequest", "resignation", "review"},
            "notes:read": {"note"},
            "chat:read": {"channel", "message"},
            "meetings:read": {"meeting"},
        }
        entities = sorted(
            {entity for scope, values in scope_entities.items() if principal.has_scope(scope) for entity in values}
        )
        if not entities:
            return {"data": []}
        params["entity_types"] = entities
        conditions.append("lower(COALESCE(a.\"entityType\", '')) = ANY(CAST(:entity_types AS text[]))")
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    result = await db.execute(
        statement(
            'SELECT a.id, a.type, a.message, a."entityType", a."entityId", a."createdAt", '
            f'u.name AS "userName", u.avatar FROM activities a JOIN users u ON u.id = a."userId" {where} '
            'ORDER BY a."createdAt" DESC LIMIT 20'
        ),
        params,
    )
    return {"data": rows(result)}
