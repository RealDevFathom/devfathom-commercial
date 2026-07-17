import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import DataError, IntegrityError, StatementError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection
from ..security import Principal, current_principal
from .delivery_schemas import TrelloImport
from .domain_common import execute, fetch_all, fetch_one, log_activity, new_id, project_access, require_scope, unique

router = APIRouter(prefix="/api/v1", tags=["trello-import"])

TRELLO_COLORS = {
    "yellow": "#F2D600",
    "purple": "#C377E0",
    "blue": "#0079BF",
    "red": "#EB5A46",
    "green": "#61BD4F",
    "orange": "#FF9F1A",
    "black": "#344563",
    "sky": "#00C2E0",
    "pink": "#FF78CB",
    "lime": "#51E898",
}
DONE_NAMES = {"done", "complete", "completed", "finished", "shipped"}


def safe_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return None


def value_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, dict):
        for key in ("text", "number", "date", "checked"):
            if key in value:
                return value_text(value[key])
    return None


def cover_text(cover: dict[str, Any] | None) -> str | None:
    if not cover:
        return None
    return value_text(cover.get("color")) or value_text(cover.get("url"))


def custom_field_text(item: dict[str, Any], field: dict[str, Any] | None) -> str | None:
    direct = value_text(item.get("value"))
    if direct:
        return direct
    option_id = item.get("idValue")
    if not option_id or not field:
        return None
    for option in field.get("options", []):
        if option.get("id") == option_id:
            return value_text(option.get("value"))
    return None


def board_key(name: str, board_id: str | None, list_names: list[str], card_count: int) -> str:
    if board_id:
        return board_id
    digest = hashlib.sha256(
        json.dumps(
            {"name": name, "lists": list_names, "cards": card_count},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    ).hexdigest()[:40]
    return f"local:{digest}"


@router.post("/trello-import")
async def import_trello_board(
    payload: TrelloImport,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "projects:write")
    now = datetime.now(UTC)
    created_project_id: str | None = None
    try:
        if payload.new_project_name:
            project_id = new_id()
            created_project_id = project_id
            await execute(
                db,
                'INSERT INTO projects (id, name, type, status, "techStack", "createdAt", "updatedAt") '
                "VALUES (:id, :name, 'INTERNAL', 'ACTIVE', ARRAY[]::text[], :now, :now)",
                {"id": project_id, "name": payload.new_project_name, "now": now},
            )
            await execute(
                db,
                'INSERT INTO project_members (id, "projectId", "userId", role) VALUES (:id, :project_id, :user_id, \'LEAD\')',
                {"id": new_id(), "project_id": project_id, "user_id": principal.id},
            )
        else:
            project_id = payload.project_id or ""
            await project_access(db, principal, project_id, manage=True)

        members = await fetch_all(
            db,
            'SELECT "userId" FROM project_members WHERE "projectId" = :id',
            {"id": project_id},
        )
        project_members = {row["userId"] for row in members}
        trello = payload.trello_json
        key = board_key(trello.name, trello.id, [item.name for item in trello.lists], len(trello.cards))
        existing = await fetch_one(db, 'SELECT name FROM boards WHERE "trelloBoardId" = :id', {"id": key})
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f'This board has already been imported as "{existing["name"]}". Delete the existing board first to re-import.',
            )

        lists = sorted(
            (trello.lists if payload.include_archived else [item for item in trello.lists if not item.closed]),
            key=lambda item: item.pos,
        )
        cards = sorted(
            (trello.cards if payload.include_archived else [item for item in trello.cards if not item.closed]),
            key=lambda item: item.pos,
        )
        board_id = new_id()
        await execute(
            db,
            'INSERT INTO boards (id, name, description, "projectId", "trelloBoardId", "createdAt", "updatedAt") '
            "VALUES (:id, :name, :description, :project_id, :trello_id, :now, :now)",
            {
                "id": board_id,
                "name": trello.name,
                "description": trello.desc or None,
                "project_id": project_id,
                "trello_id": key,
                "now": now,
            },
        )

        label_ids: dict[str, str] = {}
        unique_labels = [label for label in trello.labels if label.name or label.color]
        for label in unique_labels:
            label_id = new_id()
            label_ids[label.id] = label_id
            await execute(
                db,
                'INSERT INTO labels (id, name, color, "boardId") VALUES (:id, :name, :color, :board_id)',
                {
                    "id": label_id,
                    "name": label.name or label.color or "Label",
                    "color": TRELLO_COLORS.get(label.color or "", "#6E7280"),
                    "board_id": board_id,
                },
            )

        list_ids: dict[str, str] = {}
        for order, item in enumerate(lists):
            column_id = new_id()
            list_ids[item.id] = column_id
            await execute(
                db,
                'INSERT INTO columns (id, name, "boardId", "order", "createdAt", "updatedAt") VALUES (:id, :name, :board_id, :order, :now, :now)',
                {"id": column_id, "name": item.name, "board_id": board_id, "order": order, "now": now},
            )

        archived_column_id: str | None = None
        if payload.include_archived and any(card.closed for card in trello.cards):
            archived_column_id = new_id()
            await execute(
                db,
                'INSERT INTO columns (id, name, "boardId", "order", "createdAt", "updatedAt") VALUES (:id, \'Archived\', :board_id, :order, :now, :now)',
                {"id": archived_column_id, "board_id": board_id, "order": len(lists), "now": now},
            )

        done_column_id = next((list_ids[item.id] for item in lists if item.name.strip().lower() in DONE_NAMES), None)
        created_done = False
        completed_count = 0
        custom_fields = {str(field.get("id")): field for field in trello.custom_fields}
        checklists: dict[str, list[Any]] = {}
        for checklist in trello.checklists:
            checklists.setdefault(checklist.id_card, []).append(checklist)
        comments: dict[str, list[Any]] = {}
        for action in trello.actions:
            card = action.data.card or {}
            if action.type == "commentCard" and card.get("id"):
                comments.setdefault(str(card["id"]), []).append(action)

        column_order: dict[str, int] = {}
        skipped: list[dict[str, str]] = []
        tasks_created = 0
        for card in cards:
            column_id = archived_column_id if card.closed else list_ids.get(card.id_list)
            if not column_id:
                skipped.append(
                    {
                        "name": card.name,
                        "reason": (
                            "archived (and the Archived column was not created)"
                            if card.closed
                            else "its list was not imported"
                        ),
                    }
                )
                continue
            if not card.closed and card.due_complete:
                if not done_column_id:
                    done_column_id = new_id()
                    created_done = True
                    await execute(
                        db,
                        'INSERT INTO columns (id, name, "boardId", "order", "createdAt", "updatedAt") VALUES (:id, \'Done\', :board_id, :order, :now, :now)',
                        {
                            "id": done_column_id,
                            "board_id": board_id,
                            "order": len(lists) + (1 if archived_column_id else 0),
                            "now": now,
                        },
                    )
                column_id = done_column_id
                completed_count += 1

            custom_lines = []
            for item in card.custom_field_items:
                field = custom_fields.get(str(item.get("idCustomField", "")))
                text = custom_field_text(item, field)
                if text:
                    custom_lines.append(f"{(field or {}).get('name', 'Field')}: {text}")
            blocks = [
                f"Cover: {cover_text(card.cover)}" if cover_text(card.cover) else None,
                card.desc or None,
                "\n".join(custom_lines) or None,
            ]
            description = "\n\n".join(block for block in blocks if block) or None
            task_id = new_id()
            order = column_order.get(column_id, 0)
            column_order[column_id] = order + 1
            await execute(
                db,
                'INSERT INTO tasks (id, title, description, "columnId", "order", priority, "dueDate", "createdById", "createdAt", "updatedAt") '
                "VALUES (:id, :title, :description, :column_id, :order, 'MEDIUM', :due_date, :created_by, :now, :now)",
                {
                    "id": task_id,
                    "title": card.name,
                    "description": description,
                    "column_id": column_id,
                    "order": order,
                    "due_date": safe_date(card.due),
                    "created_by": principal.id,
                    "now": now,
                },
            )
            assignees = unique(
                [
                    payload.member_mapping[mid]
                    for mid in card.id_members
                    if payload.member_mapping.get(mid) in project_members
                ]
            )
            for user_id in assignees:
                await execute(
                    db,
                    'INSERT INTO task_assignees (id, "taskId", "userId") VALUES (:id, :task_id, :user_id)',
                    {"id": new_id(), "task_id": task_id, "user_id": user_id},
                )
            for card_label in card.labels:
                label_id = label_ids.get(card_label.id)
                if label_id:
                    await execute(
                        db,
                        'INSERT INTO task_labels (id, "taskId", "labelId") VALUES (:id, :task_id, :label_id)',
                        {"id": new_id(), "task_id": task_id, "label_id": label_id},
                    )
            for checklist_order, checklist in enumerate(checklists.get(card.id, [])):
                checklist_id = new_id()
                await execute(
                    db,
                    'INSERT INTO task_checklists (id, name, "taskId", "order") VALUES (:id, :name, :task_id, :order)',
                    {"id": checklist_id, "name": checklist.name, "task_id": task_id, "order": checklist_order},
                )
                for item_order, item in enumerate(checklist.check_items):
                    await execute(
                        db,
                        'INSERT INTO task_checklist_items (id, text, completed, "checklistId", "order") VALUES (:id, :text, :completed, :checklist_id, :order)',
                        {
                            "id": new_id(),
                            "text": item.name,
                            "completed": item.state == "complete",
                            "checklist_id": checklist_id,
                            "order": item_order,
                        },
                    )
            for attachment in card.attachments:
                await execute(
                    db,
                    'INSERT INTO task_attachments (id, name, url, "taskId", "createdAt") VALUES (:id, :name, :url, :task_id, :now)',
                    {
                        "id": new_id(),
                        "name": attachment.name,
                        "url": str(attachment.url),
                        "task_id": task_id,
                        "now": now,
                    },
                )
            for action in comments.get(card.id, []):
                mapped = payload.member_mapping.get(action.member_creator.id) if action.member_creator else None
                author_id = mapped if mapped in project_members else principal.id
                await execute(
                    db,
                    'INSERT INTO task_comments (id, content, "taskId", "userId", "createdAt", "updatedAt") '
                    "VALUES (:id, :content, :task_id, :user_id, :created_at, :created_at)",
                    {
                        "id": new_id(),
                        "content": action.data.text or "",
                        "task_id": task_id,
                        "user_id": author_id,
                        "created_at": safe_date(action.date) or now,
                    },
                )
            tasks_created += 1

        await log_activity(
            db,
            principal,
            type="project_updated",
            message=f'imported Trello board "{trello.name}"',
            entity_type="Project",
            entity_id=project_id,
            metadata={"boardId": board_id, "tasksCreated": tasks_created},
        )
        await db.commit()
        return {
            "data": {
                "boardId": board_id,
                "boardName": trello.name,
                "columnsCreated": len(lists) + (1 if archived_column_id else 0) + (1 if created_done else 0),
                "tasksCreated": tasks_created,
                "labelsCreated": len(unique_labels),
                "completedCount": completed_count,
                "skippedCount": len(skipped),
                "skipped": skipped[:100],
            }
        }
    except HTTPException:
        await db.rollback()
        raise
    except (IntegrityError, DataError, StatementError) as exc:
        await db.rollback()
        detail = "The Trello board could not be imported"
        if created_project_id:
            detail += "; the new project was rolled back"
        raise HTTPException(status_code=400, detail=detail) from exc
    except Exception:
        await db.rollback()
        raise
