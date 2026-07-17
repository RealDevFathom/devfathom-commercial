import json
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import DataError, IntegrityError, StatementError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection
from ..security import Principal, current_principal
from .delivery_schemas import (
    AttachmentCreate,
    BlockerCreate,
    BoardCreate,
    BoardUpdate,
    BulkTaskDelete,
    BulkTaskMove,
    ChecklistCreate,
    ChecklistItemCreate,
    ChecklistItemUpdate,
    ChecklistUpdate,
    ColumnCreate,
    ColumnOrder,
    ColumnUpdate,
    CommentCreate,
    CommentUpdate,
    DefaultAssignees,
    LabelCreate,
    LabelUpdate,
    MilestoneCreate,
    MilestoneUpdate,
    ProjectCreate,
    ProjectFileCreate,
    ProjectMemberInput,
    ProjectMemberRole,
    ProjectUpdate,
    TaskAssignees,
    TaskCreate,
    TaskLabelInput,
    TaskMove,
    TaskParentUpdate,
    TaskUpdate,
    TimeEntryCreate,
    TimeEntryUpdate,
)
from .domain_common import (
    dump,
    execute,
    fetch_all,
    fetch_one,
    log_activity,
    new_id,
    project_access,
    related_access,
    require_scope,
    unique,
)

router = APIRouter(prefix="/api/v1", tags=["delivery"])

PROJECT_COLUMNS = (
    'id, name, description, status::text AS status, type::text AS type, "startDate", "endDate", '
    '"techStack", budget, "clientId", "createdAt", "updatedAt"'
)
TASK_COLUMNS = (
    'id, title, description, "columnId", "order", priority::text AS priority, "dueDate", '
    '"createdById", "parentId", "createdAt", "updatedAt"'
)
BOARD_TEMPLATES = {
    "kanban": ["Backlog", "To Do", "In Progress", "Review", "Done"],
    "scrum": ["Backlog", "Sprint Backlog", "In Progress", "Review", "Done"],
    "simple": ["To Do", "Doing", "Done"],
    "bugtracker": ["Reported", "Triaged", "In Progress", "Testing", "Closed"],
}
DEFAULT_LABELS = [
    ("Bug", "#EF4444"),
    ("Feature", "#2563EB"),
    ("Enhancement", "#0EA5E9"),
    ("Design", "#F59E0B"),
    ("Urgent", "#DC2626"),
]


def update_sql(table: str, values: dict[str, Any], *, enum_fields: set[str] | None = None) -> str:
    del enum_fields
    assignments = []
    for key in values.keys() - {"id", "updatedAt"}:
        assignments.append(f'"{key}" = :{key}')
    assignments.append('"updatedAt" = :updatedAt')
    return f"UPDATE {table} SET {', '.join(assignments)} WHERE id = :id"


async def task_payloads(db: AsyncConnection, task_ids: list[str]) -> list[dict[str, Any]]:
    """Hydrate an arbitrary task batch in one database round trip."""
    if not task_ids:
        return []
    return await fetch_all(
        db,
        f"""
        WITH requested AS (
            SELECT value AS id
            FROM jsonb_array_elements_text(CAST(:task_ids AS jsonb))
        )
        SELECT t.{TASK_COLUMNS.replace(", ", ", t.")},
            COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'id', ta.id,
                        'user', json_build_object(
                            'id', u.id, 'name', u.name, 'avatar', u.avatar, 'title', u.title
                        )
                    ) ORDER BY u.name
                )
                FROM task_assignees ta
                JOIN users u ON u.id = ta."userId"
                WHERE ta."taskId" = t.id
            ), '[]'::json) AS assignees,
            COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'id', tl.id,
                        'label', json_build_object(
                            'id', l.id, 'name', l.name, 'color', l.color, 'boardId', l."boardId"
                        )
                    ) ORDER BY l.name
                )
                FROM task_labels tl
                JOIN labels l ON l.id = tl."labelId"
                WHERE tl."taskId" = t.id
            ), '[]'::json) AS labels,
            json_build_object(
                'comments', (SELECT count(*) FROM task_comments tc WHERE tc."taskId" = t.id),
                'attachments', (SELECT count(*) FROM task_attachments ta WHERE ta."taskId" = t.id),
                'checklists', (SELECT count(*) FROM task_checklists tc WHERE tc."taskId" = t.id)
            ) AS "_count",
            (
                SELECT json_build_object(
                    'id', c.id,
                    'name', c.name,
                    'board', json_build_object(
                        'id', b.id, 'name', b.name, 'projectId', b."projectId"
                    )
                )
                FROM columns c
                JOIN boards b ON b.id = c."boardId"
                WHERE c.id = t."columnId"
            ) AS column,
            (
                SELECT json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar)
                FROM users u WHERE u.id = t."createdById"
            ) AS "createdBy",
            (
                SELECT json_build_object('id', parent.id, 'title', parent.title)
                FROM tasks parent WHERE parent.id = t."parentId"
            ) AS parent,
            COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'id', child.id,
                        'title', child.title,
                        'column', json_build_object('id', c.id, 'name', c.name)
                    ) ORDER BY child."order"
                )
                FROM tasks child
                JOIN columns c ON c.id = child."columnId"
                WHERE child."parentId" = t.id
            ), '[]'::json) AS subtasks,
            COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'id', tb.id,
                        'blockingTask', json_build_object(
                            'id', blocking.id,
                            'title', blocking.title,
                            'column', json_build_object('name', c.name)
                        )
                    ) ORDER BY tb."createdAt"
                )
                FROM task_blockers tb
                JOIN tasks blocking ON blocking.id = tb."blockingTaskId"
                JOIN columns c ON c.id = blocking."columnId"
                WHERE tb."blockedTaskId" = t.id
            ), '[]'::json) AS "blockedBy",
            COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'id', tb.id,
                        'blockedTask', json_build_object(
                            'id', blocked.id,
                            'title', blocked.title,
                            'column', json_build_object('name', c.name)
                        )
                    ) ORDER BY tb."createdAt"
                )
                FROM task_blockers tb
                JOIN tasks blocked ON blocked.id = tb."blockedTaskId"
                JOIN columns c ON c.id = blocked."columnId"
                WHERE tb."blockingTaskId" = t.id
            ), '[]'::json) AS blocking,
            COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'id', checklist.id,
                        'name', checklist.name,
                        'taskId', checklist."taskId",
                        'order', checklist."order",
                        'items', COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', item.id,
                                    'text', item.text,
                                    'completed', item.completed,
                                    'checklistId', item."checklistId",
                                    'order', item."order"
                                ) ORDER BY item."order"
                            )
                            FROM task_checklist_items item
                            WHERE item."checklistId" = checklist.id
                        ), '[]'::json)
                    ) ORDER BY checklist."order"
                )
                FROM task_checklists checklist
                WHERE checklist."taskId" = t.id
            ), '[]'::json) AS checklists,
            COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'id', attachment.id,
                        'name', attachment.name,
                        'url', attachment.url,
                        'type', attachment.type,
                        'size', attachment.size,
                        'taskId', attachment."taskId",
                        'createdAt', attachment."createdAt"
                    ) ORDER BY attachment."createdAt" DESC
                )
                FROM task_attachments attachment
                WHERE attachment."taskId" = t.id
            ), '[]'::json) AS attachments
        FROM tasks t
        JOIN requested ON requested.id = t.id
        ORDER BY t."columnId", t."order"
        """,
        {"task_ids": json.dumps(list(dict.fromkeys(task_ids)))},
    )


async def task_payload(db: AsyncConnection, task_id: str) -> dict[str, Any]:
    tasks = await task_payloads(db, [task_id])
    if not tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    return tasks[0]


@router.get("/projects")
async def list_projects(
    limit: int = Query(100, ge=1, le=200),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:read")
    membership = (
        ""
        if principal.role == "ADMIN"
        else 'JOIN project_members visible ON visible."projectId" = p.id AND visible."userId" = :user_id'
    )
    projects = await fetch_all(
        db,
        f"SELECT p.{PROJECT_COLUMNS.replace(', ', ', p.')}, "
        "CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'name', c.name, 'logo', c.logo) END AS client, "
        '(SELECT count(*) FROM boards b WHERE b."projectId" = p.id) AS "boardsCount", '
        '(SELECT count(*) FROM milestones m WHERE m."projectId" = p.id) AS "milestonesCount", '
        '(SELECT count(*) FROM project_files f WHERE f."projectId" = p.id) AS "filesCount", '
        "COALESCE((SELECT json_agg(json_build_object('id', pm.id, 'role', pm.role, 'user', "
        "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, 'title', u.title)) ORDER BY u.name) "
        'FROM project_members pm JOIN users u ON u.id = pm."userId" WHERE pm."projectId" = p.id), \'[]\'::json) AS members, '
        "COALESCE((SELECT json_agg(json_build_object('completedAt', m.\"completedAt\", 'dueDate', m.\"dueDate\") "
        'ORDER BY m."dueDate") FROM milestones m WHERE m."projectId" = p.id), \'[]\'::json) AS milestones '
        f'FROM projects p {membership} LEFT JOIN clients c ON c.id = p."clientId" '
        'ORDER BY p."updatedAt" DESC LIMIT :limit',
        {"user_id": principal.id, "limit": limit},
    )
    for project in projects:
        project["_count"] = {
            "boards": project.pop("boardsCount"),
            "milestones": project.pop("milestonesCount"),
            "files": project.pop("filesCount"),
        }
    return {"data": projects}


@router.post("/projects", status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    project_id = new_id()
    values = dump(payload)
    member_ids = unique([principal.id, *values.pop("memberIds")])
    create_default_board = values.pop("createDefaultBoard")
    now = datetime.now(UTC)
    try:
        await execute(
            db,
            'INSERT INTO projects (id, name, description, type, status, "clientId", "startDate", "endDate", "techStack", "createdAt", "updatedAt") '
            "VALUES (:id, :name, :description, :type, :status, :clientId, :startDate, :endDate, :techStack, :createdAt, :updatedAt)",
            {"id": project_id, **values, "createdAt": now, "updatedAt": now},
        )
        for index, user_id in enumerate(member_ids):
            await execute(
                db,
                'INSERT INTO project_members (id, "projectId", "userId", role) VALUES (:id, :project_id, :user_id, :role)',
                {
                    "id": new_id(),
                    "project_id": project_id,
                    "user_id": user_id,
                    "role": "LEAD" if index == 0 else "MEMBER",
                },
            )
        if create_default_board:
            board_id = new_id()
            await execute(
                db,
                'INSERT INTO boards (id, name, "projectId", "createdAt", "updatedAt") VALUES (:id, :name, :project_id, :now, :now)',
                {"id": board_id, "name": f"{payload.name} Board", "project_id": project_id, "now": now},
            )
            for order, name in enumerate(BOARD_TEMPLATES["kanban"]):
                await execute(
                    db,
                    'INSERT INTO columns (id, name, "boardId", "order", "createdAt", "updatedAt") VALUES (:id, :name, :board_id, :order, :now, :now)',
                    {"id": new_id(), "name": name, "board_id": board_id, "order": order, "now": now},
                )
            for name, color in DEFAULT_LABELS:
                await execute(
                    db,
                    'INSERT INTO labels (id, name, color, "boardId") VALUES (:id, :name, :color, :board_id)',
                    {"id": new_id(), "name": name, "color": color, "board_id": board_id},
                )
        await log_activity(
            db,
            principal,
            type="project_created",
            message=f"created project {payload.name}",
            entity_type="Project",
            entity_id=project_id,
        )
        await db.commit()
    except HTTPException:
        await db.rollback()
        raise
    except (IntegrityError, DataError, StatementError) as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="The project did not pass database validation") from exc
    except Exception:
        await db.rollback()
        raise
    return {"data": await fetch_one(db, f"SELECT {PROJECT_COLUMNS} FROM projects WHERE id = :id", {"id": project_id})}


@router.get("/projects/{project_id}")
async def get_project(
    project_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:read")
    await project_access(db, principal, project_id)
    project = await fetch_one(db, f"SELECT {PROJECT_COLUMNS} FROM projects WHERE id = :id", {"id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project["client"] = await fetch_one(
        db,
        'SELECT c.name, c.website FROM clients c JOIN projects p ON p."clientId" = c.id WHERE p.id = :id',
        {"id": project_id},
    )
    project["members"] = await fetch_all(
        db,
        "SELECT pm.id, pm.role, json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'avatar', u.avatar, 'title', u.title, 'department', u.department) AS user "
        'FROM project_members pm JOIN users u ON u.id = pm."userId" WHERE pm."projectId" = :id ORDER BY u.name',
        {"id": project_id},
    )
    project["boards"] = await fetch_all(
        db,
        'SELECT id, name, description, "projectId", "createdAt", "updatedAt" FROM boards WHERE "projectId" = :id ORDER BY "updatedAt" DESC',
        {"id": project_id},
    )
    for board in project["boards"]:
        board["columns"] = await fetch_all(
            db,
            'SELECT c.id, c.name, c."boardId", c."order", c."wipLimit", c."createdAt", c."updatedAt", '
            '(SELECT count(*) FROM tasks t WHERE t."columnId" = c.id) AS "tasksCount" '
            'FROM columns c WHERE c."boardId" = :id ORDER BY c."order"',
            {"id": board["id"]},
        )
        for column in board["columns"]:
            column["_count"] = {"tasks": column.pop("tasksCount")}
    return {"data": project}


@router.patch("/projects/{project_id}")
async def update_project(
    project_id: str,
    payload: ProjectUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await project_access(db, principal, project_id)
    values = dump(payload, exclude_unset=True)
    if values:
        values.update({"id": project_id, "updatedAt": datetime.now(UTC)})
        await execute(db, update_sql("projects", values, enum_fields={"status"}), values)
    project = await fetch_one(db, f"SELECT {PROJECT_COLUMNS} FROM projects WHERE id = :id", {"id": project_id})
    await log_activity(
        db,
        principal,
        type="project_updated",
        message=(
            f"marked project {project['name']} as completed"
            if values.get("status") == "COMPLETED"
            else f"updated project {project['name']}"
        ),
        entity_type="Project",
        entity_id=project_id,
    )
    await db.commit()
    return {"data": project}


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    await project_access(db, principal, project_id, manage=True)
    project = await fetch_one(db, "SELECT name FROM projects WHERE id = :id", {"id": project_id})
    await execute(db, "DELETE FROM projects WHERE id = :id", {"id": project_id})
    if project:
        await log_activity(db, principal, type="project_deleted", message=f"deleted project {project['name']}")
    await db.commit()
    return {"success": True}


@router.post("/projects/{project_id}/members")
async def add_project_member(
    project_id: str,
    payload: ProjectMemberInput,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await project_access(db, principal, project_id, manage=True)
    await execute(
        db,
        'INSERT INTO project_members (id, "projectId", "userId", role) VALUES (:id, :project_id, :user_id, :role) '
        'ON CONFLICT ("projectId", "userId") DO UPDATE SET role = EXCLUDED.role',
        {"id": new_id(), "project_id": project_id, "user_id": payload.user_id, "role": payload.role},
    )
    membership = await fetch_one(
        db,
        'SELECT id, "projectId", "userId", role FROM project_members WHERE "projectId" = :project_id AND "userId" = :user_id',
        {"project_id": project_id, "user_id": payload.user_id},
    )
    project = await fetch_one(db, "SELECT name FROM projects WHERE id = :id", {"id": project_id})
    user = await fetch_one(db, "SELECT name FROM users WHERE id = :id", {"id": payload.user_id})
    if project and user:
        await log_activity(
            db,
            principal,
            type="project_member_added",
            message=f"added {user['name']} to {project['name']}",
            entity_type="Project",
            entity_id=project_id,
        )
    await db.commit()
    return {"data": membership}


@router.patch("/projects/{project_id}/members/{user_id}")
async def set_project_member_role(
    project_id: str,
    user_id: str,
    payload: ProjectMemberRole,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await project_access(db, principal, project_id, manage=True)
    await execute(
        db,
        "SELECT pg_advisory_xact_lock(hashtextextended(:project_id, 0))",
        {"project_id": project_id},
    )
    target = await fetch_one(
        db,
        'SELECT id, role FROM project_members WHERE "projectId" = :project_id AND "userId" = :user_id',
        {"project_id": project_id, "user_id": user_id},
    )
    if not target:
        raise HTTPException(status_code=404, detail="Member not on this project")
    if target["role"] == "LEAD" and payload.role == "MEMBER":
        count = await fetch_one(
            db,
            "SELECT count(*) AS count FROM project_members WHERE \"projectId\" = :project_id AND role = 'LEAD'",
            {"project_id": project_id},
        )
        if count and count["count"] <= 1:
            raise HTTPException(status_code=400, detail="Cannot demote the last lead. Promote another member first.")
    await execute(
        db, "UPDATE project_members SET role = :role WHERE id = :id", {"role": payload.role, "id": target["id"]}
    )
    await db.commit()
    return {"data": {**target, "role": payload.role}}


@router.delete("/projects/{project_id}/members/{user_id}")
async def remove_project_member(
    project_id: str,
    user_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    if user_id != principal.id:
        await project_access(db, principal, project_id, manage=True)
    else:
        await project_access(db, principal, project_id)
    await execute(
        db,
        "SELECT pg_advisory_xact_lock(hashtextextended(:project_id, 0))",
        {"project_id": project_id},
    )
    target = await fetch_one(
        db,
        'SELECT id, role FROM project_members WHERE "projectId" = :project_id AND "userId" = :user_id',
        {"project_id": project_id, "user_id": user_id},
    )
    if not target:
        raise HTTPException(status_code=404, detail="Member not on this project")
    if target["role"] == "LEAD":
        count = await fetch_one(
            db,
            "SELECT count(*) AS count FROM project_members WHERE \"projectId\" = :project_id AND role = 'LEAD'",
            {"project_id": project_id},
        )
        if count and count["count"] <= 1:
            raise HTTPException(
                status_code=400, detail="Cannot remove the last lead. Promote another member to lead first."
            )
    project = await fetch_one(db, "SELECT name FROM projects WHERE id = :id", {"id": project_id})
    target_user = await fetch_one(db, "SELECT name FROM users WHERE id = :id", {"id": user_id})
    await execute(db, "DELETE FROM project_members WHERE id = :id", {"id": target["id"]})
    if project and target_user:
        await log_activity(
            db,
            principal,
            type="project_member_removed",
            message=(
                f"left project {project['name']}"
                if user_id == principal.id
                else f"removed {target_user['name']} from {project['name']}"
            ),
            entity_type="Project",
            entity_id=project_id,
        )
    await db.commit()
    return {"success": True}


@router.post("/boards", status_code=status.HTTP_201_CREATED)
async def create_board(
    payload: BoardCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await project_access(db, principal, payload.project_id)
    board_id = new_id()
    now = datetime.now(UTC)
    await execute(
        db,
        'INSERT INTO boards (id, name, description, "projectId", "createdAt", "updatedAt") VALUES (:id, :name, :description, :project_id, :now, :now)',
        {
            "id": board_id,
            "name": payload.name,
            "description": payload.description,
            "project_id": payload.project_id,
            "now": now,
        },
    )
    template = payload.template.value if payload.template else "kanban"
    if payload.template or payload.create_default_columns:
        for order, name in enumerate(BOARD_TEMPLATES[template]):
            await execute(
                db,
                'INSERT INTO columns (id, name, "boardId", "order", "createdAt", "updatedAt") VALUES (:id, :name, :board_id, :order, :now, :now)',
                {"id": new_id(), "name": name, "board_id": board_id, "order": order, "now": now},
            )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, description, "projectId", "createdAt", "updatedAt" FROM boards WHERE id = :id',
            {"id": board_id},
        )
    }


@router.get("/boards/{board_id}")
async def get_board(
    board_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:read")
    await related_access(db, principal, "board", board_id)
    board = await fetch_one(
        db,
        'SELECT b.id, b.name, b.description, b."projectId", b."createdAt", b."updatedAt", '
        "json_build_object('id', p.id, 'name', p.name) AS project FROM boards b JOIN projects p ON p.id = b.\"projectId\" WHERE b.id = :id",
        {"id": board_id},
    )
    if not board:
        raise HTTPException(status_code=404, detail="Board not found")
    board["labels"] = await fetch_all(
        db, 'SELECT id, name, color, "boardId" FROM labels WHERE "boardId" = :id ORDER BY name', {"id": board_id}
    )
    board["columns"] = await fetch_all(
        db,
        'SELECT c.id, c.name, c."boardId", c."order", c."wipLimit", c."createdAt", c."updatedAt", '
        "COALESCE((SELECT json_agg(json_build_object('id', da.id, 'user', "
        "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, 'title', u.title)) ORDER BY u.name) "
        'FROM column_default_assignees da JOIN users u ON u.id = da."userId" '
        'WHERE da."columnId" = c.id), \'[]\'::json) AS "defaultAssignees" '
        'FROM columns c WHERE c."boardId" = :id ORDER BY c."order"',
        {"id": board_id},
    )
    task_ids = await fetch_all(
        db,
        'SELECT t.id FROM tasks t JOIN columns c ON c.id = t."columnId" '
        'WHERE c."boardId" = :id ORDER BY c."order", t."order"',
        {"id": board_id},
    )
    tasks_by_column: dict[str, list[dict[str, Any]]] = {}
    for task in await task_payloads(db, [row["id"] for row in task_ids]):
        tasks_by_column.setdefault(task["columnId"], []).append(task)
    for column in board["columns"]:
        column["tasks"] = tasks_by_column.get(column["id"], [])
    return {"data": board}


@router.patch("/boards/{board_id}")
async def update_board(
    board_id: str,
    payload: BoardUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await related_access(db, principal, "board", board_id, manage=True)
    values = dump(payload, exclude_unset=True)
    if values:
        values.update({"id": board_id, "updatedAt": datetime.now(UTC)})
        await execute(db, update_sql("boards", values), values)
        await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, description, "projectId", "createdAt", "updatedAt" FROM boards WHERE id = :id',
            {"id": board_id},
        )
    }


@router.delete("/boards/{board_id}")
async def delete_board(
    board_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    await related_access(db, principal, "board", board_id, manage=True)
    await execute(db, "DELETE FROM boards WHERE id = :id", {"id": board_id})
    await db.commit()
    return {"success": True}


@router.post("/columns", status_code=status.HTTP_201_CREATED)
async def create_column(
    payload: ColumnCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await related_access(db, principal, "board", payload.board_id)
    maximum = await fetch_one(
        db, 'SELECT max("order") AS maximum FROM columns WHERE "boardId" = :id', {"id": payload.board_id}
    )
    column_id = new_id()
    now = datetime.now(UTC)
    await execute(
        db,
        'INSERT INTO columns (id, name, "boardId", "order", "createdAt", "updatedAt") VALUES (:id, :name, :board_id, :order, :now, :now)',
        {
            "id": column_id,
            "name": payload.name,
            "board_id": payload.board_id,
            "order": (maximum or {}).get("maximum", -1) + 1 if (maximum or {}).get("maximum") is not None else 0,
            "now": now,
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, "boardId", "order", "wipLimit", "createdAt", "updatedAt" FROM columns WHERE id = :id',
            {"id": column_id},
        )
    }


@router.put("/boards/{board_id}/columns/order")
async def reorder_columns(
    board_id: str,
    payload: ColumnOrder,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    await related_access(db, principal, "board", board_id)
    existing = await fetch_all(db, 'SELECT id FROM columns WHERE "boardId" = :id', {"id": board_id})
    existing_ids = {row["id"] for row in existing}
    if set(payload.column_ids) != existing_ids or len(payload.column_ids) != len(existing_ids):
        raise HTTPException(status_code=400, detail="Column order must contain every board column exactly once")
    for order, column_id in enumerate(payload.column_ids):
        await execute(
            db,
            'UPDATE columns SET "order" = :order, "updatedAt" = :now WHERE id = :id',
            {"order": order, "now": datetime.now(UTC), "id": column_id},
        )
    await db.commit()
    return {"success": True}


@router.put("/columns/{column_id}/default-assignees")
async def set_column_default_assignees(
    column_id: str,
    payload: DefaultAssignees,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    project_id = await related_access(db, principal, "column", column_id, manage=True)
    user_ids = unique(payload.user_ids)
    if user_ids:
        members = await fetch_all(
            db, 'SELECT "userId" FROM project_members WHERE "projectId" = :id', {"id": project_id}
        )
        if not set(user_ids).issubset({row["userId"] for row in members}):
            raise HTTPException(status_code=400, detail="All column owners must be members of the project.")
    await execute(db, 'DELETE FROM column_default_assignees WHERE "columnId" = :id', {"id": column_id})
    for user_id in user_ids:
        await execute(
            db,
            'INSERT INTO column_default_assignees (id, "columnId", "userId", "createdAt") VALUES (:id, :column_id, :user_id, :now)',
            {"id": new_id(), "column_id": column_id, "user_id": user_id, "now": datetime.now(UTC)},
        )
    await db.commit()
    return {"success": True}


@router.patch("/columns/{column_id}")
async def update_column(
    column_id: str,
    payload: ColumnUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await related_access(db, principal, "column", column_id)
    values = dump(payload, exclude_unset=True)
    if values:
        values.update({"id": column_id, "updatedAt": datetime.now(UTC)})
        await execute(db, update_sql("columns", values), values)
        await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, "boardId", "order", "wipLimit", "createdAt", "updatedAt" FROM columns WHERE id = :id',
            {"id": column_id},
        )
    }


@router.delete("/columns/{column_id}")
async def delete_column(
    column_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    await related_access(db, principal, "column", column_id, manage=True)
    await execute(db, "DELETE FROM columns WHERE id = :id", {"id": column_id})
    await db.commit()
    return {"success": True}


async def validate_project_members(db: AsyncConnection, project_id: str, user_ids: list[str], message: str) -> None:
    if not user_ids:
        return
    members = await fetch_all(db, 'SELECT "userId" FROM project_members WHERE "projectId" = :id', {"id": project_id})
    if not set(user_ids).issubset({row["userId"] for row in members}):
        raise HTTPException(status_code=400, detail=message)


@router.get("/tasks")
async def list_tasks(
    project_id: Annotated[str | None, Query(alias="projectId")] = None,
    board_id: Annotated[str | None, Query(alias="boardId")] = None,
    column_id: Annotated[str | None, Query(alias="columnId")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:read")
    clauses: list[str] = []
    values: dict[str, Any] = {"limit": limit, "user_id": principal.id}
    if project_id:
        await project_access(db, principal, project_id)
        clauses.append('b."projectId" = :project_id')
        values["project_id"] = project_id
    if board_id:
        await related_access(db, principal, "board", board_id)
        clauses.append("b.id = :board_id")
        values["board_id"] = board_id
    if column_id:
        await related_access(db, principal, "column", column_id)
        clauses.append("c.id = :column_id")
        values["column_id"] = column_id
    if principal.role != "ADMIN":
        clauses.append(
            'EXISTS (SELECT 1 FROM project_members pm WHERE pm."projectId" = b."projectId" AND pm."userId" = :user_id)'
        )
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    tasks = await fetch_all(
        db,
        "SELECT t.id FROM tasks t "
        'JOIN columns c ON c.id = t."columnId" JOIN boards b ON b.id = c."boardId" '
        f'{where} ORDER BY t."updatedAt" DESC LIMIT :limit',
        values,
    )
    hydrated = await task_payloads(db, [task["id"] for task in tasks])
    by_id = {task["id"]: task for task in hydrated}
    return {"data": [by_id[task["id"]] for task in tasks if task["id"] in by_id]}


async def validate_task_labels(
    db: AsyncConnection,
    column_id: str,
    label_ids: list[str],
) -> list[str]:
    ids = unique(label_ids)
    if not ids:
        return ids
    board = await fetch_one(db, 'SELECT "boardId" FROM columns WHERE id = :id', {"id": column_id})
    labels = await fetch_all(
        db, 'SELECT id, "boardId" FROM labels WHERE "boardId" = :id', {"id": board["boardId"] if board else ""}
    )
    if not board or not set(ids).issubset({label["id"] for label in labels}):
        raise HTTPException(status_code=400, detail="All labels must belong to the task's board.")
    return ids


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    project_id = await related_access(db, principal, "column", payload.column_id)
    requested = unique(payload.assignee_ids)
    await validate_project_members(db, project_id, requested, "All assignees must be members of the project.")
    defaults = await fetch_all(
        db, 'SELECT "userId" FROM column_default_assignees WHERE "columnId" = :id', {"id": payload.column_id}
    )
    assignee_ids = unique([*requested, *[row["userId"] for row in defaults]])
    label_ids = await validate_task_labels(db, payload.column_id, payload.label_ids)
    maximum = await fetch_one(
        db, 'SELECT max("order") AS maximum FROM tasks WHERE "columnId" = :id', {"id": payload.column_id}
    )
    order = (maximum or {}).get("maximum")
    task_id = new_id()
    now = datetime.now(UTC)
    try:
        await execute(
            db,
            'INSERT INTO tasks (id, title, description, "columnId", "order", priority, "dueDate", "createdById", "createdAt", "updatedAt") '
            "VALUES (:id, :title, :description, :column_id, :order, :priority, :due_date, :created_by, :now, :now)",
            {
                "id": task_id,
                "title": payload.title,
                "description": payload.description,
                "column_id": payload.column_id,
                "order": (order + 1 if order is not None else 0),
                "priority": payload.priority,
                "due_date": payload.due_date,
                "created_by": principal.id,
                "now": now,
            },
        )
        for user_id in assignee_ids:
            await execute(
                db,
                'INSERT INTO task_assignees (id, "taskId", "userId") VALUES (:id, :task_id, :user_id)',
                {"id": new_id(), "task_id": task_id, "user_id": user_id},
            )
        for label_id in label_ids:
            await execute(
                db,
                'INSERT INTO task_labels (id, "taskId", "labelId") VALUES (:id, :task_id, :label_id)',
                {"id": new_id(), "task_id": task_id, "label_id": label_id},
            )
        project = await fetch_one(db, "SELECT name FROM projects WHERE id = :id", {"id": project_id})
        await log_activity(
            db,
            principal,
            type="task_created",
            message=f'created task "{payload.title}" in {project["name"]}',
            entity_type="Task",
            entity_id=task_id,
        )
        await db.commit()
    except HTTPException:
        await db.rollback()
        raise
    except (IntegrityError, DataError, StatementError) as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="The task did not pass database validation") from exc
    except Exception:
        await db.rollback()
        raise
    return {"data": await task_payload(db, task_id)}


@router.post("/tasks/bulk-move")
async def bulk_move_tasks(
    payload: BulkTaskMove,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "column", payload.target_column_id)
    task_ids = unique(payload.task_ids)
    for task_id in task_ids:
        await related_access(db, principal, "task", task_id)
    target = await fetch_all(
        db, 'SELECT id FROM tasks WHERE "columnId" = :id ORDER BY "order"', {"id": payload.target_column_id}
    )
    moving = set(task_ids)
    final_ids = [row["id"] for row in target if row["id"] not in moving] + task_ids
    try:
        for task_id in task_ids:
            await execute(
                db,
                'UPDATE tasks SET "columnId" = :column_id WHERE id = :id',
                {"column_id": payload.target_column_id, "id": task_id},
            )
        for order, task_id in enumerate(final_ids):
            await execute(
                db,
                'UPDATE tasks SET "order" = :order, "updatedAt" = :now WHERE id = :id',
                {"order": order, "now": datetime.now(UTC), "id": task_id},
            )
        defaults = await fetch_all(
            db, 'SELECT "userId" FROM column_default_assignees WHERE "columnId" = :id', {"id": payload.target_column_id}
        )
        for task_id in task_ids:
            for default in defaults:
                await execute(
                    db,
                    'INSERT INTO task_assignees (id, "taskId", "userId") VALUES (:id, :task_id, :user_id) ON CONFLICT ("taskId", "userId") DO NOTHING',
                    {"id": new_id(), "task_id": task_id, "user_id": default["userId"]},
                )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"success": True}


@router.post("/tasks/bulk-delete")
async def bulk_delete_tasks(
    payload: BulkTaskDelete,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    task_ids = unique(payload.task_ids)
    for task_id in task_ids:
        await related_access(db, principal, "task", task_id, manage=True)
    for task_id in task_ids:
        await execute(db, "DELETE FROM tasks WHERE id = :id", {"id": task_id})
    await db.commit()
    return {"success": True}


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:read")
    await related_access(db, principal, "task", task_id)
    task = await task_payload(db, task_id)
    task["comments"] = await fetch_all(
        db,
        'SELECT tc.id, tc.content, tc."taskId", tc."userId", tc."parentId", tc."createdAt", tc."updatedAt", '
        "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS user "
        'FROM task_comments tc JOIN users u ON u.id = tc."userId" WHERE tc."taskId" = :id ORDER BY tc."createdAt"',
        {"id": task_id},
    )
    roots = [comment for comment in task["comments"] if comment["parentId"] is None]
    for comment in roots:
        comment["replies"] = [reply for reply in task["comments"] if reply["parentId"] == comment["id"]]
    task["comments"] = roots
    task["activity"] = await fetch_all(
        db,
        'SELECT a.id, a.type, a.message, a."entityType", a."entityId", a.metadata, a."createdAt", '
        "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS user "
        'FROM activities a JOIN users u ON u.id = a."userId" WHERE a."entityType" = \'Task\' AND a."entityId" = :id '
        'ORDER BY a."createdAt" DESC LIMIT 30',
        {"id": task_id},
    )
    return {"data": task}


@router.patch("/tasks/{task_id}")
async def update_task(
    task_id: str,
    payload: TaskUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    current_project_id = await related_access(db, principal, "task", task_id)
    values = dump(payload, exclude_unset=True)
    column_id = values.pop("columnId", None)
    assignee_ids = values.pop("assigneeIds", None)
    label_ids = values.pop("labelIds", None)
    current = await fetch_one(db, 'SELECT "columnId" FROM tasks WHERE id = :id', {"id": task_id})
    target_column_id = column_id or current["columnId"]
    target_project_id = current_project_id
    if column_id:
        target_project_id = await related_access(db, principal, "column", column_id)
    if assignee_ids is not None:
        assignee_ids = unique(assignee_ids)
        await validate_project_members(
            db,
            target_project_id,
            assignee_ids,
            "All assignees must be members of the project.",
        )
    if label_ids is not None:
        label_ids = await validate_task_labels(db, target_column_id, label_ids)
    try:
        if column_id and column_id != current["columnId"]:
            maximum = await fetch_one(
                db,
                'SELECT max("order") AS maximum FROM tasks WHERE "columnId" = :id',
                {"id": column_id},
            )
            max_order = (maximum or {}).get("maximum")
            values["columnId"] = column_id
            values["order"] = (max_order if max_order is not None else -1) + 1
        if values:
            values.update({"id": task_id, "updatedAt": datetime.now(UTC)})
            await execute(db, update_sql("tasks", values), values)
        if assignee_ids is not None:
            await execute(db, 'DELETE FROM task_assignees WHERE "taskId" = :id', {"id": task_id})
            for user_id in assignee_ids:
                await execute(
                    db,
                    'INSERT INTO task_assignees (id, "taskId", "userId") VALUES (:id, :task_id, :user_id)',
                    {"id": new_id(), "task_id": task_id, "user_id": user_id},
                )
        if label_ids is not None:
            await execute(db, 'DELETE FROM task_labels WHERE "taskId" = :id', {"id": task_id})
            for label_id in label_ids:
                await execute(
                    db,
                    'INSERT INTO task_labels (id, "taskId", "labelId") VALUES (:id, :task_id, :label_id)',
                    {"id": new_id(), "task_id": task_id, "label_id": label_id},
                )
        elif column_id and column_id != current["columnId"]:
            await execute(
                db,
                'DELETE FROM task_labels tl USING labels l WHERE tl."labelId" = l.id '
                'AND tl."taskId" = :task_id AND l."boardId" <> (SELECT "boardId" FROM columns WHERE id = :column_id)',
                {"task_id": task_id, "column_id": column_id},
            )
        if column_id and column_id != current["columnId"]:
            defaults = await fetch_all(
                db,
                'SELECT "userId" FROM column_default_assignees WHERE "columnId" = :id',
                {"id": column_id},
            )
            for default in defaults:
                await execute(
                    db,
                    'INSERT INTO task_assignees (id, "taskId", "userId") VALUES (:id, :task_id, :user_id) '
                    'ON CONFLICT ("taskId", "userId") DO NOTHING',
                    {"id": new_id(), "task_id": task_id, "user_id": default["userId"]},
                )
            if target_project_id != current_project_id:
                await execute(
                    db,
                    'DELETE FROM task_assignees ta WHERE ta."taskId" = :task_id AND NOT EXISTS '
                    '(SELECT 1 FROM project_members pm WHERE pm."projectId" = :project_id '
                    'AND pm."userId" = ta."userId")',
                    {"task_id": task_id, "project_id": target_project_id},
                )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"data": await task_payload(db, task_id)}


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id, manage=True)
    await execute(db, "DELETE FROM tasks WHERE id = :id", {"id": task_id})
    await db.commit()
    return {"success": True}


@router.post("/tasks/{task_id}/move")
async def move_task(
    task_id: str,
    payload: TaskMove,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id)
    await related_access(db, principal, "column", payload.target_column_id)
    task = await fetch_one(
        db,
        'SELECT t.title, t."columnId", c.name AS "columnName" FROM tasks t JOIN columns c ON c.id = t."columnId" WHERE t.id = :id',
        {"id": task_id},
    )
    source_column_id = task["columnId"]
    source = await fetch_all(
        db, 'SELECT id FROM tasks WHERE "columnId" = :id ORDER BY "order"', {"id": source_column_id}
    )
    source_ids = [row["id"] for row in source if row["id"] != task_id]
    same_column = source_column_id == payload.target_column_id
    try:
        if same_column:
            index = min(payload.new_order, len(source_ids))
            source_ids.insert(index, task_id)
            for order, current_id in enumerate(source_ids):
                await execute(
                    db,
                    'UPDATE tasks SET "order" = :order, "updatedAt" = :now WHERE id = :id',
                    {"order": order, "now": datetime.now(UTC), "id": current_id},
                )
        else:
            for order, current_id in enumerate(source_ids):
                await execute(
                    db, 'UPDATE tasks SET "order" = :order WHERE id = :id', {"order": order, "id": current_id}
                )
            target = await fetch_all(
                db, 'SELECT id FROM tasks WHERE "columnId" = :id ORDER BY "order"', {"id": payload.target_column_id}
            )
            target_ids = [row["id"] for row in target]
            target_ids.insert(min(payload.new_order, len(target_ids)), task_id)
            await execute(
                db,
                'UPDATE tasks SET "columnId" = :column_id WHERE id = :id',
                {"column_id": payload.target_column_id, "id": task_id},
            )
            for order, current_id in enumerate(target_ids):
                await execute(
                    db,
                    'UPDATE tasks SET "order" = :order, "updatedAt" = :now WHERE id = :id',
                    {"order": order, "now": datetime.now(UTC), "id": current_id},
                )
            defaults = await fetch_all(
                db,
                'SELECT "userId" FROM column_default_assignees WHERE "columnId" = :id',
                {"id": payload.target_column_id},
            )
            for default in defaults:
                await execute(
                    db,
                    'INSERT INTO task_assignees (id, "taskId", "userId") VALUES (:id, :task_id, :user_id) ON CONFLICT ("taskId", "userId") DO NOTHING',
                    {"id": new_id(), "task_id": task_id, "user_id": default["userId"]},
                )
        target = await fetch_one(
            db,
            'SELECT c.name, p.id AS "projectId", p.name AS "projectName" FROM columns c JOIN boards b ON b.id = c."boardId" '
            'JOIN projects p ON p.id = b."projectId" WHERE c.id = :id',
            {"id": payload.target_column_id},
        )
        done_names = {"done", "complete", "completed", "shipped", "closed"}
        if target and target["name"].lower() in done_names and task["columnName"].lower() not in done_names:
            await log_activity(
                db,
                principal,
                type="task_completed",
                message=f'completed task "{task["title"]}" in {target["projectName"]}',
                entity_type="Task",
                entity_id=task_id,
            )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"success": True}


@router.put("/tasks/{task_id}/assignees")
async def set_task_assignees(
    task_id: str,
    payload: TaskAssignees,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    project_id = await related_access(db, principal, "task", task_id)
    assignee_ids = unique(payload.assignee_ids)
    await validate_project_members(db, project_id, assignee_ids, "All assignees must be members of the project.")
    await execute(db, 'DELETE FROM task_assignees WHERE "taskId" = :id', {"id": task_id})
    for user_id in assignee_ids:
        await execute(
            db,
            'INSERT INTO task_assignees (id, "taskId", "userId") VALUES (:id, :task_id, :user_id)',
            {"id": new_id(), "task_id": task_id, "user_id": user_id},
        )
    await db.commit()
    return {"success": True}


@router.get("/boards/{board_id}/labels")
async def list_labels(
    board_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:read")
    await related_access(db, principal, "board", board_id)
    return {
        "data": await fetch_all(
            db, 'SELECT id, name, color, "boardId" FROM labels WHERE "boardId" = :id ORDER BY name', {"id": board_id}
        )
    }


@router.post("/labels", status_code=status.HTTP_201_CREATED)
async def create_label(
    payload: LabelCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "board", payload.board_id)
    label_id = new_id()
    await execute(
        db,
        'INSERT INTO labels (id, name, color, "boardId") VALUES (:id, :name, :color, :board_id)',
        {"id": label_id, "name": payload.name, "color": payload.color, "board_id": payload.board_id},
    )
    await db.commit()
    return {
        "data": await fetch_one(db, 'SELECT id, name, color, "boardId" FROM labels WHERE id = :id', {"id": label_id})
    }


@router.patch("/labels/{label_id}")
async def update_label(
    label_id: str,
    payload: LabelUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    label = await fetch_one(db, 'SELECT "boardId" FROM labels WHERE id = :id', {"id": label_id})
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    await related_access(db, principal, "board", label["boardId"], manage=True)
    values = dump(payload, exclude_unset=True)
    if values:
        assignments = ", ".join(f'"{key}" = :{key}' for key in values)
        await execute(db, f"UPDATE labels SET {assignments} WHERE id = :id", {**values, "id": label_id})
        await db.commit()
    return {
        "data": await fetch_one(db, 'SELECT id, name, color, "boardId" FROM labels WHERE id = :id', {"id": label_id})
    }


@router.delete("/labels/{label_id}")
async def delete_label(
    label_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    label = await fetch_one(db, 'SELECT "boardId" FROM labels WHERE id = :id', {"id": label_id})
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    await related_access(db, principal, "board", label["boardId"], manage=True)
    await execute(db, 'DELETE FROM task_labels WHERE "labelId" = :id', {"id": label_id})
    await execute(db, "DELETE FROM labels WHERE id = :id", {"id": label_id})
    await db.commit()
    return {"success": True}


@router.post("/tasks/{task_id}/labels", status_code=status.HTTP_201_CREATED)
async def add_task_label(
    task_id: str,
    payload: TaskLabelInput,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id)
    boards = await fetch_one(
        db,
        'SELECT c."boardId" AS "taskBoardId", l."boardId" AS "labelBoardId" FROM tasks t JOIN columns c ON c.id = t."columnId" '
        "JOIN labels l ON l.id = :label_id WHERE t.id = :task_id",
        {"label_id": payload.label_id, "task_id": task_id},
    )
    if not boards or boards["taskBoardId"] != boards["labelBoardId"]:
        raise HTTPException(status_code=400, detail="A task can only use labels from its board")
    row_id = new_id()
    await execute(
        db,
        'INSERT INTO task_labels (id, "taskId", "labelId") VALUES (:id, :task_id, :label_id) ON CONFLICT ("taskId", "labelId") DO NOTHING',
        {"id": row_id, "task_id": task_id, "label_id": payload.label_id},
    )
    await db.commit()
    return {"data": {"id": row_id, "taskId": task_id, "labelId": payload.label_id}}


@router.delete("/tasks/{task_id}/labels/{label_id}")
async def remove_task_label(
    task_id: str,
    label_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id)
    await execute(
        db,
        'DELETE FROM task_labels WHERE "taskId" = :task_id AND "labelId" = :label_id',
        {"task_id": task_id, "label_id": label_id},
    )
    await db.commit()
    return {"success": True}


@router.post("/tasks/{task_id}/comments", status_code=status.HTTP_201_CREATED)
async def add_comment(
    task_id: str,
    payload: CommentCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id)
    if payload.parent_id:
        parent = await fetch_one(db, 'SELECT "taskId" FROM task_comments WHERE id = :id', {"id": payload.parent_id})
        if not parent or parent["taskId"] != task_id:
            raise HTTPException(status_code=400, detail="Reply target does not belong to this task.")
    comment_id = new_id()
    now = datetime.now(UTC)
    await execute(
        db,
        'INSERT INTO task_comments (id, content, "taskId", "userId", "parentId", "createdAt", "updatedAt") VALUES (:id, :content, :task_id, :user_id, :parent_id, :now, :now)',
        {
            "id": comment_id,
            "content": payload.content,
            "task_id": task_id,
            "user_id": principal.id,
            "parent_id": payload.parent_id,
            "now": now,
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, content, "taskId", "userId", "parentId", "createdAt", "updatedAt" FROM task_comments WHERE id = :id',
            {"id": comment_id},
        )
    }


@router.get("/tasks/{task_id}/comments")
async def list_task_comments(
    task_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:read")
    await related_access(db, principal, "task", task_id)
    comments = await fetch_all(
        db,
        'SELECT tc.id, tc.content, tc."taskId", tc."userId", tc."parentId", tc."createdAt", tc."updatedAt", '
        "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS user "
        'FROM task_comments tc JOIN users u ON u.id = tc."userId" WHERE tc."taskId" = :id '
        'ORDER BY tc."createdAt"',
        {"id": task_id},
    )
    roots = [comment for comment in comments if comment["parentId"] is None]
    for comment in roots:
        comment["replies"] = [reply for reply in comments if reply["parentId"] == comment["id"]]
    return {"data": roots}


async def editable_comment(db: AsyncConnection, principal: Principal, comment_id: str) -> dict[str, Any]:
    comment = await fetch_one(db, 'SELECT id, "taskId", "userId" FROM task_comments WHERE id = :id', {"id": comment_id})
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    await related_access(db, principal, "task", comment["taskId"])
    if comment["userId"] != principal.id and principal.role != "ADMIN":
        raise HTTPException(status_code=403, detail="You can only edit your own comment.")
    return comment


@router.patch("/comments/{comment_id}")
async def update_comment(
    comment_id: str,
    payload: CommentUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await editable_comment(db, principal, comment_id)
    await execute(
        db,
        'UPDATE task_comments SET content = :content, "updatedAt" = :now WHERE id = :id',
        {"content": payload.content, "now": datetime.now(UTC), "id": comment_id},
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, content, "taskId", "userId", "parentId", "createdAt", "updatedAt" FROM task_comments WHERE id = :id',
            {"id": comment_id},
        )
    }


@router.delete("/comments/{comment_id}")
async def delete_comment(
    comment_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await editable_comment(db, principal, comment_id)
    await execute(db, 'DELETE FROM task_comments WHERE "parentId" = :id', {"id": comment_id})
    await execute(db, "DELETE FROM task_comments WHERE id = :id", {"id": comment_id})
    await db.commit()
    return {"success": True}


@router.put("/tasks/{task_id}/parent")
async def set_task_parent(
    task_id: str,
    payload: TaskParentUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id)
    if payload.parent_id is None:
        await execute(
            db,
            'UPDATE tasks SET "parentId" = NULL, "updatedAt" = :now WHERE id = :id',
            {"now": datetime.now(UTC), "id": task_id},
        )
        await db.commit()
        return {"success": True}
    if payload.parent_id == task_id:
        raise HTTPException(status_code=400, detail="A task cannot be its own parent.")
    await related_access(db, principal, "task", payload.parent_id)
    boards = await fetch_one(
        db,
        'SELECT (SELECT c."boardId" FROM tasks t JOIN columns c ON c.id = t."columnId" WHERE t.id = :task_id) AS task_board, '
        '(SELECT c."boardId" FROM tasks t JOIN columns c ON c.id = t."columnId" WHERE t.id = :parent_id) AS parent_board',
        {"task_id": task_id, "parent_id": payload.parent_id},
    )
    if not boards or boards["task_board"] != boards["parent_board"]:
        raise HTTPException(status_code=400, detail="A subtask must be on the same board as its parent.")
    cursor: str | None = payload.parent_id
    seen: set[str] = set()
    while cursor:
        if cursor == task_id:
            raise HTTPException(
                status_code=400, detail="That task is a subtask of this one — it cannot also be its parent."
            )
        if cursor in seen:
            break
        seen.add(cursor)
        ancestor = await fetch_one(db, 'SELECT "parentId" FROM tasks WHERE id = :id', {"id": cursor})
        cursor = ancestor["parentId"] if ancestor else None
    await execute(
        db,
        'UPDATE tasks SET "parentId" = :parent_id, "updatedAt" = :now WHERE id = :id',
        {"parent_id": payload.parent_id, "now": datetime.now(UTC), "id": task_id},
    )
    await db.commit()
    return {"success": True}


@router.post("/tasks/{task_id}/blockers", status_code=status.HTTP_201_CREATED)
async def add_blocker(
    task_id: str,
    payload: BlockerCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    if task_id == payload.blocking_task_id:
        raise HTTPException(status_code=400, detail="A task cannot block itself.")
    await related_access(db, principal, "task", task_id)
    await related_access(db, principal, "task", payload.blocking_task_id)
    visited: set[str] = set()
    frontier = [task_id]
    while frontier:
        next_frontier: list[str] = []
        for current in frontier:
            edges = await fetch_all(
                db,
                'SELECT "blockedTaskId" FROM task_blockers WHERE "blockingTaskId" = :id',
                {"id": current},
            )
            for edge in edges:
                blocked_id = edge["blockedTaskId"]
                if blocked_id == payload.blocking_task_id:
                    raise HTTPException(status_code=400, detail="That dependency would create a dependency cycle.")
                if blocked_id not in visited:
                    visited.add(blocked_id)
                    next_frontier.append(blocked_id)
        frontier = next_frontier
    existing = await fetch_one(
        db,
        'SELECT id FROM task_blockers WHERE "blockedTaskId" = :blocked AND "blockingTaskId" = :blocking',
        {"blocked": task_id, "blocking": payload.blocking_task_id},
    )
    if existing:
        raise HTTPException(status_code=400, detail="That dependency already exists.")
    blocker_id = new_id()
    await execute(
        db,
        'INSERT INTO task_blockers (id, "blockedTaskId", "blockingTaskId", "createdAt") '
        "VALUES (:id, :blocked, :blocking, :now)",
        {"id": blocker_id, "blocked": task_id, "blocking": payload.blocking_task_id, "now": datetime.now(UTC)},
    )
    await db.commit()
    return {"data": {"id": blocker_id, "blockedTaskId": task_id, "blockingTaskId": payload.blocking_task_id}}


@router.delete("/blockers/{blocker_id}")
async def remove_blocker(
    blocker_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    blocker = await fetch_one(db, 'SELECT "blockedTaskId" FROM task_blockers WHERE id = :id', {"id": blocker_id})
    if not blocker:
        raise HTTPException(status_code=404, detail="Dependency not found.")
    await related_access(db, principal, "task", blocker["blockedTaskId"])
    await execute(db, "DELETE FROM task_blockers WHERE id = :id", {"id": blocker_id})
    await db.commit()
    return {"success": True}


@router.post("/tasks/{task_id}/attachments", status_code=status.HTTP_201_CREATED)
async def add_attachment(
    task_id: str,
    payload: AttachmentCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id)
    attachment_id = new_id()
    await execute(
        db,
        'INSERT INTO task_attachments (id, name, url, type, size, "taskId", "createdAt") '
        "VALUES (:id, :name, :url, :type, :size, :task_id, :now)",
        {
            "id": attachment_id,
            "name": payload.name,
            "url": payload.url,
            "type": payload.type,
            "size": payload.size,
            "task_id": task_id,
            "now": datetime.now(UTC),
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, url, type, size, "taskId", "createdAt" FROM task_attachments WHERE id = :id',
            {"id": attachment_id},
        )
    }


@router.delete("/attachments/{attachment_id}")
async def delete_attachment(
    attachment_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    attachment = await fetch_one(db, 'SELECT "taskId" FROM task_attachments WHERE id = :id', {"id": attachment_id})
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    await related_access(db, principal, "task", attachment["taskId"])
    await execute(db, "DELETE FROM task_attachments WHERE id = :id", {"id": attachment_id})
    await db.commit()
    return {"success": True}


@router.post("/tasks/{task_id}/checklists", status_code=status.HTTP_201_CREATED)
async def create_checklist(
    task_id: str,
    payload: ChecklistCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await related_access(db, principal, "task", task_id)
    maximum = await fetch_one(
        db, 'SELECT max("order") AS maximum FROM task_checklists WHERE "taskId" = :id', {"id": task_id}
    )
    max_order = (maximum or {}).get("maximum")
    checklist_id = new_id()
    await execute(
        db,
        'INSERT INTO task_checklists (id, name, "taskId", "order") VALUES (:id, :name, :task_id, :order)',
        {
            "id": checklist_id,
            "name": payload.name,
            "task_id": task_id,
            "order": (max_order if max_order is not None else -1) + 1,
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db, 'SELECT id, name, "taskId", "order" FROM task_checklists WHERE id = :id', {"id": checklist_id}
        )
    }


async def checklist_access(
    db: AsyncConnection,
    principal: Principal,
    checklist_id: str,
) -> dict[str, Any]:
    checklist = await fetch_one(db, 'SELECT id, "taskId" FROM task_checklists WHERE id = :id', {"id": checklist_id})
    if not checklist:
        raise HTTPException(status_code=404, detail="Checklist not found")
    await related_access(db, principal, "task", checklist["taskId"])
    return checklist


@router.patch("/checklists/{checklist_id}")
async def update_checklist(
    checklist_id: str,
    payload: ChecklistUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await checklist_access(db, principal, checklist_id)
    await execute(
        db, "UPDATE task_checklists SET name = :name WHERE id = :id", {"name": payload.name, "id": checklist_id}
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db, 'SELECT id, name, "taskId", "order" FROM task_checklists WHERE id = :id', {"id": checklist_id}
        )
    }


@router.delete("/checklists/{checklist_id}")
async def delete_checklist(
    checklist_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await checklist_access(db, principal, checklist_id)
    await execute(db, "DELETE FROM task_checklists WHERE id = :id", {"id": checklist_id})
    await db.commit()
    return {"success": True}


@router.post("/checklists/{checklist_id}/items", status_code=status.HTTP_201_CREATED)
async def create_checklist_item(
    checklist_id: str,
    payload: ChecklistItemCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await checklist_access(db, principal, checklist_id)
    maximum = await fetch_one(
        db, 'SELECT max("order") AS maximum FROM task_checklist_items WHERE "checklistId" = :id', {"id": checklist_id}
    )
    max_order = (maximum or {}).get("maximum")
    item_id = new_id()
    await execute(
        db,
        'INSERT INTO task_checklist_items (id, text, completed, "checklistId", "order") '
        "VALUES (:id, :text, false, :checklist_id, :order)",
        {
            "id": item_id,
            "text": payload.text,
            "checklist_id": checklist_id,
            "order": (max_order if max_order is not None else -1) + 1,
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, text, completed, "checklistId", "order" FROM task_checklist_items WHERE id = :id',
            {"id": item_id},
        )
    }


async def checklist_item_access(
    db: AsyncConnection,
    principal: Principal,
    item_id: str,
) -> dict[str, Any]:
    item = await fetch_one(
        db,
        'SELECT i.id, i."checklistId", c."taskId" FROM task_checklist_items i '
        'JOIN task_checklists c ON c.id = i."checklistId" WHERE i.id = :id',
        {"id": item_id},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Checklist item not found")
    await related_access(db, principal, "task", item["taskId"])
    return item


@router.patch("/checklist-items/{item_id}")
async def update_checklist_item(
    item_id: str,
    payload: ChecklistItemUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await checklist_item_access(db, principal, item_id)
    values = dump(payload, exclude_unset=True)
    if values:
        assignments = ", ".join(f'"{key}" = :{key}' for key in values)
        await execute(db, f"UPDATE task_checklist_items SET {assignments} WHERE id = :id", {**values, "id": item_id})
        await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, text, completed, "checklistId", "order" FROM task_checklist_items WHERE id = :id',
            {"id": item_id},
        )
    }


@router.delete("/checklist-items/{item_id}")
async def delete_checklist_item(
    item_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await checklist_item_access(db, principal, item_id)
    await execute(db, "DELETE FROM task_checklist_items WHERE id = :id", {"id": item_id})
    await db.commit()
    return {"success": True}


@router.get("/projects/{project_id}/milestones")
async def list_milestones(
    project_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:read")
    await project_access(db, principal, project_id)
    return {
        "data": await fetch_all(
            db,
            'SELECT id, name, description, "projectId", "dueDate", "completedAt", "createdAt", "updatedAt" '
            'FROM milestones WHERE "projectId" = :id ORDER BY "dueDate"',
            {"id": project_id},
        )
    }


@router.post("/projects/{project_id}/milestones", status_code=status.HTTP_201_CREATED)
async def create_milestone(
    project_id: str,
    payload: MilestoneCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await project_access(db, principal, project_id)
    milestone_id = new_id()
    now = datetime.now(UTC)
    await execute(
        db,
        'INSERT INTO milestones (id, name, description, "projectId", "dueDate", "createdAt", "updatedAt") '
        "VALUES (:id, :name, :description, :project_id, :due_date, :now, :now)",
        {
            "id": milestone_id,
            "name": payload.name,
            "description": payload.description,
            "project_id": project_id,
            "due_date": payload.due_date,
            "now": now,
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, description, "projectId", "dueDate", "completedAt", "createdAt", "updatedAt" FROM milestones WHERE id = :id',
            {"id": milestone_id},
        )
    }


async def milestone_access(
    db: AsyncConnection,
    principal: Principal,
    milestone_id: str,
) -> dict[str, Any]:
    milestone = await fetch_one(db, 'SELECT id, "projectId" FROM milestones WHERE id = :id', {"id": milestone_id})
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    await project_access(db, principal, milestone["projectId"])
    return milestone


@router.patch("/milestones/{milestone_id}")
async def update_milestone(
    milestone_id: str,
    payload: MilestoneUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await milestone_access(db, principal, milestone_id)
    values = dump(payload, exclude_unset=True)
    if values:
        values.update({"id": milestone_id, "updatedAt": datetime.now(UTC)})
        await execute(db, update_sql("milestones", values), values)
        await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, description, "projectId", "dueDate", "completedAt", "createdAt", "updatedAt" FROM milestones WHERE id = :id',
            {"id": milestone_id},
        )
    }


@router.delete("/milestones/{milestone_id}")
async def delete_milestone(
    milestone_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    await milestone_access(db, principal, milestone_id)
    await execute(db, "DELETE FROM milestones WHERE id = :id", {"id": milestone_id})
    await db.commit()
    return {"success": True}


@router.get("/projects/{project_id}/files")
async def list_project_files(
    project_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:read")
    await project_access(db, principal, project_id)
    return {
        "data": await fetch_all(
            db,
            'SELECT f.id, f.name, f.url, f.type, f.size, f."projectId", f."uploadedById", f."createdAt", '
            "json_build_object('id', u.id, 'name', u.name) AS \"uploadedBy\" "
            'FROM project_files f JOIN users u ON u.id = f."uploadedById" WHERE f."projectId" = :id '
            'ORDER BY f."createdAt" DESC',
            {"id": project_id},
        )
    }


@router.post("/projects/{project_id}/files", status_code=status.HTTP_201_CREATED)
async def create_project_file(
    project_id: str,
    payload: ProjectFileCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    await project_access(db, principal, project_id)
    file_id = new_id()
    await execute(
        db,
        'INSERT INTO project_files (id, name, url, type, size, "projectId", "uploadedById", "createdAt") '
        "VALUES (:id, :name, :url, :type, :size, :project_id, :uploaded_by, :now)",
        {
            "id": file_id,
            "name": payload.name,
            "url": payload.url,
            "type": payload.type,
            "size": payload.size,
            "project_id": project_id,
            "uploaded_by": principal.id,
            "now": datetime.now(UTC),
        },
    )
    await log_activity(
        db,
        principal,
        type="project_file_added",
        message=f"uploaded {payload.name}",
        entity_type="Project",
        entity_id=project_id,
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, url, type, size, "projectId", "uploadedById", "createdAt" FROM project_files WHERE id = :id',
            {"id": file_id},
        )
    }


@router.delete("/project-files/{file_id}")
async def delete_project_file(
    file_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "projects:write")
    file = await fetch_one(db, 'SELECT "projectId" FROM project_files WHERE id = :id', {"id": file_id})
    if not file:
        raise HTTPException(status_code=404, detail="Project file not found")
    await project_access(db, principal, file["projectId"])
    await execute(db, "DELETE FROM project_files WHERE id = :id", {"id": file_id})
    await db.commit()
    return {"success": True}


@router.post("/time-entries", status_code=status.HTTP_201_CREATED)
async def create_time_entry(
    payload: TimeEntryCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await project_access(db, principal, payload.project_id)
    if payload.task_id:
        task_project_id = await related_access(db, principal, "task", payload.task_id)
        if task_project_id != payload.project_id:
            raise HTTPException(status_code=400, detail="That task does not belong to the given project.")
    entry_id = new_id()
    now = datetime.now(UTC)
    await execute(
        db,
        'INSERT INTO time_entries (id, "userId", "taskId", "projectId", description, hours, date, "createdAt", "updatedAt") '
        "VALUES (:id, :user_id, :task_id, :project_id, :description, :hours, :date, :now, :now)",
        {
            "id": entry_id,
            "user_id": principal.id,
            "task_id": payload.task_id,
            "project_id": payload.project_id,
            "description": payload.description,
            "hours": payload.hours,
            "date": payload.date,
            "now": now,
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, "userId", "taskId", "projectId", description, hours, date, "createdAt", "updatedAt" FROM time_entries WHERE id = :id',
            {"id": entry_id},
        )
    }


async def editable_time_entry(
    db: AsyncConnection,
    principal: Principal,
    entry_id: str,
) -> dict[str, Any]:
    entry = await fetch_one(db, 'SELECT id, "userId", "projectId" FROM time_entries WHERE id = :id', {"id": entry_id})
    if not entry:
        raise HTTPException(status_code=404, detail="Time entry not found.")
    await project_access(db, principal, entry["projectId"])
    if entry["userId"] != principal.id and principal.role != "ADMIN":
        raise HTTPException(status_code=403, detail="You can only edit your own time entries.")
    return entry


@router.patch("/time-entries/{entry_id}")
async def update_time_entry(
    entry_id: str,
    payload: TimeEntryUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:write")
    await editable_time_entry(db, principal, entry_id)
    values = dump(payload, exclude_unset=True)
    if values:
        values.update({"id": entry_id, "updatedAt": datetime.now(UTC)})
        await execute(db, update_sql("time_entries", values), values)
        await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, "userId", "taskId", "projectId", description, hours, date, "createdAt", "updatedAt" FROM time_entries WHERE id = :id',
            {"id": entry_id},
        )
    }


@router.delete("/time-entries/{entry_id}")
async def delete_time_entry(
    entry_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "tasks:write")
    await editable_time_entry(db, principal, entry_id)
    await execute(db, "DELETE FROM time_entries WHERE id = :id", {"id": entry_id})
    await db.commit()
    return {"success": True}


@router.get("/tasks/{task_id}/time-entries")
async def list_task_time_entries(
    task_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:read")
    await related_access(db, principal, "task", task_id)
    return {
        "data": await fetch_all(
            db,
            'SELECT te.id, te."userId", te."taskId", te."projectId", te.description, te.hours, te.date, '
            "te.\"createdAt\", te.\"updatedAt\", json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS user "
            'FROM time_entries te JOIN users u ON u.id = te."userId" WHERE te."taskId" = :id ORDER BY te.date DESC',
            {"id": task_id},
        )
    }


@router.get("/projects/{project_id}/time-rollup")
async def project_time_rollup(
    project_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "tasks:read")
    await project_access(db, principal, project_id)
    total = await fetch_one(
        db,
        'SELECT coalesce(sum(hours), 0) AS hours, count(*) AS entries FROM time_entries WHERE "projectId" = :id',
        {"id": project_id},
    ) or {"hours": 0, "entries": 0}
    by_user = await fetch_all(
        db,
        'SELECT te."userId", u.name, u.avatar, coalesce(sum(te.hours), 0) AS hours, count(*) AS entries '
        'FROM time_entries te JOIN users u ON u.id = te."userId" WHERE te."projectId" = :id '
        'GROUP BY te."userId", u.name, u.avatar ORDER BY hours DESC',
        {"id": project_id},
    )
    by_task = await fetch_all(
        db,
        'SELECT te."taskId", coalesce(t.title, CASE WHEN te."taskId" IS NULL THEN \'Project-level (no task)\' '
        "ELSE 'Deleted task' END) AS title, coalesce(sum(te.hours), 0) AS hours, count(*) AS entries "
        'FROM time_entries te LEFT JOIN tasks t ON t.id = te."taskId" WHERE te."projectId" = :id '
        'GROUP BY te."taskId", t.title ORDER BY hours DESC',
        {"id": project_id},
    )
    return {
        "data": {
            "projectId": project_id,
            "totalHours": round(float(total["hours"]), 2),
            "entryCount": total["entries"],
            "byUser": by_user,
            "byTask": by_task,
        }
    }
