from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import statement
from ..security import Principal

ACTIVITY_SCOPE_ENTITIES = {
    "projects:read": {"project", "board", "milestone", "projectfile"},
    "tasks:read": {"task", "taskcomment", "timeentry"},
    "clients:read": {"client", "contract", "document"},
    "finance:read": {"invoice", "transaction", "payment"},
    "team:read": {"user", "leaverequest", "resignation", "review"},
    "notes:read": {"note"},
    "chat:read": {"channel", "message"},
    "meetings:read": {"meeting"},
}


@dataclass(frozen=True, slots=True)
class DashboardPermissions:
    is_admin: bool
    can_projects: bool
    can_tasks: bool
    can_team: bool
    can_finance: bool
    can_meetings: bool
    activity_entities: list[str] | None


def resolve_dashboard_permissions(principal: Principal) -> DashboardPermissions:
    """Resolve all dashboard permission decisions once for one principal."""
    is_admin = principal.role == "ADMIN"
    can_projects = principal.has_scope("projects:read")
    can_tasks = principal.has_scope("tasks:read")
    can_team = principal.has_scope("team:read")
    can_finance = is_admin and principal.has_scope("finance:read")
    can_meetings = principal.has_scope("meetings:read")
    activity_entities = None
    if "*" not in principal.scopes:
        activity_entities = sorted(
            {
                entity
                for scope, entities in ACTIVITY_SCOPE_ENTITIES.items()
                if principal.has_scope(scope)
                for entity in entities
            }
        )
    return DashboardPermissions(
        is_admin=is_admin,
        can_projects=can_projects,
        can_tasks=can_tasks,
        can_team=can_team,
        can_finance=can_finance,
        can_meetings=can_meetings,
        activity_entities=activity_entities,
    )


def _bootstrap_sql(permissions: DashboardPermissions) -> str:
    project_visibility = (
        "TRUE"
        if permissions.is_admin
        else 'EXISTS (SELECT 1 FROM project_members visible WHERE visible."projectId" = p.id '
        'AND visible."userId" = :user_id)'
    )
    task_visibility = (
        "TRUE"
        if permissions.is_admin
        else 'EXISTS (SELECT 1 FROM task_assignees visible WHERE visible."taskId" = t.id '
        'AND visible."userId" = :user_id)'
    )
    leave_visibility = "TRUE" if permissions.is_admin else 'lr."userId" = :user_id'

    activity_conditions = [] if permissions.is_admin else ['a."userId" = :user_id']
    if permissions.activity_entities is not None:
        if permissions.activity_entities:
            activity_conditions.append(
                "lower(COALESCE(a.\"entityType\", '')) = ANY(CAST(:activity_entities AS text[]))"
            )
        else:
            activity_conditions.append("FALSE")
    activity_where = f"WHERE {' AND '.join(activity_conditions)}" if activity_conditions else ""

    # Every dynamic fragment above is selected from fixed SQL owned by this module;
    # principal values are always bound parameters.
    return f"""
        WITH RECURSIVE
        project_stats AS (
            SELECT count(*) AS active_projects
            FROM projects p
            WHERE CAST(:can_projects AS boolean)
              AND p.status = 'ACTIVE'
              AND {project_visibility}
        ),
        task_stats AS (
            SELECT
                count(*) AS total_tasks,
                count(*) FILTER (
                    WHERE c.name = 'Done'
                      AND t."updatedAt" >= now() - interval '7 days'
                ) AS completed_tasks
            FROM tasks t
            LEFT JOIN columns c ON c.id = t."columnId"
            WHERE CAST(:can_tasks AS boolean)
              AND {task_visibility}
        ),
        team_stats AS (
            SELECT count(*) AS pending_leaves
            FROM leave_requests lr
            WHERE CAST(:can_team AS boolean)
              AND lr.status = 'PENDING'
              AND {leave_visibility}
        ),
        finance_groups AS (
            SELECT
                currency::text AS currency,
                type::text AS type,
                coalesce(sum(amount), 0) AS amount
            FROM transactions
            WHERE CAST(:can_finance AS boolean)
              AND date >= date_trunc('month', now())
              AND date <= now()
            GROUP BY currency, type
        ),
        finance_stats AS (
            SELECT
                coalesce(
                    jsonb_agg(
                        jsonb_build_object('currency', currency, 'amount', amount)
                        ORDER BY currency
                    ) FILTER (WHERE type = 'INCOME'),
                    '[]'::jsonb
                ) AS revenue,
                coalesce(
                    jsonb_agg(
                        jsonb_build_object('currency', currency, 'amount', amount)
                        ORDER BY currency
                    ) FILTER (WHERE type = 'EXPENSE'),
                    '[]'::jsonb
                ) AS expenses
            FROM finance_groups
        ),
        invoice_stats AS (
            SELECT count(*) AS outstanding_invoices
            FROM invoices
            WHERE CAST(:can_finance AS boolean)
              AND status IN ('SENT', 'OVERDUE')
        ),
        project_rows AS (
            SELECT
                p.id,
                p.name,
                p.description,
                p.status::text AS status,
                p.type::text AS type,
                p."startDate",
                p."endDate",
                p."techStack",
                p.budget,
                p."clientId",
                p."createdAt",
                p."updatedAt",
                CASE
                    WHEN c.id IS NULL THEN NULL
                    ELSE jsonb_build_object('id', c.id, 'name', c.name, 'logo', c.logo)
                END AS client,
                (SELECT count(*) FROM boards b WHERE b."projectId" = p.id) AS "boardsCount",
                (SELECT count(*) FROM milestones m WHERE m."projectId" = p.id) AS "milestonesCount",
                (SELECT count(*) FROM project_files f WHERE f."projectId" = p.id) AS "filesCount",
                coalesce((
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'id', pm.id,
                            'role', pm.role,
                            'user', jsonb_build_object(
                                'id', u.id,
                                'name', u.name,
                                'avatar', u.avatar,
                                'title', u.title
                            )
                        )
                        ORDER BY u.name
                    )
                    FROM project_members pm
                    JOIN users u ON u.id = pm."userId"
                    WHERE pm."projectId" = p.id
                ), '[]'::jsonb) AS members,
                coalesce((
                    SELECT jsonb_agg(
                        jsonb_build_object('completedAt', m."completedAt", 'dueDate', m."dueDate")
                        ORDER BY m."dueDate"
                    )
                    FROM milestones m
                    WHERE m."projectId" = p.id
                ), '[]'::jsonb) AS milestones
            FROM projects p
            LEFT JOIN clients c ON c.id = p."clientId"
            WHERE CAST(:can_projects AS boolean)
              AND {project_visibility}
            ORDER BY p."updatedAt" DESC
            LIMIT 4
        ),
        activity_rows AS (
            SELECT
                a.id,
                a.type,
                a.message,
                a."entityType",
                a."entityId",
                a."createdAt",
                u.name AS "userName",
                u.avatar
            FROM activities a
            JOIN users u ON u.id = a."userId"
            {activity_where}
            ORDER BY a."createdAt" DESC
            LIMIT 20
        ),
        deadline_rows AS (
            SELECT
                m.id,
                m.name,
                m."dueDate",
                p.id AS "projectId",
                p.name AS "projectName",
                p.status::text AS "projectStatus"
            FROM milestones m
            JOIN projects p ON p.id = m."projectId"
            WHERE CAST(:can_projects AS boolean)
              AND m."completedAt" IS NULL
              AND m."dueDate" >= CURRENT_DATE
              AND {project_visibility}
            ORDER BY m."dueDate" ASC
            LIMIT 10
        ),
        my_task_rows AS (
            SELECT
                t.id,
                t.title,
                t.priority::text AS priority,
                t."dueDate",
                c.name AS "columnName",
                b.id AS "boardId",
                p.id AS "projectId",
                p.name AS "projectName"
            FROM tasks t
            JOIN task_assignees ta ON ta."taskId" = t.id
            JOIN columns c ON c.id = t."columnId"
            JOIN boards b ON b.id = c."boardId"
            JOIN projects p ON p.id = b."projectId"
            WHERE CAST(:can_tasks AS boolean)
              AND ta."userId" = :user_id
              AND lower(c.name) <> 'done'
            ORDER BY
                CASE t.priority
                    WHEN 'URGENT' THEN 0
                    WHEN 'HIGH' THEN 1
                    WHEN 'MEDIUM' THEN 2
                    ELSE 3
                END,
                t."dueDate" ASC NULLS LAST
            LIMIT 8
        ),
        meeting_occurrences AS (
            SELECT
                m.id,
                m.title,
                m.description,
                m."startTime",
                m."endTime",
                m.location,
                m.recurrence,
                m."createdById",
                m."createdAt",
                m."updatedAt",
                CAST(m."startTime" AS timestamp without time zone) AS "occurrenceStart",
                CAST(m."endTime" AS timestamp without time zone) AS "occurrenceEnd",
                0 AS "occurrenceIndex"
            FROM meetings m
            WHERE CAST(:can_meetings AS boolean)
              AND EXISTS (
                  SELECT 1
                  FROM meeting_attendees visible
                  WHERE visible."meetingId" = m.id
                    AND visible."userId" = :user_id
              )
              AND (m."endTime" >= :now OR m.recurrence IS NOT NULL)

            UNION ALL

            SELECT
                previous.id,
                previous.title,
                previous.description,
                previous."startTime",
                previous."endTime",
                previous.location,
                previous.recurrence,
                previous."createdById",
                previous."createdAt",
                previous."updatedAt",
                next_occurrence.start_time AS "occurrenceStart",
                next_occurrence.start_time
                    + (previous."occurrenceEnd" - previous."occurrenceStart") AS "occurrenceEnd",
                previous."occurrenceIndex" + 1
            FROM meeting_occurrences previous
            CROSS JOIN LATERAL (
                SELECT CASE previous.recurrence
                    WHEN 'daily' THEN previous."occurrenceStart" + interval '1 day'
                    WHEN 'weekly' THEN previous."occurrenceStart" + interval '7 days'
                    WHEN 'biweekly' THEN previous."occurrenceStart" + interval '14 days'
                    WHEN 'monthly' THEN
                        date_trunc('month', previous."occurrenceStart")
                        + interval '1 month'
                        + (extract(day FROM previous."occurrenceStart")::integer - 1) * interval '1 day'
                        + (previous."occurrenceStart" - date_trunc('day', previous."occurrenceStart"))
                    ELSE previous."occurrenceStart"
                END AS start_time
            ) next_occurrence
            WHERE previous.recurrence IS NOT NULL
              AND previous."occurrenceEnd" <= :now
              AND previous."occurrenceIndex" < 364
              AND next_occurrence.start_time <> previous."occurrenceStart"
        ),
        resolved_meeting_rows AS (
            SELECT *
            FROM (
                SELECT
                    occurrence.*,
                    row_number() OVER (
                        PARTITION BY occurrence.id
                        ORDER BY occurrence."occurrenceStart"
                    ) AS "resolvedRank"
                FROM meeting_occurrences occurrence
                WHERE occurrence."occurrenceEnd" > :now
            ) ranked
            WHERE ranked."resolvedRank" = 1
            ORDER BY ranked."occurrenceStart", ranked."startTime" DESC, ranked.id
            LIMIT 50
        )
        SELECT jsonb_build_object(
            'stats', jsonb_build_object(
                'activeProjects', project_stats.active_projects,
                'totalTasks', task_stats.total_tasks,
                'completedTasksThisWeek', task_stats.completed_tasks,
                'pendingLeaves', team_stats.pending_leaves,
                'revenue', finance_stats.revenue,
                'expenses', finance_stats.expenses,
                'outstandingInvoices', invoice_stats.outstanding_invoices,
                'isAdmin', CAST(:is_admin AS boolean)
            ),
            'activity', coalesce((
                SELECT jsonb_agg(to_jsonb(activity_row) ORDER BY activity_row."createdAt" DESC)
                FROM activity_rows activity_row
            ), '[]'::jsonb),
            'projects', coalesce((
                SELECT jsonb_agg(
                    (to_jsonb(project_row) - 'boardsCount' - 'milestonesCount' - 'filesCount')
                    || jsonb_build_object(
                        '_count', jsonb_build_object(
                            'boards', project_row."boardsCount",
                            'milestones', project_row."milestonesCount",
                            'files', project_row."filesCount"
                        )
                    )
                    ORDER BY project_row."updatedAt" DESC
                )
                FROM project_rows project_row
            ), '[]'::jsonb),
            'meetings', coalesce((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', meeting_row.id,
                        'title', meeting_row.title,
                        'description', meeting_row.description,
                        'startTime', meeting_row."occurrenceStart",
                        'endTime', meeting_row."occurrenceEnd",
                        'location', meeting_row.location,
                        'recurrence', meeting_row.recurrence,
                        'createdById', meeting_row."createdById",
                        'createdAt', meeting_row."createdAt",
                        'updatedAt', meeting_row."updatedAt",
                        'attendees', coalesce((
                            SELECT jsonb_agg(
                                jsonb_build_object(
                                    'id', attendee.id,
                                    'userId', attendee."userId",
                                    'joinedAt', (
                                        SELECT attendance."joinedAt"
                                        FROM meeting_attendance_log attendance
                                        WHERE attendance."meetingId" = attendee."meetingId"
                                          AND attendance."userId" = attendee."userId"
                                          AND attendance."occurrenceStart" = meeting_row."occurrenceStart"
                                        LIMIT 1
                                    ),
                                    'user', jsonb_build_object(
                                        'id', attendee_user.id,
                                        'name', attendee_user.name,
                                        'avatar', attendee_user.avatar,
                                        'title', attendee_user.title
                                    )
                                )
                                ORDER BY attendee.id
                            )
                            FROM meeting_attendees attendee
                            JOIN users attendee_user ON attendee_user.id = attendee."userId"
                            WHERE attendee."meetingId" = meeting_row.id
                        ), '[]'::jsonb)
                    )
                    ORDER BY meeting_row."occurrenceStart", meeting_row."startTime" DESC, meeting_row.id
                )
                FROM resolved_meeting_rows meeting_row
            ), '[]'::jsonb),
            'deadlines', coalesce((
                SELECT jsonb_agg(to_jsonb(deadline_row) ORDER BY deadline_row."dueDate")
                FROM deadline_rows deadline_row
            ), '[]'::jsonb),
            'tasks', coalesce((
                SELECT jsonb_agg(
                    to_jsonb(task_row)
                    ORDER BY
                        CASE task_row.priority
                            WHEN 'URGENT' THEN 0
                            WHEN 'HIGH' THEN 1
                            WHEN 'MEDIUM' THEN 2
                            ELSE 3
                        END,
                        task_row."dueDate" ASC NULLS LAST
                )
                FROM my_task_rows task_row
            ), '[]'::jsonb)
        ) AS payload
        FROM project_stats, task_stats, team_stats, finance_stats, invoice_stats
    """


def _list_value(payload: dict[str, Any], key: str) -> list[Any]:
    value = payload.get(key)
    return value if isinstance(value, list) else []


def _utc_datetime(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    if not isinstance(value, str):
        return value
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _database_isoformat(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if not isinstance(value, str):
        return value
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return value


def _normalize_payload(payload: Any, permissions: DashboardPermissions) -> dict[str, Any]:
    source = payload if isinstance(payload, dict) else {}
    source_stats = source.get("stats") if isinstance(source.get("stats"), dict) else {}
    stats = {
        "activeProjects": int(source_stats.get("activeProjects") or 0) if permissions.can_projects else 0,
        "totalTasks": int(source_stats.get("totalTasks") or 0) if permissions.can_tasks else 0,
        "completedTasksThisWeek": (
            int(source_stats.get("completedTasksThisWeek") or 0) if permissions.can_tasks else 0
        ),
        "pendingLeaves": int(source_stats.get("pendingLeaves") or 0) if permissions.can_team else 0,
        "revenue": _list_value(source_stats, "revenue") if permissions.can_finance else [],
        "expenses": _list_value(source_stats, "expenses") if permissions.can_finance else [],
        "outstandingInvoices": (int(source_stats.get("outstandingInvoices") or 0) if permissions.can_finance else 0),
        "isAdmin": permissions.is_admin,
    }

    activity = _list_value(source, "activity")
    if permissions.activity_entities is not None:
        allowed_entities = set(permissions.activity_entities)
        activity = [
            item
            for item in activity
            if isinstance(item, dict) and str(item.get("entityType") or "").lower() in allowed_entities
        ]
    for item in activity:
        if isinstance(item, dict) and "createdAt" in item:
            item["createdAt"] = _database_isoformat(item.get("createdAt"))

    projects = _list_value(source, "projects") if permissions.can_projects else []
    for project in projects:
        if not isinstance(project, dict):
            continue
        for key in ("startDate", "endDate", "createdAt", "updatedAt"):
            if key in project:
                project[key] = _database_isoformat(project.get(key))

    meetings = _list_value(source, "meetings") if permissions.can_meetings else []
    for meeting in meetings:
        if isinstance(meeting, dict):
            meeting["startTime"] = _utc_datetime(meeting.get("startTime"))
            meeting["endTime"] = _utc_datetime(meeting.get("endTime"))
            for key in ("createdAt", "updatedAt"):
                if key in meeting:
                    meeting[key] = _database_isoformat(meeting.get(key))
            for attendee in _list_value(meeting, "attendees"):
                if isinstance(attendee, dict) and "joinedAt" in attendee:
                    attendee["joinedAt"] = _database_isoformat(attendee.get("joinedAt"))

    deadlines = _list_value(source, "deadlines") if permissions.can_projects else []
    for deadline in deadlines:
        if isinstance(deadline, dict) and "dueDate" in deadline:
            deadline["dueDate"] = _database_isoformat(deadline.get("dueDate"))

    tasks = _list_value(source, "tasks") if permissions.can_tasks else []
    for task in tasks:
        if isinstance(task, dict) and "dueDate" in task:
            task["dueDate"] = _database_isoformat(task.get("dueDate"))

    failed_datasets = []
    if not permissions.can_projects:
        failed_datasets.append("projects")
    if not permissions.can_meetings:
        failed_datasets.append("meetings")

    return {
        "stats": stats,
        "activity": activity,
        "projects": projects,
        "meetings": meetings,
        "deadlines": deadlines,
        "tasks": tasks,
        "failedDatasets": failed_datasets,
    }


async def dashboard_bootstrap(db: AsyncConnection, principal: Principal) -> dict[str, Any]:
    permissions = resolve_dashboard_permissions(principal)
    now = datetime.now(UTC).replace(tzinfo=None)
    result = await db.execute(
        statement(_bootstrap_sql(permissions)),
        {
            "user_id": principal.id,
            "is_admin": permissions.is_admin,
            "can_projects": permissions.can_projects,
            "can_tasks": permissions.can_tasks,
            "can_team": permissions.can_team,
            "can_finance": permissions.can_finance,
            "can_meetings": permissions.can_meetings,
            "activity_entities": permissions.activity_entities or [],
            "now": now,
        },
    )
    return _normalize_payload(result.scalar_one(), permissions)
